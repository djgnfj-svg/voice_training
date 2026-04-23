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
    if state.get("phase") == "dive" and state.get("current_dive_depth", 0) > 1:
        return "agent_followup"
    return "agent_question"


def _follow_up_round_for_state(state: InterviewState) -> int:
    if state.get("phase") != "dive":
        return 0
    return max(state.get("current_dive_depth", 0) - 1, 0)


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
        if not jp:
            raise HTTPException(404, {"error": "Job posting not found"})
        job_posting_data = jp.parsed_data

    # Use dynamic scan/dive depth for interview questions.
    # Free trials use scan only; full sessions use scan and dive.
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
        "phase": "scan",
        "scan_plan": [],
        "dive_plan": [],
        "scan_evaluations": [],
        "current_scan_idx": 0,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
    }

    async def event_generator():
        try:
            state = initial_state.copy()

            yield {"event": "status", "data": json.dumps({"phase": "loading_profile"})}
            state["pending_events"] = []

            state = await interview_graph.run_start_graph(state, db)

            # Persist Fit Analysis for answer/skip flows.
            session.fit_analysis = state.get("fit_analysis")

            session.phase = state.get("phase")
            session.scan_plan = state.get("scan_plan")
            session.dive_plan = state.get("dive_plan")
            # Task 8-fix: progress 초기??
            session.current_scan_idx = state.get("current_scan_idx", 0)
            session.current_dive_idx = 0
            session.current_dive_depth = 0
            session.scan_evaluations = state.get("scan_evaluations", [])

            pending_events = list(state.get("pending_events", []))
            question_events = [ev for ev in pending_events if ev.get("event") == "question"]
            for ev in pending_events:
                if ev.get("event") != "question":
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

            # Send session event before question event.
            yield {
                "event": "session",
                "data": json.dumps({
                    "sessionId": session_id,
                    "questionCount": state["question_count"],
                    "maxQuestions": state["max_questions"],
                }),
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
        except Exception as e:
            logger.exception("Agent interview start failed")
            yield {"event": "error", "data": json.dumps({"error": "Failed to start interview"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/answer ----------

@router.post("/api/agent-interview/{session_id}/answer")
async def submit_answer(
    session_id: str,
    body: AnswerRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit answer: evaluate ??decide next ??generate next question or end."""
    # Reject low-quality answers before processing.
    if not _is_meaningful_answer(body.answer):
        raise HTTPException(
            400,
            {"error": "Answer is too short or repetitive. Please add more detail or skip."},
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

    for msg in messages:
        if msg.role in QUESTION_ROLES:
            current_question = msg.content
            question_count = msg.question_number or 0
        elif msg.role == "user_answer" and msg.evaluation:
            conversation_history.append({
                "question": current_question,
                "answer": msg.content,
                "evaluation": msg.evaluation,
                "question_number": msg.question_number,
            })

    # Get last question from messages
    last_question_msg = None
    for msg in reversed(messages):
        if msg.role in QUESTION_ROLES:
            last_question_msg = msg
            break

    if not last_question_msg:
        raise HTTPException(400, {"error": "No active question"})

    current_question = last_question_msg.content
    question_count = last_question_msg.question_number or 1

    # Rebuild profile from RAG
    from app.agent.interview.profile_memory import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    # Restore resume RAG and Fit Analysis context.
    from app.agent.interview.resume_memory import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False

    # Restore Scan/Dive context from the session.
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []
    current_scan_idx = session.current_scan_idx or 0
    current_dive_idx = session.current_dive_idx or 0
    current_dive_depth = session.current_dive_depth or 0
    scan_evaluations = session.scan_evaluations or []

    # Rebuild scan plan for legacy sessions if missing.
    if not scan_plan:
        tmp_state: InterviewState = {
            "session_id": session_id,
            "user_id": user.id,
            "resume": resume_data,
            "job_posting": job_posting_data,
            "user_profile": user_profile,
            "fit_analysis": session.fit_analysis,
            "pending_events": [],
        }  # type: ignore
        tmp_state = await interview_graph.run_scan_plan_graph(tmp_state, db)
        phase = tmp_state.get("phase") or phase
        scan_plan = tmp_state.get("scan_plan") or []
        session.phase = phase
        session.scan_plan = scan_plan
        logger.info(f"Legacy session {session_id} scan_plan rebuilt")

    state: InterviewState = {
        "session_id": session_id,
        "user_id": user.id,
        "resume": resume_data,
        "job_posting": job_posting_data,
        "user_profile": user_profile,
        "current_question": current_question,
        "current_answer": body.answer,
        "question_count": question_count,
        "max_questions": session.max_questions or 7,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": conversation_history,
        "overall_report": None,
        "profile_context": [],
        "loop_count": 0,
        "actions_taken": [],
        "pending_events": [],
        "fit_analysis": session.fit_analysis,
        "resume_id": session.resume_id,
        "has_resume_embeddings": has_emb,
        "current_resume_chunks": [],
        "phase": phase,
        "scan_plan": scan_plan,
        "dive_plan": dive_plan,
        "scan_evaluations": scan_evaluations,
        "current_scan_idx": current_scan_idx,
        "current_dive_idx": current_dive_idx,
        "current_dive_depth": current_dive_depth,
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
                follow_up_round=0,
            )
            db.add(answer_msg)
            next_message_index += 1

            # Agent loop: plan ??action ??plan ??... ??decide
            state = await interview_graph.run_answer_graph(state, db)

            # Flush all pending events
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Update answer message with evaluation
            answer_msg.evaluation = state["current_evaluation"]

            # Handle post-decide state for Scan/Dive next actions.
            # Supported actions: scan_ask, dive_ask, build_dive_plan, end.
            action = state.get("next_action", "end")

            if action in ("scan_ask", "dive_ask", "build_dive_plan"):
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

                # Persist phase and plans.
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")
                # Persist progress.
                session.scan_evaluations = state.get("scan_evaluations")
                session.current_scan_idx = state.get("current_scan_idx", 0)
                session.current_dive_idx = state.get("current_dive_idx", 0)
                session.current_dive_depth = state.get("current_dive_depth", 0)

            else:  # end
                session.status = "completed"
                session.total_questions = state["question_count"]
                session.report_data = state.get("overall_report")
                if state.get("overall_report"):
                    session.overall_score = state["overall_report"].get("overallScore")
                session.phase = "done"
                # Persist progress.
                session.current_scan_idx = state.get("current_scan_idx", 0)
                session.current_dive_idx = state.get("current_dive_idx", 0)
                session.current_dive_depth = state.get("current_dive_depth", 0)

            await db.commit()

            # Map graph action to legacy frontend action.
            legacy_action = (
                "next_question"
                if action in ("scan_ask", "dive_ask", "build_dive_plan")
                else "end"
            )

            yield {
                "event": "action",
                "data": json.dumps({
                    "action": legacy_action,
                    "questionCount": state.get("question_count", 0),
                    "maxQuestions": state.get("max_questions", 7),
                }),
            }

        except Exception as e:
            logger.exception("Agent interview answer processing failed")
            yield {"event": "error", "data": json.dumps({"error": "Failed to process answer"})}

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

    messages = sorted(session.messages, key=lambda m: m.message_index)
    next_message_index = len(messages)

    # Rebuild minimal state
    question_count = _latest_question_number(messages)

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

    from app.agent.interview.profile_memory import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    # Build conversation history from DB
    conversation_history = []
    current_q = ""
    for msg in messages:
        if msg.role in QUESTION_ROLES:
            current_q = msg.content
        elif msg.role == "user_answer" and msg.evaluation:
            conversation_history.append({
                "question": current_q,
                "answer": msg.content,
                "evaluation": msg.evaluation,
                "question_number": msg.question_number,
            })

    max_questions = session.max_questions or 7

    # Restore resume RAG and Fit Analysis context.
    from app.agent.interview.resume_memory import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False
    persisted_fit = session.fit_analysis

    # Restore Scan/Dive progress directly from the session.
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []
    current_scan_idx = session.current_scan_idx or 0
    current_dive_idx = session.current_dive_idx or 0
    current_dive_depth = session.current_dive_depth or 0
    scan_evaluations = session.scan_evaluations or []

    # Rebuild scan plan for legacy sessions if missing.
    if not scan_plan:
        tmp_state: InterviewState = {
            "session_id": session_id,
            "user_id": user.id,
            "resume": resume_data,
            "job_posting": job_posting_data,
            "user_profile": user_profile,
            "fit_analysis": persisted_fit,
            "pending_events": [],
        }  # type: ignore
        tmp_state = await interview_graph.run_scan_plan_graph(tmp_state, db)
        phase = tmp_state.get("phase") or phase
        scan_plan = tmp_state.get("scan_plan") or []
        session.phase = phase
        session.scan_plan = scan_plan
        logger.info(f"Legacy session {session_id} scan_plan rebuilt")

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

            # 공통 state 빌드
            state: InterviewState = {
                "session_id": session_id,
                "user_id": user.id,
                "resume": resume_data,
                "job_posting": job_posting_data,
                "user_profile": user_profile,
                "current_question": "",
                "current_answer": "",
                "question_count": question_count,
                "max_questions": max_questions,
                "current_evaluation": {},
                "next_action": "",
                "conversation_history": conversation_history,
                "overall_report": None,
                "pending_events": [],
                "fit_analysis": persisted_fit,
                "resume_id": session.resume_id,
                "has_resume_embeddings": has_emb,
                "current_resume_chunks": [],
                "phase": phase,
                "scan_plan": scan_plan,
                "dive_plan": dive_plan,
                "scan_evaluations": scan_evaluations,
                "current_scan_idx": current_scan_idx,
                "current_dive_idx": current_dive_idx,
                "current_dive_depth": current_dive_depth,
            }

            should_end = False
            if question_count >= max_questions:
                should_end = True
            else:
                # Handle skip by phase.
                if phase == "scan":
                    # scan: dummy eval push, idx++
                    new_scan_idx = current_scan_idx + 1
                    state["scan_evaluations"] = scan_evaluations + [{"scores": {"depth": 0}}]
                    state["current_scan_idx"] = new_scan_idx
                    if new_scan_idx >= len(scan_plan):
                        # Build dive plan after scan is complete.
                        state["next_action"] = "build_dive_plan"
                        state = await interview_graph.run_next_question_graph(state, db)
                        if not state.get("dive_plan"):
                            # End if there is no dive plan.
                            should_end = True
                    else:
                        state["next_action"] = "scan_ask"
                        state = await interview_graph.run_next_question_graph(state, db)
                else:
                    # Dive: skip current topic and move to next topic.
                    new_dive_idx = current_dive_idx + 1
                    if new_dive_idx >= len(dive_plan):
                        should_end = True
                    else:
                        state["current_dive_idx"] = new_dive_idx
                        state["current_dive_depth"] = 0
                        state["next_action"] = "dive_ask"
                        state = await interview_graph.run_next_question_graph(state, db)

            if should_end:
                state["next_action"] = "end"
                state = await interview_graph.run_end_graph(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

                session.status = "completed"
                session.total_questions = state.get("question_count", question_count)
                session.report_data = state.get("overall_report")
                if state.get("overall_report"):
                    session.overall_score = state["overall_report"].get("overallScore")
                session.phase = "done"
                # Persist progress.
                session.current_scan_idx = state.get("current_scan_idx", 0)
                session.current_dive_idx = state.get("current_dive_idx", 0)
                session.current_dive_depth = state.get("current_dive_depth", 0)

                await db.commit()
                yield {
                    "event": "action",
                    "data": json.dumps({
                        "action": "end",
                        "questionCount": state.get("question_count", question_count),
                        "maxQuestions": max_questions,
                    }),
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

                # Persist phase and plans.
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")
                # Persist progress.
                session.scan_evaluations = state.get("scan_evaluations")
                session.current_scan_idx = state.get("current_scan_idx", 0)
                session.current_dive_idx = state.get("current_dive_idx", 0)
                session.current_dive_depth = state.get("current_dive_depth", 0)

                await db.commit()

                yield {
                    "event": "action",
                    "data": json.dumps({
                        "action": "next_question",
                        "questionCount": state["question_count"],
                        "maxQuestions": max_questions,
                    }),
                }

        except Exception:
            logger.exception("Skip question failed")
            yield {"event": "error", "data": json.dumps({"error": "Failed to skip question"})}

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

    # Restore conversation history.
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history = []
    question_count = 0
    current_q = ""
    for msg in messages:
        if msg.role in QUESTION_ROLES:
            current_q = msg.content
            question_count = msg.question_number or question_count
        elif msg.role == "user_answer" and msg.evaluation:
            conversation_history.append({
                "question": current_q,
                "answer": msg.content,
                "evaluation": msg.evaluation,
                "question_number": msg.question_number,
            })

    # Load resources for profile update and report generation.
    resume_result = await db.execute(select(Resume).where(Resume.id == session.resume_id))
    resume = resume_result.scalar_one_or_none()
    resume_data = resume.parsed_data if resume else {}

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

    from app.agent.interview.profile_memory import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    state: InterviewState = {
        "session_id": session_id,
        "user_id": user.id,
        "resume": resume_data,
        "job_posting": job_posting_data,
        "user_profile": user_profile,
        "current_question": "",
        "current_answer": "",
        "question_count": question_count,
        "max_questions": session.max_questions or 7,
        "current_evaluation": {},
        "next_action": "end",
        "conversation_history": conversation_history,
        "overall_report": None,
        "pending_events": [],
        "resume_id": session.resume_id,
        "fit_analysis": session.fit_analysis,
        "has_resume_embeddings": False,
        "current_resume_chunks": [],
    }

    # Skip report generation when there is no conversation history.
    if conversation_history:
        try:
            state = await interview_graph.run_end_graph(state, db)
            session.report_data = state.get("overall_report")
            if state.get("overall_report"):
                session.overall_score = state["overall_report"].get("overallScore")
        except Exception:
            logger.exception("End interview report generation failed for %s", session_id)

    session.status = "completed"
    session.total_questions = question_count
    session.phase = "done"
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
    from app.agent.interview.profile_memory import update_profile

    entry_id = await update_profile(
        db,
        user.id,
        "context",
        body.content,
        {"source": "user_input"},
    )
    return {"id": entry_id, "status": "saved"}
