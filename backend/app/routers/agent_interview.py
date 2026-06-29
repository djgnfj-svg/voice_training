from __future__ import annotations

import json
import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.agent.interview import graph as interview_graph
from app.agent.interview.profile_memory import load_user_profile
from app.agent.interview.resume_memory import has_resume_embeddings
from app.agent.interview.state import InterviewState
from app.models.agent_interview import AgentInterviewSession, AgentInterviewMessage
from app.models.resume import Resume
from app.models.interview import JobPosting

logger = logging.getLogger(__name__)

router = APIRouter()
QUESTION_ROLES = ("agent_question", "agent_followup")


# ---------- Schemas ----------


class StartRequest(BaseModel):
    resumeId: str
    jobPostingId: str | None = None
    textMode: bool = False


class AnswerRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=10000)


MIN_ANSWER_CHARS = 10
MIN_UNIQUE_TOKENS = 3


def _is_meaningful_answer(text: str) -> bool:
    """Reject very short or repetitive answers."""
    stripped = text.strip()
    if len(stripped) < MIN_ANSWER_CHARS:
        return False
    tokens = [t for t in stripped.split() if t]
    unique = {t for t in tokens}
    if len(unique) < MIN_UNIQUE_TOKENS:
        return False
    return True


def _latest_question_number(messages: list[AgentInterviewMessage]) -> int:
    for msg in reversed(messages):
        if msg.role in QUESTION_ROLES and msg.question_number is not None:
            return msg.question_number
    return 0


def _question_role_for_state(state: InterviewState) -> str:
    # item_depth는 rubric_ask에서 ask마다 +1. 첫 질문=1, dig 꼬리질문=2.
    return (
        "agent_followup" if state.get("current_item_depth", 0) > 1 else "agent_question"
    )


def _follow_up_round_for_state(state: InterviewState) -> int:
    return max(state.get("current_item_depth", 0) - 1, 0)


def _is_next_question_action(action: str) -> bool:
    return action == "rubric_ask"


def _persist_progress(session: AgentInterviewSession, state: InterviewState) -> None:
    # 컬럼 재사용: current_scan_idx ← rubric_idx, current_dive_depth ← item_depth.
    session.rubric_plan = state.get("rubric_plan")
    session.coverage = state.get("coverage")
    session.current_scan_idx = state.get("current_rubric_idx", 0)
    session.current_dive_depth = state.get("current_item_depth", 0)
    session.max_questions = state.get("max_questions", session.max_questions)


def _complete_session(session: AgentInterviewSession, state: InterviewState) -> None:
    session.status = "completed"
    session.total_questions = state.get("question_count", 0)
    session.report_data = state.get("overall_report")
    if state.get("overall_report"):
        session.overall_score = state["overall_report"].get("overallScore")
    session.coverage = state.get("coverage")
    session.current_scan_idx = state.get("current_rubric_idx", 0)
    session.current_dive_depth = state.get("current_item_depth", 0)


async def _load_resume_data(
    db: AsyncSession, resume_id: str | None, user_id: str
) -> dict:
    if not resume_id:
        return {}
    result = await db.execute(
        select(Resume).where(Resume.id == resume_id, Resume.user_id == user_id)
    )
    resume = result.scalar_one_or_none()
    return resume.parsed_data if resume else {}


async def _load_job_posting_data(
    db: AsyncSession,
    *,
    job_posting_id: str | None,
    user_id: str,
) -> dict | None:
    if not job_posting_id:
        return None
    result = await db.execute(
        select(JobPosting).where(
            JobPosting.id == job_posting_id,
            JobPosting.user_id == user_id,
        )
    )
    job_posting = result.scalar_one_or_none()
    return job_posting.parsed_data if job_posting else None


