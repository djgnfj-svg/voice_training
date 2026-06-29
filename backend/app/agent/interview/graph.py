from __future__ import annotations

import json
import logging
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import tracing
from app.agent.interview import (
    evaluation,
    fit_analysis as fit_analysis_module,
    plan_builder,
    profile_memory,
    questioner,
    resume_memory,
)
from app.agent.interview.state import InterviewState

logger = logging.getLogger(__name__)

# 한 루브릭 항목 안에서의 최대 질문 수(첫 질문 + 1회 dig). OQ-2.
MAX_ITEM_DEPTH = 2
# depth 점수가 이 값 미만이고 아직 dig 여유가 있으면 같은 항목을 한 번 더 판다.
DIG_DEEPER_THRESHOLD = 70
# 근거 없음(gap) 항목을 면접 질문으로 출제할 최대 개수. OQ-3.
MAX_GAP_QUESTIONS = 1


class ToolCallState(TypedDict, total=False):
    messages: Annotated[list[BaseMessage], add_messages]


class SearchProfileArgs(BaseModel):
    query: str = Field(..., min_length=1, max_length=1000)
    top_k: int = Field(default=5, ge=1, le=10)


class SearchResumeArgs(BaseModel):
    resume_id: str = Field(..., min_length=1)
    query: str = Field(..., min_length=1, max_length=1000)
    top_k: int = Field(default=3, ge=1, le=8)


def _trace_meta(state: InterviewState, graph_name: str) -> dict[str, Any]:
    return {
        "feature": "interview",
        "graph_name": graph_name,
        "session_id": state.get("session_id"),
        "user_id": state.get("user_id"),
        "rubric_idx": state.get("current_rubric_idx"),
    }


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


def make_interview_tools(db: AsyncSession, user_id: str):
    @tool("search_profile", args_schema=SearchProfileArgs)
    @tracing.trace_tool("interview.search_profile")
    async def search_profile(query: str, top_k: int = 5) -> str:
        """Search long-term interview profile memory for this user."""
        rows = await profile_memory.search_profile(db, user_id, query, top_k=top_k)
        return _json(rows)

    @tool("search_resume", args_schema=SearchResumeArgs)
    @tracing.trace_tool("interview.search_resume")
    async def search_resume(resume_id: str, query: str, top_k: int = 3) -> str:
        """Search embedded resume chunks for this user."""
        rows = await resume_memory.search_resume(
            db, user_id, resume_id, query, top_k=top_k
        )
        return _json(rows)

    return [search_profile, search_resume]


async def _call_tool(
    db: AsyncSession,
    user_id: str,
    name: str,
    args: dict[str, Any],
) -> list[dict]:
    node = ToolNode(make_interview_tools(db, user_id))
    result = await node.ainvoke(
        {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[{"id": f"call_{name}", "name": name, "args": args}],
                )
            ]
        }
    )
    content = result["messages"][-1].content
    try:
        parsed = json.loads(content or "[]")
    except json.JSONDecodeError:
        logger.warning("Tool %s returned non-json content", name)
        return []
    return parsed if isinstance(parsed, list) else []


async def _search_resume_chunks(
    state: InterviewState,
    db: AsyncSession,
    query: str,
    top_k: int = 3,
) -> list[dict]:
    rid = state.get("resume_id")
    if not state.get("has_resume_embeddings") or not rid:
        return []
    try:
        return await _call_tool(
            db,
            state["user_id"],
            "search_resume",
            {"resume_id": rid, "query": query, "top_k": top_k},
        )
    except Exception:
        logger.exception("search_resume tool failed")
        return []


def _format_question_event(
    *,
    question: str,
    question_count: int,
    follow_up_round: int,
    phase: str,
    phase_label: str,
    result: dict,
) -> dict:
    return {
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "followUpRound": follow_up_round,
            "phase": phase,
            "phaseLabel": phase_label,
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    }


def _depth_score(evaluation_result: dict) -> int:
    scores = (evaluation_result or {}).get("scores") or {}
    try:
        return int(scores.get("depth", 50))
    except (TypeError, ValueError):
        return 50


def _coverage_from_plan(rubric_plan: list[dict]) -> list[dict]:
    return [
        {
            "id": it.get("id"),
            "label": it.get("label"),
            "importance": it.get("importance"),
            "has_evidence": it.get("has_evidence"),
            "status": "pending",
            "depth_score": None,
        }
        for it in rubric_plan
    ]


