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
    """Î™®Î∞î??Ï§ëÎ≥µ ?ÖÎ†•/Î∞òÎ≥µ Î¨∏Ïûê ?òÏó¥??ÎßâÎäî ?òÎ? ?àÎäî ?µÎ? Í∞Ä??"""
    stripped = text.strip()
    if len(stripped) < MIN_ANSWER_CHARS:
        return False
    tokens = [t for t in stripped.split() if t]
    unique = {t for t in tokens}
    if len(unique) < MIN_UNIQUE_TOKENS:
        return False
    return True


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
        raise HTTPException(404, {"error": "?¥Î†•?úÎ? Ï∞æÏùÑ ???ÜÏäµ?àÎã§"})

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

    # ÏßàÎ¨∏ ?òÎäî ?¥Î†•???ÑÎ°ú?ùÌä∏/?µÎ? ÍπäÏù¥Î°??ôÏ†Å Í≤∞Ï†ï (scan 3 + dive ÏµúÎ? 6 = 9).
    # max_questions???ÅÌïú Í∞Ä?úÎ°úÎß??¨Ïö©: Î¨¥Î£åÏ≤¥Ìóò?Ä 3(scanÎß?, ?ºÎ∞ò?Ä 9(scan+dive ?ÑÏ≤¥).
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

            # Fit Analysis ?ÅÏÜç????answer/skip ?êÎ¶Ñ?êÏÑú ?¨ÏÇ¨??(Spec 4.2(b))
            session.fit_analysis = state.get("fit_analysis")

            session.phase = state.get("phase")
            session.scan_plan = state.get("scan_plan")
            session.dive_plan = state.get("dive_plan")
            # Task 8-fix: progress Ï¥àÍ∏∞??
            session.current_scan_idx = state.get("current_scan_idx", 0)
            session.current_dive_idx = 0
            session.current_dive_depth = 0
            session.scan_evaluations = state.get("scan_evaluations", [])

            pending_events = list(state.get("pending_events", []))
            question_events = [ev for ev in pending_events if ev.get("event") == "question"]
            for ev in pending_events:
                if ev.get("event") != "question":
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

            # session ?¥Î≤§?∏Î? questionÎ≥¥Îã§ Î®ºÏ? ?ÑÏÜ° (?ÑÎ°†?∏Ïóê??sessionId ?ÑÏöî)
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
            yield {"event": "error", "data": json.dumps({"error": "Î©¥Ï†ë ?úÏûë???§Ìå®?àÏäµ?àÎã§"})}

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
    # ?µÎ? ?àÏßà Í∞Ä??(?ÑÎ°†???∞Ìöå Î∞©Ïñ¥)
    if not _is_meaningful_answer(body.answer):
        raise HTTPException(
            400,
            {"error": '?µÎ????àÎ¨¥ ÏßßÍ±∞??Î∞òÎ≥µ?©Îãà?? Ï°∞Í∏à ??ÎßêÏ???Ï£ºÏãúÍ±∞ÎÇò "Í±¥ÎÑà?∞Í∏∞"Î•??åÎü¨Ï£ºÏÑ∏??'},
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
        raise HTTPException(404, {"error": "?∏ÏÖò??Ï∞æÏùÑ ???ÜÏäµ?àÎã§"})

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
        if msg.role in ("agent_question", "agent_followup"):
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
        if msg.role in ("agent_question", "agent_followup"):
            last_question_msg = msg
            break

    if not last_question_msg:
        raise HTTPException(400, {"error": "ÏßÑÌñâ Ï§ëÏù∏ ÏßàÎ¨∏???ÜÏäµ?àÎã§"})

    current_question = last_question_msg.content
    question_count = last_question_msg.question_number or 1

    # Rebuild profile from RAG
    from app.agent.interview.profile_memory import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    # ?¥Î†•??RAG / Fit Analysis Ïª®ÌÖç?§Ìä∏ Î≥µÏõê (Spec 4.2(b))
    from app.agent.interview.resume_memory import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False

    # Scan/Dive ?òÏù¥Ï¶?Ïª®ÌÖç?§Ìä∏ Î≥µÏõê (Task 8-fix: session?êÏÑú ÏßÅÏ†ë Î≥µÏõê)
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []
    current_scan_idx = session.current_scan_idx or 0
    current_dive_idx = session.current_dive_idx or 0
    current_dive_depth = session.current_dive_depth or 0
    scan_evaluations = session.scan_evaluations or []

    # Task 8-fix: ?àÍ±∞???∏ÏÖò(phase=NULL) Î∞©Ïñ¥ ??scan_plan ?ÜÏúºÎ©??¨ÏÉù??
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

            # Handle post-decide state ??Scan+Dive Íµ¨Ï°∞?êÏÑú next_action?Ä
            # scan_ask / dive_ask / build_dive_plan / end Ï§??òÎÇò
            action = state.get("next_action", "end")

            if action in ("scan_ask", "dive_ask", "build_dive_plan"):
                # ?•Îã§?¥Î∏å depth>=2 ÏßàÎ¨∏?Ä agent_followup, ?òÎ®∏ÏßÄ??agent_question
                is_dive_followup = (
                    state.get("phase") == "dive"
                    and state.get("current_dive_depth", 0) > 1
                )
                msg_role = "agent_followup" if is_dive_followup else "agent_question"
                q_msg = AgentInterviewMessage(
                    id=uuid4(),
                    session_id=session_id,
                    message_index=next_message_index,
                    role=msg_role,
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=0,
                )
                db.add(q_msg)
                next_message_index += 1

                # phase/scan_plan/dive_plan ?ÅÏÜç??
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")
                # Task 8-fix: progress ?ÅÏÜç??
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
                # Task 8-fix: progress ?ÅÏÜç??
                session.current_scan_idx = state.get("current_scan_idx", 0)
                session.current_dive_idx = state.get("current_dive_idx", 0)
                session.current_dive_depth = state.get("current_dive_depth", 0)

            await db.commit()

            # ?ÑÎ°†???∏Ìôò: ?¥Î? action(scan_ask/dive_ask/build_dive_plan) ??"next_question"
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
            yield {"event": "error", "data": json.dumps({"error": "?µÎ? Ï≤òÎ¶¨???§Ìå®?àÏäµ?àÎã§"})}

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
        raise HTTPException(404, {"error": "?∏ÏÖò??Ï∞æÏùÑ ???ÜÏäµ?àÎã§"})

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

    from app.agent.interview.profile_memory import load_user_profile
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
            })

    max_questions = session.max_questions or 7

    # ?¥Î†•??RAG / Fit Analysis Ïª®ÌÖç?§Ìä∏ Î≥µÏõê (Spec 4.2(b))
    from app.agent.interview.resume_memory import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False
    persisted_fit = session.fit_analysis

    # Task 8-fix: Scan/Dive progress ÏßÅÏ†ë Î≥µÏõê (?¥Î¶¨?§Ìã± ?úÍ±∞)
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []
    current_scan_idx = session.current_scan_idx or 0
    current_dive_idx = session.current_dive_idx or 0
    current_dive_depth = session.current_dive_depth or 0
    scan_evaluations = session.scan_evaluations or []

    # Task 8-fix: ?àÍ±∞???∏ÏÖò(phase=NULL) Î∞©Ïñ¥ ??scan_plan ?ÜÏúºÎ©??¨ÏÉù??
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
                content="(Í±¥ÎÑà?Ä)",
                question_number=question_count,
                follow_up_round=0,
            )
            db.add(skip_msg)
            next_message_index += 1

            # Í≥µÌÜµ state ÎπåÎìú
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
                # ?òÏù¥Ï¶àÎ≥Ñ skip Ï≤òÎ¶¨
                if phase == "scan":
                    # scan: dummy eval push, idx++
                    new_scan_idx = current_scan_idx + 1
                    state["scan_evaluations"] = scan_evaluations + [{"scores": {"depth": 0}}]
                    state["current_scan_idx"] = new_scan_idx
                    if new_scan_idx >= len(scan_plan):
                        # ?ëÍ∏∞ ?åÏßÑ ??dive ?ÑÌôò
                        state["next_action"] = "build_dive_plan"
                        state = await interview_graph.run_next_question_graph(state, db)
                        if not state.get("dive_plan"):
                            # dive_plan ÎπÑÏñ¥?àÏúºÎ©?Ï¢ÖÎ£å
                            should_end = True
                    else:
                        state["next_action"] = "scan_ask"
                        state = await interview_graph.run_next_question_graph(state, db)
                else:
                    # dive: ?ÑÏû¨ Ï£ºÏ†ú Ï§ëÎã® + ?§Ïùå Ï£ºÏ†úÎ°?
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
                # Task 8-fix: progress ?ÅÏÜç??
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

                is_dive_followup = (
                    state.get("phase") == "dive"
                    and state.get("current_dive_depth", 0) > 1
                )
                msg_role = "agent_followup" if is_dive_followup else "agent_question"

                q_msg = AgentInterviewMessage(
                    id=uuid4(),
                    session_id=session_id,
                    message_index=next_message_index,
                    role=msg_role,
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=0,
                )
                db.add(q_msg)

                # phase/scan_plan/dive_plan ?ÅÏÜç??
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")
                # Task 8-fix: progress ?ÅÏÜç??
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
            yield {"event": "error", "data": json.dumps({"error": "Í±¥ÎÑà?∞Í∏∞???§Ìå®?àÏäµ?àÎã§"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/end ----------

@router.post("/api/agent-interview/{session_id}/end")
async def end_interview(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually end interview early. ?ÑÎ°ú???ÖÎç∞?¥Ìä∏ + Î¶¨Ìè¨???ùÏÑ±ÍπåÏ? ?òÌñâ."""
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
        raise HTTPException(404, {"error": "?∏ÏÖò??Ï∞æÏùÑ ???ÜÏäµ?àÎã§"})

    # ?Ä???àÏä§?†Î¶¨ Î≥µÏõê
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history = []
    question_count = 0
    current_q = ""
    for msg in messages:
        if msg.role in ("agent_question", "agent_followup"):
            current_q = msg.content
            if msg.role == "agent_question":
                question_count = msg.question_number or question_count
        elif msg.role == "user_answer" and msg.evaluation:
            conversation_history.append({
                "question": current_q,
                "answer": msg.content,
                "evaluation": msg.evaluation,
                "question_number": msg.question_number,
            })

    # Î¶¨ÏÜå??Î°úÎìú (?ÑÎ°ú???ÖÎç∞?¥Ìä∏ Î∞?Î¶¨Ìè¨???ùÏÑ±??
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

    # ?Ä???¥Ïó≠???ÜÏúºÎ©?Î¶¨Ìè¨???ùÏÑ± Í±¥ÎÑà?Ä (LLM ?∏Ï∂ú ??πÑ + ?òÎ? ?ÜÎäî Î¶¨Ìè¨??Î∞©Ï?)
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
        raise HTTPException(404, {"error": "?∏ÏÖò??Ï∞æÏùÑ ???ÜÏäµ?àÎã§"})

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

    profiles = await search_profile(db, user.id, "Î©¥Ï†ë ??üâ Ï¢ÖÌï©", top_k=20)

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

