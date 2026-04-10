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
from app.agent import nodes
from app.agent.state import InterviewState
from app.models.agent_interview import AgentInterviewSession, AgentInterviewMessage
from app.models.resume import Resume
from app.models.interview import JobPosting

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------- Schemas ----------

class StartRequest(BaseModel):
    resumeId: str
    jobPostingId: str | None = None
    maxQuestions: int = Field(default=7, ge=1, le=15)
    textMode: bool = False


class AnswerRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=10000)


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
        raise HTTPException(404, {"error": "이력서를 찾을 수 없습니다"})

    resume_data = resume.parsed_data or {}

    # Load job posting if provided
    job_posting_data = None
    if body.jobPostingId:
        jp_result = await db.execute(
            select(JobPosting).where(
                JobPosting.id == body.jobPostingId,
                JobPosting.user_id == user.id,
            )
        )
        jp = jp_result.scalar_one_or_none()
        if jp:
            job_posting_data = jp.parsed_data

    # Create session
    session_id = str(uuid4())
    session = AgentInterviewSession(
        id=session_id,
        user_id=user.id,
        resume_id=body.resumeId,
        job_posting_id=body.jobPostingId,
        max_questions=body.maxQuestions,
        text_mode=body.textMode,
    )
    db.add(session)
    await db.commit()

    # TODO(v2): 크레딧 차감 — 기존 credit.py의 deduct_credits() 연동

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
        "follow_up_round": 0,
        "max_questions": body.maxQuestions,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": [],
        "overall_report": None,
        "pending_events": [],
    }

    async def event_generator():
        try:
            state = initial_state.copy()

            yield {"event": "status", "data": json.dumps({"phase": "loading_profile"})}
            state["pending_events"] = []

            state = await nodes.load_profile(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            state = await nodes.generate_question(state, db)

            # session 이벤트를 question보다 먼저 전송 (프론트에서 sessionId 필요)
            yield {
                "event": "session",
                "data": json.dumps({
                    "sessionId": session_id,
                    "questionCount": state["question_count"],
                    "maxQuestions": state["max_questions"],
                }),
            }

            for ev in state.get("pending_events", []):
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
        except Exception as e:
            logger.exception("Agent interview start failed")
            yield {"event": "error", "data": json.dumps({"error": "면접 시작에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/answer ----------

@router.post("/api/agent-interview/{session_id}/answer")
async def submit_answer(
    session_id: str,
    body: AnswerRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit answer: evaluate → decide next → generate next question or end."""
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
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Load resume
    resume_result = await db.execute(select(Resume).where(Resume.id == session.resume_id))
    resume = resume_result.scalar_one_or_none()
    resume_data = resume.parsed_data if resume else {}

    # Load job posting
    job_posting_data = None
    if session.job_posting_id:
        jp_result = await db.execute(
            select(JobPosting).where(
                JobPosting.id == session.job_posting_id,
                JobPosting.user_id == user.id,
            )
        )
        jp = jp_result.scalar_one_or_none()
        if jp:
            job_posting_data = jp.parsed_data

    # Rebuild state from DB messages
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history = []
    current_question = ""
    question_count = 0
    follow_up_round = 0

    for msg in messages:
        if msg.role in ("agent_question", "agent_followup"):
            current_question = msg.content
            question_count = msg.question_number or 0
            follow_up_round = msg.follow_up_round or 0
        elif msg.role == "user_answer" and msg.evaluation:
            conversation_history.append({
                "question": current_question,
                "answer": msg.content,
                "evaluation": msg.evaluation,
                "question_number": msg.question_number,
                "follow_up_round": msg.follow_up_round or 0,
            })

    # Get last question from messages
    last_question_msg = None
    for msg in reversed(messages):
        if msg.role in ("agent_question", "agent_followup"):
            last_question_msg = msg
            break

    if not last_question_msg:
        raise HTTPException(400, {"error": "진행 중인 질문이 없습니다"})

    current_question = last_question_msg.content
    question_count = last_question_msg.question_number or 1
    follow_up_round = last_question_msg.follow_up_round or 0

    # Rebuild profile from RAG
    from app.agent.profile_agent import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    state: InterviewState = {
        "session_id": session_id,
        "user_id": user.id,
        "resume": resume_data,
        "job_posting": job_posting_data,
        "user_profile": user_profile,
        "current_question": current_question,
        "current_answer": body.answer,
        "question_count": question_count,
        "follow_up_round": follow_up_round,
        "max_questions": session.max_questions or 7,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": conversation_history,
        "overall_report": None,
        "pending_events": [],
    }

    next_message_index = len(messages)

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
                follow_up_round=follow_up_round,
            )
            db.add(answer_msg)
            next_message_index += 1

            # Evaluate
            state = await nodes.evaluate_answer(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Update answer message with evaluation
            answer_msg.evaluation = state["current_evaluation"]
            await db.commit()

            # Decide next action
            state = await nodes.decide_next(state, db)
            action = state.get("next_action", "end")

            if action == "follow_up":
                state = await nodes.generate_followup(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                fq_msg = AgentInterviewMessage(
                    id=uuid4(),
                    session_id=session_id,
                    message_index=next_message_index,
                    role="agent_followup",
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=state["follow_up_round"],
                )
                db.add(fq_msg)
                next_message_index += 1

            elif action == "next_question":
                state = await nodes.generate_question(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                q_msg = AgentInterviewMessage(
                    id=uuid4(),
                    session_id=session_id,
                    message_index=next_message_index,
                    role="agent_question",
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=0,
                )
                db.add(q_msg)
                next_message_index += 1

            else:  # end
                state = await nodes.update_profile(state, db)
                state = await nodes.generate_report(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                session.status = "completed"
                session.total_questions = state["question_count"]
                session.report_data = state.get("overall_report")
                if state.get("overall_report"):
                    session.overall_score = state["overall_report"].get("overallScore")

            await db.commit()

            yield {
                "event": "action",
                "data": json.dumps({
                    "action": action,
                    "questionCount": state.get("question_count", 0),
                    "maxQuestions": state.get("max_questions", 7),
                }),
            }

        except Exception as e:
            logger.exception("Agent interview answer processing failed")
            yield {"event": "error", "data": json.dumps({"error": "답변 처리에 실패했습니다"})}

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
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    messages = sorted(session.messages, key=lambda m: m.message_index)
    next_message_index = len(messages)

    # Rebuild minimal state
    question_count = 0
    for msg in messages:
        if msg.role == "agent_question":
            question_count = msg.question_number or 0

    # Load resume for question generation
    resume_result = await db.execute(select(Resume).where(Resume.id == session.resume_id))
    resume = resume_result.scalar_one_or_none()
    resume_data = resume.parsed_data if resume else {}

    job_posting_data = None
    if session.job_posting_id:
        jp_result = await db.execute(
            select(JobPosting).where(JobPosting.id == session.job_posting_id, JobPosting.user_id == user.id)
        )
        jp = jp_result.scalar_one_or_none()
        if jp:
            job_posting_data = jp.parsed_data

    from app.agent.profile_agent import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    # Build conversation history from DB
    conversation_history = []
    current_q = ""
    for msg in messages:
        if msg.role in ("agent_question", "agent_followup"):
            current_q = msg.content
        elif msg.role == "user_answer" and msg.evaluation:
            conversation_history.append({
                "question": current_q,
                "answer": msg.content,
                "evaluation": msg.evaluation,
                "question_number": msg.question_number,
                "follow_up_round": msg.follow_up_round or 0,
            })

    max_questions = session.max_questions or 7

    async def event_generator():
        nonlocal question_count, next_message_index
        try:
            # Save skip as user_answer
            skip_msg = AgentInterviewMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=next_message_index,
                role="user_answer",
                content="(건너뜀)",
                question_number=question_count,
                follow_up_round=0,
            )
            db.add(skip_msg)
            next_message_index += 1

            if question_count >= max_questions:
                # End interview
                state: InterviewState = {
                    "session_id": session_id,
                    "user_id": user.id,
                    "resume": resume_data,
                    "job_posting": job_posting_data,
                    "user_profile": user_profile,
                    "current_question": "",
                    "current_answer": "",
                    "question_count": question_count,
                    "follow_up_round": 0,
                    "max_questions": max_questions,
                    "current_evaluation": {},
                    "next_action": "end",
                    "conversation_history": conversation_history,
                    "overall_report": None,
                    "pending_events": [],
                }
                state = await nodes.update_profile(state, db)
                state = await nodes.generate_report(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

                session.status = "completed"
                session.total_questions = question_count
                session.report_data = state.get("overall_report")
                if state.get("overall_report"):
                    session.overall_score = state["overall_report"].get("overallScore")

                await db.commit()
                yield {"event": "action", "data": json.dumps({"action": "end", "questionCount": question_count, "maxQuestions": max_questions})}
            else:
                # Generate next question directly (no evaluation)
                state: InterviewState = {
                    "session_id": session_id,
                    "user_id": user.id,
                    "resume": resume_data,
                    "job_posting": job_posting_data,
                    "user_profile": user_profile,
                    "current_question": "",
                    "current_answer": "",
                    "question_count": question_count,
                    "follow_up_round": 0,
                    "max_questions": max_questions,
                    "current_evaluation": {},
                    "next_action": "",
                    "conversation_history": conversation_history,
                    "overall_report": None,
                    "pending_events": [],
                }
                state = await nodes.generate_question(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

                q_msg = AgentInterviewMessage(
                    id=uuid4(),
                    session_id=session_id,
                    message_index=next_message_index,
                    role="agent_question",
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=0,
                )
                db.add(q_msg)
                await db.commit()

                yield {"event": "action", "data": json.dumps({"action": "next_question", "questionCount": state["question_count"], "maxQuestions": max_questions})}

        except Exception:
            logger.exception("Skip question failed")
            yield {"event": "error", "data": json.dumps({"error": "건너뛰기에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/end ----------

@router.post("/api/agent-interview/{session_id}/end")
async def end_interview(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually end interview early."""
    result = await db.execute(
        select(AgentInterviewSession).where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status == "in_progress",
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    session.status = "completed"
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
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

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
    from app.agent.profile_agent import search_profile

    profiles = await search_profile(db, user.id, "면접 역량 종합", top_k=20)

    CATEGORY_KEY = {"strength": "strengths", "weakness": "weaknesses", "pattern": "patterns", "context": "context"}
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
    from app.agent.profile_agent import update_profile

    entry_id = await update_profile(
        db,
        user.id,
        "context",
        body.content,
        {"source": "user_input"},
    )
    return {"id": entry_id, "status": "saved"}