def _select_next_rubric_item(coverage: list[dict]) -> int | None:
    """다음에 질문할 pending 항목 인덱스. gap 항목은 MAX_GAP_QUESTIONS개까지만,
    초과분은 'unverified'로 표기하고 건너뛴다(리포트 미검증 표기용).

    Side-effect: 예산 초과 gap 항목의 status를 coverage 리스트에서 'unverified'로
    in-place 수정한다(호출자에게 별도 반환 없이 coverage가 변경됨).

    gap_asked는 'covered'(답변 완료)뿐 아니라 'unverified'(/skip 또는 예산 초과)도
    포함해 센다. /skip이 gap을 'unverified'로 표기하므로, 이를 빼면 gap-cap이
    우회되어 다음 gap이 추가 출제된다(OQ-3 위반)."""
    gap_asked = sum(
        1
        for c in coverage
        if not c.get("has_evidence") and c.get("status") in ("covered", "unverified")
    )
    for i, c in enumerate(coverage):
        if c.get("status") != "pending":
            continue
        if not c.get("has_evidence"):
            if gap_asked >= MAX_GAP_QUESTIONS:
                c["status"] = "unverified"
                continue
        return i
    return None


async def load_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    profile = await profile_memory.load_user_profile(
        db,
        state["user_id"],
        state["resume"],
        state.get("job_posting"),
    )
    return {
        **state,
        "user_profile": profile,
        "pending_events": state.get("pending_events", [])
        + [
            {"event": "status", "data": {"phase": "profile_loaded"}},
        ],
    }


async def fit_analysis(state: InterviewState, db: AsyncSession) -> InterviewState:
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "fit_analyzing"}})

    fa = await fit_analysis_module.run_fit_analysis(
        state["resume"], state.get("job_posting")
    )
    has_emb = False
    rid = state.get("resume_id")
    if rid:
        has_emb = await resume_memory.has_resume_embeddings(db, rid)

    events.append(
        {
            "event": "status",
            "data": {"phase": "fit_analyzed", "has_resume_embeddings": has_emb},
        }
    )
    return {
        **state,
        "fit_analysis": fa,
        "has_resume_embeddings": has_emb,
        "current_resume_chunks": [],
        "pending_events": events,
    }


async def build_rubric_plan(state: InterviewState, db: AsyncSession) -> InterviewState:
    rubric_plan, source = await plan_builder.build_rubric_plan(
        state["resume"],
        state.get("job_posting"),
        state.get("fit_analysis") or {},
    )
    coverage = _coverage_from_plan(rubric_plan)

    # 질문 예산: 출제 가능 항목(evidence 전부 + gap 최대 1)당 최대 2질문, 상한 max_questions.
    askable = sum(1 for c in coverage if c["has_evidence"]) + min(
        MAX_GAP_QUESTIONS, sum(1 for c in coverage if not c["has_evidence"])
    )
    hard_cap = state.get("max_questions", 9)
    max_q = (
        max(askable, min(hard_cap, askable * MAX_ITEM_DEPTH)) if askable else hard_cap
    )

    events = list(state.get("pending_events", []))
    events.append(
        {
            "event": "status",
            "data": {
                "phase": "rubric_plan_ready",
                "rubric_count": len(rubric_plan),
                "max_questions": max_q,
                "rubric_plan_source": source,
            },
        }
    )
    return {
        **state,
        "rubric_plan": rubric_plan,
        "coverage": coverage,
        "current_rubric_idx": 0,
        "current_item_depth": 0,
        "max_questions": max_q,
        "pending_events": events,
    }


async def rubric_ask(state: InterviewState, db: AsyncSession) -> InterviewState:
    events = list(state.get("pending_events", []))
    rubric_plan = state.get("rubric_plan", [])
    idx = state.get("current_rubric_idx", 0)
    depth = state.get("current_item_depth", 0)
    if idx >= len(rubric_plan):
        logger.warning("rubric_ask called with exhausted rubric_plan")
        return state

    item = rubric_plan[idx]
    events.append({"event": "status", "data": {"phase": "generating_question"}})
    chunks = await _search_resume_chunks(state, db, item["query"], top_k=3)
    if depth == 0:
        result = await questioner.generate_rubric_question(
            resume=state["resume"],
            job_posting=state.get("job_posting"),
            user_profile=state.get("user_profile", {}),
            conversation_history=state.get("conversation_history", []),
            rubric_item=item,
            item_idx=idx,
            total_items=len(rubric_plan),
            resume_chunks=chunks,
            avoid_topics=(state.get("fit_analysis") or {}).get("avoid_topics") or [],
        )
    else:
        result = await questioner.generate_dig_deeper(
            state.get("conversation_history", []),
            state.get("current_evaluation", {}),
        )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1
    has_evidence = bool(item.get("has_evidence"))
    phase = "evidence" if has_evidence else "gap"
    phase_label = f"JD 항목 {idx + 1}/{len(rubric_plan)} · {item['label']}"
    if not has_evidence:
        phase_label += " (미검증 영역)"
    events.append(
        _format_question_event(
            question=question,
            question_count=question_count,
            follow_up_round=depth,
            phase=phase,
            phase_label=phase_label,
            result=result,
        )
    )
    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
        "current_item_depth": depth + 1,
        "pending_events": events,
    }


