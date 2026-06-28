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

MAX_DIVE_DEPTH = 3


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
        "phase": state.get("phase"),
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


async def build_scan_plan(state: InterviewState, db: AsyncSession) -> InterviewState:
    scan_plan, source = await plan_builder.build_scan_plan_hybrid(
        state["resume"], state.get("fit_analysis") or {}
    )
    events = list(state.get("pending_events", []))
    max_q = min(state.get("max_questions", 9), len(scan_plan) + 6)
    events.append(
        {
            "event": "status",
            "data": {
                "phase": "scan_plan_ready",
                "scan_count": len(scan_plan),
                "max_questions": max_q,
                "scan_plan_source": source,
            },
        }
    )
    return {
        **state,
        "phase": "scan",
        "scan_plan": scan_plan,
        "scan_evaluations": [],
        "current_scan_idx": 0,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
        "pending_events": events,
    }


async def scan_ask(state: InterviewState, db: AsyncSession) -> InterviewState:
    events = list(state.get("pending_events", []))
    scan_plan = state.get("scan_plan", [])
    idx = state.get("current_scan_idx", 0)
    if idx >= len(scan_plan):
        logger.warning("scan_ask called with exhausted scan_plan")
        return state

    scan_item = scan_plan[idx]
    events.append(
        {
            "event": "status",
            "data": {"phase": "generating_question", "phaseKind": "scan"},
        }
    )
    chunks = await _search_resume_chunks(state, db, scan_item["query"], top_k=3)
    result = await questioner.generate_scan_question(
        resume=state["resume"],
        job_posting=state.get("job_posting"),
        user_profile=state.get("user_profile", {}),
        conversation_history=state.get("conversation_history", []),
        scan_item=scan_item,
        scan_idx=idx,
        total_scans=len(scan_plan),
        resume_chunks=chunks,
        avoid_topics=(state.get("fit_analysis") or {}).get("avoid_topics") or [],
    )
    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1
    events.append(
        _format_question_event(
            question=question,
            question_count=question_count,
            follow_up_round=0,
            phase="scan",
            phase_label=f"훑기 {idx + 1}/{len(scan_plan)} · {scan_item['project_ref']}",
            result=result,
        )
    )
    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
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

    phase = state.get("phase", "scan")
    meta: dict[str, Any] = {"phase": phase}
    if phase == "scan":
        scan_idx = state.get("current_scan_idx", 0)
        scan_plan = state.get("scan_plan") or []
        if 0 <= scan_idx < len(scan_plan):
            meta["scanIdx"] = scan_idx
            meta["projectRef"] = scan_plan[scan_idx].get("project_ref", "")
    elif phase == "dive":
        dive_idx = state.get("current_dive_idx", 0)
        dive_plan = state.get("dive_plan") or []
        if 0 <= dive_idx < len(dive_plan):
            topic = dive_plan[dive_idx]
            meta.update(
                {
                    "diveIdx": dive_idx,
                    "topicLabel": topic.get("topic", ""),
                    "angle": topic.get("angle", ""),
                    "projectRef": topic.get("project_ref", ""),
                    "diveDepth": state.get("current_dive_depth", 0),
                }
            )
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


async def scan_next(state: InterviewState, db: AsyncSession) -> InterviewState:
    scan_evals = list(state.get("scan_evaluations", []))
    scan_evals.append(state.get("current_evaluation") or {})
    new_scan_idx = state.get("current_scan_idx", 0) + 1
    action = (
        "build_dive_plan"
        if new_scan_idx >= len(state.get("scan_plan", []))
        else "scan_ask"
    )
    return {
        **state,
        "scan_evaluations": scan_evals,
        "current_scan_idx": new_scan_idx,
        "next_action": action,
    }


async def build_dive_plan(state: InterviewState, db: AsyncSession) -> InterviewState:
    dive_plan = plan_builder.build_dive_plan(
        state.get("scan_plan", []),
        state.get("scan_evaluations", []),
        state.get("fit_analysis") or {},
    )
    events = list(state.get("pending_events", []))
    events.append(
        {
            "event": "status",
            "data": {
                "phase": "dive_plan_ready",
                "dive_topics": [
                    {
                        "topic": t["topic"],
                        "angle": t["angle"],
                        "project_ref": t["project_ref"],
                    }
                    for t in dive_plan
                ],
            },
        }
    )
    return {
        **state,
        "phase": "dive",
        "dive_plan": dive_plan,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
        "pending_events": events,
    }


