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
from app.agent.interview import nodes
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
    """紐⑤컮??以묐났 ?낅젰/諛섎났 臾몄옄 ?섏뿴??留됰뒗 ?섎? ?덈뒗 ?듬? 媛??"""
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
        raise HTTPException(404, {"error": "?대젰?쒕? 李얠쓣 ???놁뒿?덈떎"})

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

    # 吏덈Ц ?섎뒗 ?대젰???꾨줈?앺듃/?듬? 源딆씠濡??숈쟻 寃곗젙 (scan 3 + dive 理쒕? 6 = 9).
    # max_questions???곹븳 媛?쒕줈留??ъ슜: 臾대즺泥댄뿕? 3(scan留?, ?쇰컲? 9(scan+dive ?꾩껜).
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

            state = await nodes.load_profile(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            state = await nodes.fit_analysis_node(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Fit Analysis ?곸냽????answer/skip ?먮쫫?먯꽌 ?ъ궗??(Spec 4.2(b))
            session.fit_analysis = state.get("fit_analysis")

            # Scan ?뚮옖 ?뺤젙 ??泥?吏덈Ц ?앹꽦
            state = await nodes.build_scan_plan_node(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            session.phase = state.get("phase")
            session.scan_plan = state.get("scan_plan")
            session.dive_plan = state.get("dive_plan")
            # Task 8-fix: progress 珥덇린??
            session.current_scan_idx = state.get("current_scan_idx", 0)
            session.current_dive_idx = 0
            session.current_dive_depth = 0
            session.scan_evaluations = state.get("scan_evaluations", [])

            state = await nodes.scan_ask(state, db)

            # session ?대깽?몃? question蹂대떎 癒쇱? ?꾩넚 (?꾨줎?몄뿉??sessionId ?꾩슂)
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
            yield {"event": "error", "data": json.dumps({"error": "硫댁젒 ?쒖옉???ㅽ뙣?덉뒿?덈떎"})}

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
    # ?듬? ?덉쭏 媛??(?꾨줎???고쉶 諛⑹뼱)
    if not _is_meaningful_answer(body.answer):
        raise HTTPException(
            400,
            {"error": '?듬????덈Т 吏㏐굅??諛섎났?⑸땲?? 議곌툑 ??留먯???二쇱떆嫄곕굹 "嫄대꼫?곌린"瑜??뚮윭二쇱꽭??'},
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
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})

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
        raise HTTPException(400, {"error": "吏꾪뻾 以묒씤 吏덈Ц???놁뒿?덈떎"})

    current_question = last_question_msg.content
    question_count = last_question_msg.question_number or 1

    # Rebuild profile from RAG
    from app.agent.interview.profile_agent import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    # ?대젰??RAG / Fit Analysis 而⑦뀓?ㅽ듃 蹂듭썝 (Spec 4.2(b))
    from app.agent.interview.resume_rag import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False

    # Scan/Dive ?섏씠利?而⑦뀓?ㅽ듃 蹂듭썝 (Task 8-fix: session?먯꽌 吏곸젒 蹂듭썝)
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []
    current_scan_idx = session.current_scan_idx or 0
    current_dive_idx = session.current_dive_idx or 0
    current_dive_depth = session.current_dive_depth or 0
    scan_evaluations = session.scan_evaluations or []

    # Task 8-fix: ?덇굅???몄뀡(phase=NULL) 諛⑹뼱 ??scan_plan ?놁쑝硫??ъ깮??
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
        tmp_state = await nodes.build_scan_plan_node(tmp_state, db)
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
            state = await nodes.agent_loop(state, db)

            # Flush all pending events
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Update answer message with evaluation
            answer_msg.evaluation = state["current_evaluation"]

            # Handle post-decide state ??Scan+Dive 援ъ“?먯꽌 next_action?
            # scan_ask / dive_ask / build_dive_plan / end 以??섎굹
            action = state.get("next_action", "end")

            if action in ("scan_ask", "dive_ask", "build_dive_plan"):
                # ?λ떎?대툕 depth>=2 吏덈Ц? agent_followup, ?섎㉧吏??agent_question
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

                # phase/scan_plan/dive_plan ?곸냽??
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")
                # Task 8-fix: progress ?곸냽??
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
                # Task 8-fix: progress ?곸냽??
                session.current_scan_idx = state.get("current_scan_idx", 0)
                session.current_dive_idx = state.get("current_dive_idx", 0)
                session.current_dive_depth = state.get("current_dive_depth", 0)

            await db.commit()

            # ?꾨줎???명솚: ?대? action(scan_ask/dive_ask/build_dive_plan) ??"next_question"
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
            yield {"event": "error", "data": json.dumps({"error": "?듬? 泥섎━???ㅽ뙣?덉뒿?덈떎"})}

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
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})

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

    from app.agent.interview.profile_agent import load_user_profile
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

    # ?대젰??RAG / Fit Analysis 而⑦뀓?ㅽ듃 蹂듭썝 (Spec 4.2(b))
    from app.agent.interview.resume_rag import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False
    persisted_fit = session.fit_analysis

    # Task 8-fix: Scan/Dive progress 吏곸젒 蹂듭썝 (?대━?ㅽ떛 ?쒓굅)
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []
    current_scan_idx = session.current_scan_idx or 0
    current_dive_idx = session.current_dive_idx or 0
    current_dive_depth = session.current_dive_depth or 0
    scan_evaluations = session.scan_evaluations or []

    # Task 8-fix: ?덇굅???몄뀡(phase=NULL) 諛⑹뼱 ??scan_plan ?놁쑝硫??ъ깮??
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
        tmp_state = await nodes.build_scan_plan_node(tmp_state, db)
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
                content="(嫄대꼫?)",
                question_number=question_count,
                follow_up_round=0,
            )
            db.add(skip_msg)
            next_message_index += 1

            # 怨듯넻 state 鍮뚮뱶
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
                # ?섏씠利덈퀎 skip 泥섎━
                if phase == "scan":
                    # scan: dummy eval push, idx++
                    new_scan_idx = current_scan_idx + 1
                    state["scan_evaluations"] = scan_evaluations + [{"scores": {"depth": 0}}]
                    state["current_scan_idx"] = new_scan_idx
                    if new_scan_idx >= len(scan_plan):
                        # ?묎린 ?뚯쭊 ??dive ?꾪솚
                        state = await nodes.build_dive_plan_node(state, db)
                        if not state.get("dive_plan"):
                            # dive_plan 鍮꾩뼱?덉쑝硫?醫낅즺
                            should_end = True
                        else:
                            state = await nodes.dive_ask(state, db)
                    else:
                        state = await nodes.scan_ask(state, db)
                else:
                    # dive: ?꾩옱 二쇱젣 以묐떒 + ?ㅼ쓬 二쇱젣濡?
                    new_dive_idx = current_dive_idx + 1
                    if new_dive_idx >= len(dive_plan):
                        should_end = True
                    else:
                        state["current_dive_idx"] = new_dive_idx
                        state["current_dive_depth"] = 0
                        state = await nodes.dive_ask(state, db)

            if should_end:
                state["next_action"] = "end"
                state = await nodes.update_profile(state, db)
                state = await nodes.generate_report(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}

                session.status = "completed"
                session.total_questions = state.get("question_count", question_count)
                session.report_data = state.get("overall_report")
                if state.get("overall_report"):
                    session.overall_score = state["overall_report"].get("overallScore")
                session.phase = "done"
                # Task 8-fix: progress ?곸냽??
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

                # phase/scan_plan/dive_plan ?곸냽??
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")
                # Task 8-fix: progress ?곸냽??
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
            yield {"event": "error", "data": json.dumps({"error": "嫄대꼫?곌린???ㅽ뙣?덉뒿?덈떎"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/end ----------

@router.post("/api/agent-interview/{session_id}/end")
async def end_interview(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually end interview early. ?꾨줈???낅뜲?댄듃 + 由ы룷???앹꽦源뚯? ?섑뻾."""
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
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})

    # ????덉뒪?좊━ 蹂듭썝
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

    # 由ъ냼??濡쒕뱶 (?꾨줈???낅뜲?댄듃 諛?由ы룷???앹꽦??
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

    from app.agent.interview.profile_agent import load_user_profile
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

    # ????댁뿭???놁쑝硫?由ы룷???앹꽦 嫄대꼫? (LLM ?몄텧 ??퉬 + ?섎? ?녿뒗 由ы룷??諛⑹?)
    if conversation_history:
        try:
            state = await nodes.update_profile(state, db)
            state = await nodes.generate_report(state, db)
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
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})

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
    from app.agent.interview.profile_agent import search_profile

    profiles = await search_profile(db, user.id, "硫댁젒 ??웾 醫낇빀", top_k=20)

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
    from app.agent.interview.profile_agent import update_profile

    entry_id = await update_profile(
        db,
        user.id,
        "context",
        body.content,
        {"source": "user_input"},
    )
    return {"id": entry_id, "status": "saved"}