async def evaluate_answer(state: InterviewState, db: AsyncSession) -> InterviewState:
    events = list(state.get("pending_events", []))
    actions = list(state.get("actions_taken", []))
    actions.append("evaluate")
    events.append({"event": "status", "data": {"phase": "evaluating"}})

    answer_evaluation = await evaluation.evaluate_answer(
        state["current_question"],
        state["current_answer"],
        state.get("user_profile", {}),
        state.get("conversation_history", []),
    )

    rubric_plan = state.get("rubric_plan") or []
    idx = state.get("current_rubric_idx", 0)
    meta: dict[str, Any] = {}
    if 0 <= idx < len(rubric_plan):
        item = rubric_plan[idx]
        meta = {
            "rubricId": item.get("id"),
            "rubricLabel": item.get("label"),
            "hasEvidence": bool(item.get("has_evidence")),
            "importance": item.get("importance"),
            "itemDepth": state.get("current_item_depth", 0),
        }
    answer_evaluation["meta"] = meta

    history = list(state.get("conversation_history", []))
    history.append(
        {
            "question": state["current_question"],
            "answer": state["current_answer"],
            "evaluation": answer_evaluation,
            "question_number": state.get("question_count", 1),
        }
    )
    events.append(
        {
            "event": "evaluation",
            "data": {
                "overallScore": answer_evaluation.get("overallScore", 0),
                "briefFeedback": answer_evaluation.get("briefFeedback", ""),
                "detailedFeedback": answer_evaluation.get("detailedFeedback", ""),
                "modelAnswer": answer_evaluation.get("modelAnswer", ""),
                "scores": answer_evaluation.get("scores", {}),
                "innerThought": answer_evaluation.get("innerThought", ""),
            },
        }
    )
    return {
        **state,
        "current_evaluation": answer_evaluation,
        "conversation_history": history,
        "actions_taken": actions,
        "pending_events": events,
    }


async def coverage_next(state: InterviewState, db: AsyncSession) -> InterviewState:
    """현재 항목 커버리지 기록 후 dig_deeper / 다음 미커버 항목 / 종료를 결정."""
    coverage = [dict(c) for c in state.get("coverage", [])]
    idx = state.get("current_rubric_idx", 0)
    item_depth = state.get("current_item_depth", 0)
    depth_score = _depth_score(state.get("current_evaluation") or {})

    if 0 <= idx < len(coverage):
        cov = coverage[idx]
        cov["status"] = "covered"
        prev = cov.get("depth_score")
        cov["depth_score"] = (
            max(prev, depth_score) if isinstance(prev, int) else depth_score
        )

    # 같은 항목 한 번 더 파기 (depth 부족 + dig 여유)
    if depth_score < DIG_DEEPER_THRESHOLD and item_depth < MAX_ITEM_DEPTH:
        return {**state, "coverage": coverage, "next_action": "rubric_ask"}

    next_idx = _select_next_rubric_item(coverage)
    if next_idx is None:
        return {**state, "coverage": coverage, "next_action": "end"}
    return {
        **state,
        "coverage": coverage,
        "current_rubric_idx": next_idx,
        "current_item_depth": 0,
        "next_action": "rubric_ask",
    }


def enforce_question_cap(state: InterviewState) -> InterviewState:
    if state.get("question_count", 0) >= state.get("max_questions", 9):
        return {**state, "next_action": "end"}
    return state


async def update_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "updating_profile"}})
    await profile_memory.save_session_insights(
        db,
        state["user_id"],
        state.get("conversation_history", []),
        state["session_id"],
    )
    return {**state, "pending_events": events}


async def generate_report(state: InterviewState, db: AsyncSession) -> InterviewState:
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_report"}})
    report = await evaluation.generate_report(
        state.get("conversation_history", []),
        state.get("user_profile", {}),
    )
    events.append({"event": "complete", "data": {"report": report}})
    return {**state, "overall_report": report, "pending_events": events}


def _route_action(state: InterviewState) -> str:
    return "rubric_ask" if state.get("next_action") == "rubric_ask" else "end"


def build_start_graph(db: AsyncSession):
    graph = StateGraph(InterviewState)

    async def load_profile_node(state: InterviewState) -> InterviewState:
        return await load_profile(state, db)

    async def fit_analysis_node(state: InterviewState) -> InterviewState:
        return await fit_analysis(state, db)

    async def build_rubric_plan_node(state: InterviewState) -> InterviewState:
        return await build_rubric_plan(state, db)

    async def rubric_ask_node(state: InterviewState) -> InterviewState:
        return await rubric_ask(state, db)

    graph.add_node("load_profile", load_profile_node)
    graph.add_node("fit_analysis", fit_analysis_node)
    graph.add_node("build_rubric_plan", build_rubric_plan_node)
    graph.add_node("rubric_ask", rubric_ask_node)
    graph.set_entry_point("load_profile")
    graph.add_edge("load_profile", "fit_analysis")
    graph.add_edge("fit_analysis", "build_rubric_plan")
    graph.add_edge("build_rubric_plan", "rubric_ask")
    graph.add_edge("rubric_ask", END)
    return graph.compile()