async def dive_ask(state: InterviewState, db: AsyncSession) -> InterviewState:
    events = list(state.get("pending_events", []))
    dive_plan = state.get("dive_plan", [])
    idx = state.get("current_dive_idx", 0)
    depth = state.get("current_dive_depth", 0)
    if idx >= len(dive_plan):
        logger.warning("dive_ask called with exhausted dive_plan")
        return state

    topic = dive_plan[idx]
    events.append(
        {
            "event": "status",
            "data": {"phase": "generating_question", "phaseKind": "dive"},
        }
    )
    chunks = await _search_resume_chunks(state, db, topic["query"], top_k=3)
    if depth == 0:
        result = await questioner.generate_dive_question(
            resume=state["resume"],
            job_posting=state.get("job_posting"),
            user_profile=state.get("user_profile", {}),
            conversation_history=state.get("conversation_history", []),
            dive_topic=topic,
            current_depth=depth,
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
    new_depth = depth + 1
    events.append(
        _format_question_event(
            question=question,
            question_count=question_count,
            follow_up_round=depth,
            phase="dive",
            phase_label=f"딥다이브 · {topic['topic']} ({new_depth}/{MAX_DIVE_DEPTH})",
            result=result,
        )
    )
    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
        "current_dive_depth": new_depth,
        "pending_events": events,
    }


async def decide_in_topic(state: InterviewState, db: AsyncSession) -> InterviewState:
    dive_plan = state.get("dive_plan", [])
    dive_idx = state.get("current_dive_idx", 0)
    depth = state.get("current_dive_depth", 0)
    if dive_idx >= len(dive_plan):
        return {**state, "next_action": "end"}

    topic = dive_plan[dive_idx]
    result = await questioner.decide_in_topic(
        project_ref=topic["project_ref"],
        angle=topic["angle"],
        current_depth=depth,
        last_evaluation=state.get("current_evaluation") or {},
        remaining_topics=len(dive_plan) - dive_idx,
    )
    action = result.get("action", "next_topic")
    if depth >= MAX_DIVE_DEPTH:
        action = "next_topic"
    if action == "next_topic" and dive_idx + 1 >= len(dive_plan):
        action = "end"
    if action == "end" and dive_idx + 1 < len(dive_plan):
        action = "next_topic"

    if action == "next_topic":
        return {
            **state,
            "next_action": "dive_ask",
            "current_dive_idx": dive_idx + 1,
            "current_dive_depth": 0,
        }
    if action == "dig_deeper":
        return {**state, "next_action": "dive_ask"}
    return {**state, "next_action": "end", "phase": "done"}


def enforce_question_cap(state: InterviewState) -> InterviewState:
    if state.get("question_count", 0) >= state.get("max_questions", 9):
        return {**state, "next_action": "end", "phase": "done"}
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


def _route_phase(state: InterviewState) -> str:
    phase = state.get("phase", "scan")
    if phase == "scan":
        return "scan_next"
    if phase == "dive":
        return "decide_in_topic"
    return "end"


def _route_action(state: InterviewState) -> str:
    action = state.get("next_action", "end")
    if action in {"scan_ask", "build_dive_plan", "dive_ask"}:
        return action
    return "end"


def _route_next_question(state: InterviewState) -> str:
    action = state.get("next_action")
    if action == "build_dive_plan":
        return "build_dive_plan"
    if action == "dive_ask":
        return "dive_ask"
    return "scan_ask"


def build_start_graph(db: AsyncSession):
    graph = StateGraph(InterviewState)

    async def load_profile_node(state: InterviewState) -> InterviewState:
        return await load_profile(state, db)

    async def fit_analysis_node(state: InterviewState) -> InterviewState:
        return await fit_analysis(state, db)

    async def build_scan_plan_node(state: InterviewState) -> InterviewState:
        return await build_scan_plan(state, db)

    async def scan_ask_node(state: InterviewState) -> InterviewState:
        return await scan_ask(state, db)

    graph.add_node("load_profile", load_profile_node)
    graph.add_node("fit_analysis", fit_analysis_node)
    graph.add_node("build_scan_plan", build_scan_plan_node)
    graph.add_node("scan_ask", scan_ask_node)
    graph.set_entry_point("load_profile")
    graph.add_edge("load_profile", "fit_analysis")
    graph.add_edge("fit_analysis", "build_scan_plan")
    graph.add_edge("build_scan_plan", "scan_ask")
    graph.add_edge("scan_ask", END)
    return graph.compile()