def _conversation_from_messages(
    messages: list[AgentInterviewMessage],
) -> tuple[list[dict], str, int]:
    conversation_history = []
    current_question = ""
    question_count = 0

    for msg in messages:
        if msg.role in QUESTION_ROLES:
            current_question = msg.content
            question_count = msg.question_number or question_count
        elif msg.role == "user_answer" and msg.evaluation:
            conversation_history.append(
                {
                    "question": current_question,
                    "answer": msg.content,
                    "evaluation": msg.evaluation,
                    "question_number": msg.question_number,
                }
            )

    return conversation_history, current_question, question_count


async def _restore_interview_state(
    *,
    db: AsyncSession,
    session: AgentInterviewSession,
    session_id: str,
    user_id: str,
    current_answer: str = "",
    require_active_question: bool = False,
) -> tuple[InterviewState, list[AgentInterviewMessage]]:
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history, current_question, question_count = (
        _conversation_from_messages(messages)
    )

    if require_active_question:
        last_question_msg = next(
            (msg for msg in reversed(messages) if msg.role in QUESTION_ROLES), None
        )
        if not last_question_msg:
            raise HTTPException(400, {"error": "No active question"})
        current_question = last_question_msg.content
        question_count = last_question_msg.question_number or 1

    resume_data = await _load_resume_data(db, session.resume_id, user_id)
    job_posting_data = await _load_job_posting_data(
        db,
        job_posting_id=session.job_posting_id,
        user_id=user_id,
    )
    user_profile = await load_user_profile(db, user_id, resume_data, job_posting_data)
    has_emb = (
        await has_resume_embeddings(db, session.resume_id)
        if session.resume_id
        else False
    )

    state: InterviewState = {
        "session_id": session_id,
        "user_id": user_id,
        "resume": resume_data,
        "job_posting": job_posting_data,
        "user_profile": user_profile,
        "current_question": current_question,
        "current_answer": current_answer,
        "question_count": question_count,
        "max_questions": session.max_questions or 9,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": conversation_history,
        "overall_report": None,
        "pending_events": [],
        "fit_analysis": session.fit_analysis,
        "resume_id": session.resume_id,
        "has_resume_embeddings": has_emb,
        "current_resume_chunks": [],
        # 컬럼 재사용: current_scan_idx → rubric_idx, current_dive_depth → item_depth.
        "rubric_plan": session.rubric_plan or [],
        "coverage": session.coverage or [],
        "current_rubric_idx": session.current_scan_idx or 0,
        "current_item_depth": session.current_dive_depth or 0,
    }
    return state, messages


def _is_legacy_session(session: AgentInterviewSession) -> bool:
    """rubric_plan 컬럼이 NULL인 진행중 세션 = Scan/Dive 시절 레거시 세션."""
    return session.rubric_plan is None


async def _legacy_finalize_events(
    *,
    db: AsyncSession,
    session: AgentInterviewSession,
    session_id: str,
    user_id: str,
):
    """레거시 진행중 세션을 즉시 종료(completed)하고 가능하면 리포트 생성.

    rubric rebuild는 하지 않는다 (확정 결정 OQ-4).
    """
    legacy_state, _ = await _restore_interview_state(
        db=db, session=session, session_id=session_id, user_id=user_id
    )
    legacy_state.update(
        {"current_question": "", "current_answer": "", "next_action": "end"}
    )
    try:
        if legacy_state.get("conversation_history"):
            legacy_state = await interview_graph.run_end_graph(legacy_state, db)
            for ev in legacy_state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
    except Exception:
        logger.exception("Legacy session %s finalize failed", session_id)
    _complete_session(session, legacy_state)
    await db.commit()
    yield {
        "event": "action",
        "data": json.dumps(
            {
                "action": "end",
                "questionCount": legacy_state.get("question_count", 0),
                "maxQuestions": legacy_state.get("max_questions", 9),
            }
        ),
    }


class ProfileContextRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


# ---------- POST /api/agent-interview/start ----------


