# backend/app/agent/nodes.py
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.state import InterviewState
from app.agent import profile_agent, interviewer_agent, evaluator_agent, resume_rag, fit_analyzer, planner

logger = logging.getLogger(__name__)

MAX_ACTIONS = 3
MAX_DIVE_DEPTH = 3


# ── 답변 처리 루프 ──────────────────────────────────────────

async def agent_loop(state: InterviewState, db: AsyncSession) -> InterviewState:
    """답변 처리 루프: 평가 → 페이즈별 결정 → 다음 질문 생성 또는 종료."""
    state = {
        **state,
        "loop_count": 0,
        "actions_taken": list(state.get("actions_taken", [])),
        "profile_context": list(state.get("profile_context", [])),
    }

    # 1) 평가
    if not state.get("current_evaluation"):
        state = await evaluate_answer(state, db)

    # 2) 페이즈별 결정
    phase = state.get("phase", "scan")
    if phase == "scan":
        state = await scan_next(state, db)
    elif phase == "dive":
        state = await decide_in_topic_node(state, db)
    else:
        state = {**state, "next_action": "end"}

    # 안전 게이트: 상한(무료체험 3/일반 9) 도달 시 강제 종료
    if state.get("question_count", 0) >= state.get("max_questions", 9):
        state = {**state, "next_action": "end", "phase": "done"}

    # 3) 다음 액션 실행
    next_action = state.get("next_action", "end")
    if next_action == "scan_ask":
        state = await scan_ask(state, db)
    elif next_action == "build_dive_plan":
        state = await build_dive_plan_node(state, db)
        state = await dive_ask(state, db)
    elif next_action == "dive_ask":
        state = await dive_ask(state, db)
    elif next_action == "end":
        state = await update_profile(state, db)
        state = await generate_report(state, db)

    return state


async def search_profile_node(
    state: InterviewState, db: AsyncSession, query: str
) -> InterviewState:
    """Search user profile via RAG for additional context on the answer."""
    events = list(state.get("pending_events", []))
    actions = list(state.get("actions_taken", []))
    actions.append("search_profile")

    search_query = query or state.get("current_answer", "")
    results = await profile_agent.search_profile(db, state["user_id"], search_query, top_k=5)

    if results:
        events.append({
            "event": "status",
            "data": {"phase": "profile_context_found", "count": len(results)},
        })

    return {
        **state,
        "profile_context": results,
        "actions_taken": actions,
        "pending_events": events,
    }


# ── 초기 세팅 노드 ──────────────────────────────────────────


async def load_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Load user profile from RAG."""
    profile = await profile_agent.load_user_profile(
        db,
        state["user_id"],
        state["resume"],
        state.get("job_posting"),
    )
    return {
        **state,
        "user_profile": profile,
        "pending_events": state.get("pending_events", []) + [
            {"event": "status", "data": {"phase": "profile_loaded"}},
        ],
    }


async def fit_analysis_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """이력서↔JD Fit Analysis. 면접 시작 시 1회 호출."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "fit_analyzing"}})

    fa = await fit_analyzer.run_fit_analysis(state["resume"], state.get("job_posting"))

    has_emb = False
    rid = state.get("resume_id")
    if rid:
        has_emb = await resume_rag.has_resume_embeddings(db, rid)

    events.append({
        "event": "status",
        "data": {
            "phase": "fit_analyzed",
            "has_resume_embeddings": has_emb,
        },
    })

    return {
        **state,
        "fit_analysis": fa,
        "has_resume_embeddings": has_emb,
        "current_resume_chunks": [],
        "pending_events": events,
    }


# ── Scan 페이즈 ─────────────────────────────────────────────