def build_answer_graph(db: AsyncSession):
    graph = StateGraph(InterviewState)

    async def evaluate_node(state: InterviewState) -> InterviewState:
        if state.get("current_evaluation"):
            return state
        return await evaluate_answer(state, db)

    async def coverage_next_node(state: InterviewState) -> InterviewState:
        return await coverage_next(state, db)

    async def rubric_ask_node(state: InterviewState) -> InterviewState:
        return await rubric_ask(state, db)

    async def update_profile_node(state: InterviewState) -> InterviewState:
        return await update_profile(state, db)

    async def generate_report_node(state: InterviewState) -> InterviewState:
        return await generate_report(state, db)

    graph.add_node("evaluate", evaluate_node)
    graph.add_node("coverage_next", coverage_next_node)
    graph.add_node("enforce_question_cap", enforce_question_cap)
    graph.add_node("rubric_ask", rubric_ask_node)
    graph.add_node("update_profile", update_profile_node)
    graph.add_node("generate_report", generate_report_node)
    graph.set_entry_point("evaluate")
    graph.add_edge("evaluate", "coverage_next")
    graph.add_edge("coverage_next", "enforce_question_cap")
    graph.add_conditional_edges(
        "enforce_question_cap",
        _route_action,
        {
            "rubric_ask": "rubric_ask",
            "end": "update_profile",
        },
    )
    graph.add_edge("rubric_ask", END)
    graph.add_edge("update_profile", "generate_report")
    graph.add_edge("generate_report", END)
    return graph.compile()


def build_tool_calling_graph(db: AsyncSession, user_id: str):
    graph = StateGraph(ToolCallState)
    graph.add_node("tools", ToolNode(make_interview_tools(db, user_id)))
    graph.set_entry_point("tools")
    graph.add_edge("tools", END)
    return graph.compile()


def build_end_graph(db: AsyncSession):
    graph = StateGraph(InterviewState)

    async def update_profile_node(state: InterviewState) -> InterviewState:
        return await update_profile(state, db)

    async def generate_report_node(state: InterviewState) -> InterviewState:
        return await generate_report(state, db)

    graph.add_node("update_profile", update_profile_node)
    graph.add_node("generate_report", generate_report_node)
    graph.set_entry_point("update_profile")
    graph.add_edge("update_profile", "generate_report")
    graph.add_edge("generate_report", END)
    return graph.compile()


def build_rubric_ask_graph(db: AsyncSession):
    """단일 rubric_ask — skip 흐름에서 다음 질문 생성용."""
    graph = StateGraph(InterviewState)

    async def rubric_ask_node(state: InterviewState) -> InterviewState:
        return await rubric_ask(state, db)

    graph.add_node("rubric_ask", rubric_ask_node)
    graph.set_entry_point("rubric_ask")
    graph.add_edge("rubric_ask", END)
    return graph.compile()


async def _run_graph(graph_name: str, state: InterviewState, graph_call):
    result, run_id = await tracing.traced_graph_call(
        name=f"interview.{graph_name}",
        metadata=_trace_meta(state, graph_name),
        call=graph_call,
    )
    if run_id:
        result["langsmith_run_id"] = run_id
    return result


async def run_start_graph(state: InterviewState, db: AsyncSession) -> InterviewState:
    return await _run_graph(
        "start", state, lambda: build_start_graph(db).ainvoke(state)
    )


async def run_answer_graph(state: InterviewState, db: AsyncSession) -> InterviewState:
    return await _run_graph(
        "answer", state, lambda: build_answer_graph(db).ainvoke(state)
    )


async def run_end_graph(state: InterviewState, db: AsyncSession) -> InterviewState:
    return await _run_graph("end", state, lambda: build_end_graph(db).ainvoke(state))


async def run_rubric_ask_graph(
    state: InterviewState, db: AsyncSession
) -> InterviewState:
    return await _run_graph(
        "rubric_ask", state, lambda: build_rubric_ask_graph(db).ainvoke(state)
    )


async def run_tool_calling_graph(
    state: ToolCallState, db: AsyncSession, user_id: str
) -> ToolCallState:
    result, run_id = await tracing.traced_graph_call(
        name="interview.tools",
        metadata={"feature": "interview", "graph_name": "tools", "user_id": user_id},
        call=lambda: build_tool_calling_graph(db, user_id).ainvoke(state),
    )
    if run_id:
        result["langsmith_run_id"] = run_id
    return result