@router.post("/api/agent-interview/start")
async def start_interview(
    body: StartRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start agent interview: load profile, generate first question."""
    # Verify resume
    result = await db.execute(
        select(Resume).where(Resume.id == body.resumeId, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(404, {"error": "Resume not found"})

    resume_data = resume.parsed_data or {}

    # JD 필수화: 채용공고 없이는 루브릭 커버리지 면접을 진행할 수 없다.
    if not body.jobPostingId:
        raise HTTPException(400, {"error": "채용공고를 먼저 입력해주세요."})
    jp_result = await db.execute(
        select(JobPosting).where(
            JobPosting.id == body.jobPostingId,
            JobPosting.user_id == user.id,
        )
    )
    jp = jp_result.scalar_one_or_none()
    if not jp:
        raise HTTPException(404, {"error": "Job posting not found"})
    job_posting_data = jp.parsed_data

    # 질문 수 상한. 실제 종료는 루브릭 커버리지 소진으로 결정된다.
    effective_max_questions = 9

    # Create session
    session_id = str(uuid4())
    session = AgentInterviewSession(
        id=session_id,
        user_id=user.id,
        resume_id=body.resumeId,
        job_posting_id=body.jobPostingId,
        max_questions=effective_max_questions,
        text_mode=body.textMode,
    )
    db.add(session)
    await db.commit()

    # Build initial state
    initial_state: InterviewState = {
        "session_id": session_id,
        "user_id": user.id,
        "resume": resume_data,
        "job_posting": job_posting_data,
        "user_profile": {},
        "current_question": "",
        "current_answer": "",
        "question_count": 0,
        "max_questions": effective_max_questions,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": [],
        "overall_report": None,
        "pending_events": [],
        "resume_id": body.resumeId,
        "fit_analysis": None,
        "has_resume_embeddings": False,
        "current_resume_chunks": [],
        "rubric_plan": [],
        "coverage": [],
        "current_rubric_idx": 0,
        "current_item_depth": 0,
    }

    async def event_generator():
        try:
            state = initial_state.copy()

            yield {"event": "status", "data": json.dumps({"phase": "loading_profile"})}
            state["pending_events"] = []

            state = await interview_graph.run_start_graph(state, db)

            # Persist Fit Analysis for answer/skip flows.
            session.fit_analysis = state.get("fit_analysis")

            _persist_progress(session, state)

            pending_events = list(state.get("pending_events", []))
            question_events = [
                ev for ev in pending_events if ev.get("event") == "question"
            ]
            for ev in pending_events:
                if ev.get("event") != "question":
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

            # Send session event before question event.
            yield {
                "event": "session",
                "data": json.dumps(
                    {
                        "sessionId": session_id,
                        "questionCount": state["question_count"],
                        "maxQuestions": state["max_questions"],
                    }
                ),
            }

            for ev in question_events:
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Save first question to DB
            msg = AgentInterviewMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=0,
                role="agent_question",
                content=state["current_question"],
                question_number=state["question_count"],
                follow_up_round=0,
            )
            db.add(msg)
            await db.commit()
        except Exception:
            logger.exception("Agent interview start failed")
            yield {
                "event": "error",
                "data": json.dumps({"error": "Failed to start interview"}),
            }

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/answer ----------


@router.post("/api/agent-interview/{session_id}/answer")
async def submit_answer(
    session_id: str,
    body: AnswerRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit answer: evaluate, decide next, generate next question or end."""
    # Reject low-quality answers before processing.
    if not _is_meaningful_answer(body.answer):
        raise HTTPException(
            400,
            {
                "error": "Answer is too short or repetitive. Please add more detail or skip."
            },
        )

    # Verify session
    result = await db.execute(
        select(AgentInterviewSession)
        .where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status == "in_progress",
        )
        .options(selectinload(AgentInterviewSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "Session not found"})

    # 레거시(rubric_plan NULL) 진행중 세션은 즉시 종료 처리 (확정 결정 OQ-4).
    if _is_legacy_session(session):
        return EventSourceResponse(
            _legacy_finalize_events(
                db=db, session=session, session_id=session_id, user_id=user.id
            )
        )

    state, messages = await _restore_interview_state(
        db=db,
        session=session,
        session_id=session_id,
        user_id=user.id,
        current_answer=body.answer,
        require_active_question=True,
    )
    state.update({"profile_context": [], "loop_count": 0, "actions_taken": []})

    next_message_index = len(messages)
    question_count = state["question_count"]

    async def event_generator():
        nonlocal state, next_message_index
        try:
            # Save user answer
            answer_msg = AgentInterviewMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=next_message_index,
                role="user_answer",
                content=body.answer,
                question_number=question_count,
                follow_up_round=0,
            )
            db.add(answer_msg)
            next_message_index += 1

            # Agent loop: plan -> action -> plan -> decide.
            state = await interview_graph.run_answer_graph(state, db)

            # Flush all pending events
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Update answer message with evaluation
            answer_msg.evaluation = state["current_evaluation"]

            # 다음 행동: rubric_ask(다음 질문) 또는 end.
            action = state.get("next_action", "end")

            if _is_next_question_action(action):
                q_msg = AgentInterviewMessage(
                    id=uuid4(),
                    session_id=session_id,
                    message_index=next_message_index,
                    role=_question_role_for_state(state),
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=_follow_up_round_for_state(state),
                )
                db.add(q_msg)
                next_message_index += 1

                _persist_progress(session, state)

            else:  # end
                _complete_session(session, state)

            await db.commit()

            # Map graph action to legacy frontend action.
            legacy_action = (
                "next_question" if _is_next_question_action(action) else "end"
            )

            yield {
                "event": "action",
                "data": json.dumps(
                    {
                        "action": legacy_action,
                        "questionCount": state.get("question_count", 0),
                        "maxQuestions": state.get("max_questions", 9),
                    }
                ),
            }

        except Exception:
            logger.exception("Agent interview answer processing failed")
            yield {
                "event": "error",
                "data": json.dumps({"error": "Failed to process answer"}),
            }

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/skip ----------