async def build_scan_plan_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """훑기 플랜 확정. fit_analysis_node 직후 호출."""
    scan_plan = planner.build_scan_plan(state["resume"], state.get("fit_analysis") or {})
    events = list(state.get("pending_events", []))
    # 총 질문 상한: 세션 cap(무료체험 3/일반 9)과 plan 기반 상한(len(scan)+6) 중 작은 값
    cap = state.get("max_questions", 9)
    max_q = min(cap, len(scan_plan) + 6)
    events.append({
        "event": "status",
        "data": {
            "phase": "scan_plan_ready",
            "scan_count": len(scan_plan),
            "max_questions": max_q,
        },
    })
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
    """훑기 페이즈 질문 생성."""
    events = list(state.get("pending_events", []))
    scan_plan = state.get("scan_plan", [])
    idx = state.get("current_scan_idx", 0)

    if idx >= len(scan_plan):
        logger.warning("scan_ask called with exhausted scan_plan")
        return state

    scan_item = scan_plan[idx]
    events.append({"event": "status", "data": {"phase": "generating_question", "phaseKind": "scan"}})

    chunks: list[dict] = []
    has_emb = state.get("has_resume_embeddings", False)
    rid = state.get("resume_id")
    if has_emb and rid:
        try:
            chunks = await resume_rag.search_resume(db, state["user_id"], rid, scan_item["query"], top_k=3)
        except Exception:
            logger.exception("search_resume failed in scan_ask")
            chunks = []

    avoid_topics = (state.get("fit_analysis") or {}).get("avoid_topics") or []

    result = await interviewer_agent.generate_scan_question(
        resume=state["resume"],
        job_posting=state.get("job_posting"),
        user_profile=state.get("user_profile", {}),
        conversation_history=state.get("conversation_history", []),
        scan_item=scan_item,
        scan_idx=idx,
        total_scans=len(scan_plan),
        resume_chunks=chunks,
        avoid_topics=avoid_topics,
    )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "phase": "scan",
            "phaseLabel": f"훑기 {idx + 1}/{len(scan_plan)} · {scan_item['project_ref']}",
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    })

    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
        "pending_events": events,
    }


async def scan_next(state: InterviewState, db: AsyncSession) -> InterviewState:
    """훑기 페이즈에서 답변 평가 후: 다음 scan or dive 전환."""
    scan_evals = list(state.get("scan_evaluations", []))
    scan_evals.append(state.get("current_evaluation") or {})

    scan_plan = state.get("scan_plan", [])
    new_scan_idx = state.get("current_scan_idx", 0) + 1

    if new_scan_idx >= len(scan_plan):
        return {
            **state,
            "scan_evaluations": scan_evals,
            "current_scan_idx": new_scan_idx,
            "next_action": "build_dive_plan",
        }
    else:
        return {
            **state,
            "scan_evaluations": scan_evals,
            "current_scan_idx": new_scan_idx,
            "next_action": "scan_ask",
        }


# ── Dive 페이즈 ─────────────────────────────────────────────


async def build_dive_plan_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """딥다이브 플랜 확정. 훑기 3답변 끝난 직후 호출."""
    dive_plan = planner.build_dive_plan(
        state.get("scan_plan", []),
        state.get("scan_evaluations", []),
        state.get("fit_analysis") or {},
    )
    events = list(state.get("pending_events", []))
    events.append({
        "event": "status",
        "data": {
            "phase": "dive_plan_ready",
            "dive_topics": [
                {"topic": t["topic"], "angle": t["angle"], "project_ref": t["project_ref"]}
                for t in dive_plan
            ],
        },
    })
    return {
        **state,
        "phase": "dive",
        "dive_plan": dive_plan,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
        "pending_events": events,
    }


async def dive_ask(state: InterviewState, db: AsyncSession) -> InterviewState:
    """딥다이브 페이즈 질문 생성."""
    events = list(state.get("pending_events", []))
    dive_plan = state.get("dive_plan", [])
    idx = state.get("current_dive_idx", 0)
    depth = state.get("current_dive_depth", 0)

    if idx >= len(dive_plan):
        logger.warning("dive_ask called with exhausted dive_plan")
        return state

    topic = dive_plan[idx]
    events.append({"event": "status", "data": {"phase": "generating_question", "phaseKind": "dive"}})

    chunks: list[dict] = []
    has_emb = state.get("has_resume_embeddings", False)
    rid = state.get("resume_id")
    if has_emb and rid:
        try:
            chunks = await resume_rag.search_resume(db, state["user_id"], rid, topic["query"], top_k=3)
        except Exception:
            logger.exception("search_resume failed in dive_ask")
            chunks = []

    avoid_topics = (state.get("fit_analysis") or {}).get("avoid_topics") or []

    if depth == 0:
        result = await interviewer_agent.generate_dive_question(
            resume=state["resume"],
            job_posting=state.get("job_posting"),
            user_profile=state.get("user_profile", {}),
            conversation_history=state.get("conversation_history", []),
            dive_topic=topic,
            current_depth=depth,
            resume_chunks=chunks,
            avoid_topics=avoid_topics,
        )
    else:
        result = await interviewer_agent.generate_dig_deeper(
            state.get("conversation_history", []),
            state.get("current_evaluation", {}),
        )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1
    new_depth = depth + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "phase": "dive",
            "phaseLabel": f"딥다이브 · {topic['topic']} ({new_depth}/{MAX_DIVE_DEPTH})",
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    })

    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
        "current_dive_depth": new_depth,
        "pending_events": events,
    }