def build_answer_graph(db: AsyncSession):
    graph = StateGraph(InterviewState)

    async def evaluate_node(state: InterviewState) -> InterviewState:
        if state.get("current_evaluation"):
            return state
        return await evaluate_answer(state, db)

    async def scan_next_node(state: InterviewState) -> InterviewState:
        return await scan_next(state, db)

    async def decide_in_topic_node(state: InterviewState) -> InterviewState:
        return await decide_in_topic(state, db)

    async def scan_ask_node(state: InterviewState) -> InterviewState:
        return await scan_ask(state, db)

    async def build_dive_plan_node(state: InterviewState) -> InterviewState:
        return await build_dive_plan(state, db)

    async def dive_ask_node(state: InterviewState) -> InterviewState:
        return await dive_ask(state, db)

    async def update_profile_node(state: InterviewState) -> InterviewState:
        return await update_profile(state, db)

    async def generate_report_node(state: InterviewState) -> InterviewState:
        return await generate_report(state, db)

    graph.add_node("evaluate", evaluate_node)
    graph.add_node("scan_next", scan_next_node)
    graph.add_node("decide_in_topic", decide_in_topic_node)
    graph.add_node("enforce_question_cap", enforce_question_cap)
    graph.add_node("scan_ask", scan_ask_node)
    graph.add_node("build_dive_plan", build_dive_plan_node)
    graph.add_node("dive_ask", dive_ask_node)
    graph.add_node("update_profile", update_profile_node)
    graph.add_node("generate_report", generate_report_node)
    graph.set_entry_point("evaluate")
    graph.add_conditional_edges(
        "evaluate",
        _route_phase,
        {
            "scan_next": "scan_next",
            "decide_in_topic": "decide_in_topic",
            "end": "update_profile",
        },
    )
    graph.add_edge("scan_next", "enforce_question_cap")
    graph.add_edge("decide_in_topic", "enforce_question_cap")
    graph.add_conditional_edges(
        "enforce_question_cap",
        _route_action,
        {
            "scan_ask": "scan_ask",
            "build_dive_plan": "build_dive_plan",
            "dive_ask": "dive_ask",
            "end": "update_profile",
        },
    )
    graph.add_edge("build_dive_plan", "dive_ask")
    graph.add_edge("scan_ask", END)
    graph.add_edge("dive_ask", END)
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


def build_scan_plan_graph(db: AsyncSession):
    graph = StateGraph(InterviewState)

    async def build_scan_plan_node(state: InterviewState) -> InterviewState:
        return await build_scan_plan(state, db)

    graph.add_node("build_scan_plan", build_scan_plan_node)
    graph.set_entry_point("build_scan_plan")
    graph.add_edge("build_scan_plan", END)
    return graph.compile()


def build_next_question_graph(db: AsyncSession):
    graph = StateGraph(InterviewState)

    async def build_dive_plan_node(state: InterviewState) -> InterviewState:
        return await build_dive_plan(state, db)

    async def scan_ask_node(state: InterviewState) -> InterviewState:
        return await scan_ask(state, db)

    async def dive_ask_node(state: InterviewState) -> InterviewState:
        return await dive_ask(state, db)

    graph.add_node("build_dive_plan", build_dive_plan_node)
    graph.add_node("scan_ask", scan_ask_node)
    graph.add_node("dive_ask", dive_ask_node)
    graph.set_conditional_entry_point(
        _route_next_question,
        {
            "build_dive_plan": "build_dive_plan",
            "scan_ask": "scan_ask",
            "dive_ask": "dive_ask",
        },
    )
    graph.add_edge("build_dive_plan", "dive_ask")
    graph.add_edge("scan_ask", END)
    graph.add_edge("dive_ask", END)
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


async def run_scan_plan_graph(
    state: InterviewState, db: AsyncSession
) -> InterviewState:
    return await _run_graph(
        "scan_plan", state, lambda: build_scan_plan_graph(db).ainvoke(state)
    )


async def run_next_question_graph(
    state: InterviewState, db: AsyncSession
) -> InterviewState:
    return await _run_graph(
        "next_question", state, lambda: build_next_question_graph(db).ainvoke(state)
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