@router.post("/api/agent-interview/{session_id}/skip")
async def skip_question(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Skip current question: no evaluation, just generate next question or end."""
    result = await db.execute(
        select(AgentInterviewSession)
        .where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status == "in_progress",
        )
        .options(selectinload(AgentInterviewSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "Session not found"})

    # 레거시(rubric_plan NULL) 진행중 세션은 즉시 종료 처리 (확정 결정 OQ-4).
    if _is_legacy_session(session):
        return EventSourceResponse(
            _legacy_finalize_events(
                db=db, session=session, session_id=session_id, user_id=user.id
            )
        )

    restored_state, messages = await _restore_interview_state(
        db=db,
        session=session,
        session_id=session_id,
        user_id=user.id,
    )
    next_message_index = len(messages)
    question_count = _latest_question_number(messages)
    restored_state["question_count"] = question_count
    max_questions = restored_state["max_questions"]

    async def event_generator():
        nonlocal question_count, next_message_index
        try:
            # Save skip as user_answer
            skip_msg = AgentInterviewMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=next_message_index,
                role="user_answer",
                content="(skipped)",
                question_number=question_count,
                follow_up_round=0,
            )
            db.add(skip_msg)
            next_message_index += 1

            # 현재 항목 skip → 미검증(unverified) 표기 후 다음 미커버 항목으로.
            state: InterviewState = {
                **restored_state,
                "current_question": "",
                "current_answer": "",
            }
            coverage = [dict(c) for c in state.get("coverage", [])]
            idx = state.get("current_rubric_idx", 0)
            if 0 <= idx < len(coverage) and coverage[idx].get("status") == "pending":
                coverage[idx]["status"] = "unverified"
            state["coverage"] = coverage

            should_end = False
            if question_count >= max_questions:
                should_end = True
            else:
                next_idx = interview_graph._select_next_rubric_item(coverage)
                state["coverage"] = coverage
                if next_idx is None:
                    should_end = True
                else:
                    state["current_rubric_idx"] = next_idx
                    state["current_item_depth"] = 0
                    state = await interview_graph.run_rubric_ask_graph(state, db)

            if should_end:
                state["next_action"] = "end"
                state = await interview_graph.run_end_graph(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

                _complete_session(session, state)

                await db.commit()
                yield {
                    "event": "action",
                    "data": json.dumps(
                        {
                            "action": "end",
                            "questionCount": state.get(
                                "question_count", question_count
                            ),
                            "maxQuestions": max_questions,
                        }
                    ),
                }
            else:
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                q_msg = AgentInterviewMessage(
                    id=uuid4(),
                    session_id=session_id,
                    message_index=next_message_index,
                    role=_question_role_for_state(state),
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=_follow_up_round_for_state(state),
                )
                db.add(q_msg)

                _persist_progress(session, state)

                await db.commit()

                yield {
                    "event": "action",
                    "data": json.dumps(
                        {
                            "action": "next_question",
                            "questionCount": state["question_count"],
                            "maxQuestions": max_questions,
                        }
                    ),
                }

        except Exception:
            logger.exception("Skip question failed")
            yield {
                "event": "error",
                "data": json.dumps({"error": "Failed to skip question"}),
            }

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/end ----------


@router.post("/api/agent-interview/{session_id}/end")
async def end_interview(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually end interview early and generate a report when possible."""
    result = await db.execute(
        select(AgentInterviewSession)
        .where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status == "in_progress",
        )
        .options(selectinload(AgentInterviewSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "Session not found"})

    state, _ = await _restore_interview_state(
        db=db,
        session=session,
        session_id=session_id,
        user_id=user.id,
    )
    state.update({"current_question": "", "current_answer": "", "next_action": "end"})
    conversation_history = state.get("conversation_history", [])
    question_count = state.get("question_count", 0)

    # Skip report generation when there is no conversation history.
    if conversation_history:
        try:
            state = await interview_graph.run_end_graph(state, db)
        except Exception:
            logger.exception(
                "End interview report generation failed for %s", session_id
            )

    _complete_session(session, state)
    session.total_questions = question_count
    await db.commit()

    return {"status": "completed", "sessionId": session_id}


# ---------- GET /api/agent-interview/{session_id} ----------


@router.get("/api/agent-interview/{session_id}")
async def get_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get agent interview session with messages."""
    result = await db.execute(
        select(AgentInterviewSession)
        .where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
        )
        .options(selectinload(AgentInterviewSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "Session not found"})

    messages = sorted(session.messages, key=lambda m: m.message_index)

    return {
        "id": session.id,
        "status": session.status,
        "totalQuestions": session.total_questions,
        "maxQuestions": session.max_questions,
        "overallScore": session.overall_score,
        "reportData": session.report_data,
        "createdAt": session.created_at.isoformat() if session.created_at else None,
        "messages": [
            {
                "id": str(m.id),
                "role": m.role,
                "content": m.content,
                "evaluation": m.evaluation,
                "questionNumber": m.question_number,
                "followUpRound": m.follow_up_round,
                "audioUrl": m.audio_url,
                "createdAt": m.created_at.isoformat() if m.created_at else None,
            }
            for m in messages
        ],
    }


# ---------- GET /api/profile ----------


@router.get("/api/profile")
async def get_profile(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get user's AI profile summary."""
    from app.agent.interview.profile_memory import search_profile

    profiles = await search_profile(db, user.id, "interview overall summary", top_k=20)

    CATEGORY_KEY = {
        "strength": "strengths",
        "weakness": "weaknesses",
        "pattern": "patterns",
        "context": "context",
    }
    organized: dict[str, list[str]] = {
        "strengths": [],
        "weaknesses": [],
        "patterns": [],
        "context": [],
    }
    for p in profiles:
        cat = p["category"]
        key = CATEGORY_KEY.get(cat)
        if key and key in organized:
            organized[key].append(p["content"])

    return organized


# ---------- POST /api/profile/context ----------


@router.post("/api/profile/context")
async def add_profile_context(
    body: ProfileContextRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add explicit user context to profile."""
    from app.agent.interview.profile_memory import update_profile

    entry_id = await update_profile(
        db,
        user.id,
        "context",
        body.content,
        {"source": "user_input"},
    )
    return {"id": entry_id, "status": "saved"}