async def decide_in_topic_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """딥다이브 중 결정: dig_deeper / next_topic / end."""
    dive_plan = state.get("dive_plan", [])
    dive_idx = state.get("current_dive_idx", 0)
    depth = state.get("current_dive_depth", 0)

    if dive_idx >= len(dive_plan):
        return {**state, "next_action": "end"}

    topic = dive_plan[dive_idx]
    remaining = len(dive_plan) - dive_idx

    result = await interviewer_agent.decide_in_topic(
        project_ref=topic["project_ref"],
        angle=topic["angle"],
        current_depth=depth,
        last_evaluation=state.get("current_evaluation") or {},
        remaining_topics=remaining,
    )
    action = result.get("action", "next_topic")

    # 한계치 강제
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
    elif action == "dig_deeper":
        return {**state, "next_action": "dive_ask"}
    else:
        return {**state, "next_action": "end", "phase": "done"}


# ── 평가 / 프로필 업데이트 / 리포트 ─────────────────────────


async def evaluate_answer(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Evaluate user's answer."""
    events = list(state.get("pending_events", []))
    actions = list(state.get("actions_taken", []))
    actions.append("evaluate")
    events.append({"event": "status", "data": {"phase": "evaluating"}})

    evaluation = await evaluator_agent.evaluate_answer(
        state["current_question"],
        state["current_answer"],
        state.get("user_profile", {}),
        state.get("conversation_history", []),
    )

    # 집계용 메타 주입: 리포트 생성 시 phase/주제별로 묶기 위함
    phase = state.get("phase", "scan")
    meta: dict = {"phase": phase}
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
            meta["diveIdx"] = dive_idx
            meta["topicLabel"] = topic.get("topic", "")
            meta["angle"] = topic.get("angle", "")
            meta["projectRef"] = topic.get("project_ref", "")
            meta["diveDepth"] = state.get("current_dive_depth", 0)
    evaluation["meta"] = meta

    history = list(state.get("conversation_history", []))
    history.append({
        "question": state["current_question"],
        "answer": state["current_answer"],
        "evaluation": evaluation,
        "question_number": state.get("question_count", 1),
    })

    events.append({
        "event": "evaluation",
        "data": {
            "overallScore": evaluation.get("overallScore", 0),
            "briefFeedback": evaluation.get("briefFeedback", ""),
            "detailedFeedback": evaluation.get("detailedFeedback", ""),
            "modelAnswer": evaluation.get("modelAnswer", ""),
            "scores": evaluation.get("scores", {}),
        },
    })

    return {
        **state,
        "current_evaluation": evaluation,
        "conversation_history": history,
        "actions_taken": actions,
        "pending_events": events,
    }


async def update_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Save session insights to user profile RAG."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "updating_profile"}})

    await profile_agent.save_session_insights(
        db,
        state["user_id"],
        state.get("conversation_history", []),
        state["session_id"],
    )

    return {
        **state,
        "pending_events": events,
    }


async def generate_report(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate overall report."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_report"}})

    report = await evaluator_agent.generate_report(
        state.get("conversation_history", []),
        state.get("user_profile", {}),
    )

    events.append({"event": "complete", "data": {"report": report}})

    return {
        **state,
        "overall_report": report,
        "pending_events": events,
    }
