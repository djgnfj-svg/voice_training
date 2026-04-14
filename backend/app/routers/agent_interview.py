from __future__ import annotations

import json
import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
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
from app.services.credit import (
    can_start_session,
    deduct_for_agent_session,
    InsufficientCreditsError,
    FreeTrialAlreadyUsedError,
)

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


MIN_ANSWER_CHARS = 10
MIN_UNIQUE_TOKENS = 3


def _is_meaningful_answer(text: str) -> bool:
    """모바일 중복 입력/반복 문자 나열을 막는 의미 있는 답변 가드."""
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
    # Credit gating (before any AI/DB work)
    credit_check = await can_start_session(db, user.id)
    if not credit_check["allowed"]:
        raise HTTPException(
            402, {"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"}
        )
    using_free_trial = credit_check["usingFreeTrial"]

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

    # Free trial: cap questions to 3 (consistent with /api/interview/setup)
    effective_max_questions = min(body.maxQuestions, 3) if using_free_trial else body.maxQuestions

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

            # Fit Analysis 영속화 — answer/skip 흐름에서 재사용 (Spec 4.2(b))
            session.fit_analysis = state.get("fit_analysis")

            # Scan 플랜 확정 후 첫 질문 생성
            state = await nodes.build_scan_plan_node(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            session.phase = state.get("phase")
            session.scan_plan = state.get("scan_plan")
            session.dive_plan = state.get("dive_plan")

            state = await nodes.scan_ask(state, db)

            # AI 질문 생성 성공 → 크레딧 차감 (실패 시 세션 폐기 + 에러 반환)
            try:
                await deduct_for_agent_session(db, user.id, session_id, using_free_trial)
            except (InsufficientCreditsError, FreeTrialAlreadyUsedError):
                await db.rollback()
                await db.execute(
                    delete(AgentInterviewSession).where(
                        AgentInterviewSession.id == session_id
                    )
                )
                await db.commit()
                yield {
                    "event": "error",
                    "data": json.dumps({
                        "error": "크레딧이 부족합니다",
                        "code": "INSUFFICIENT_CREDITS",
                    }),
                }
                return
            except Exception:
                logger.exception("Credit deduction failed for agent session %s", session_id)
                await db.rollback()
                await db.execute(
                    delete(AgentInterviewSession).where(
                        AgentInterviewSession.id == session_id
                    )
                )
                await db.commit()
                yield {
                    "event": "error",
                    "data": json.dumps({"error": "크레딧 차감에 실패했습니다"}),
                }
                return

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
    # 답변 품질 가드 (프론트 우회 방어)
    if not _is_meaningful_answer(body.answer):
        raise HTTPException(
            400,
            {"error": '답변이 너무 짧거나 반복됩니다. 조금 더 말씀해 주시거나 "건너뛰기"를 눌러주세요.'},
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
        raise HTTPException(400, {"error": "진행 중인 질문이 없습니다"})

    current_question = last_question_msg.content
    question_count = last_question_msg.question_number or 1

    # Rebuild profile from RAG
    from app.agent.profile_agent import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    # 이력서 RAG / Fit Analysis 컨텍스트 복원 (Spec 4.2(b))
    from app.agent.resume_rag import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False

    # Scan/Dive 페이즈 컨텍스트 복원 (Task 8)
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []

    # scan_evaluations 복원: conversation_history 앞부분 scan_plan 길이만큼
    scan_evaluations = [
        h["evaluation"] for h in conversation_history[:len(scan_plan)] if h.get("evaluation")
    ]
    current_scan_idx = min(len(scan_evaluations), len(scan_plan))

    # dive 진행 상태 복원 (주제당 최대 3질문, 순차 진행 가정)
    current_dive_idx = 0
    current_dive_depth = 0
    if phase == "dive" and dive_plan:
        dive_history = conversation_history[len(scan_plan):]
        topic_idx = 0
        topic_depth = 0
        for entry in dive_history:
            topic_depth += 1
            ev = entry.get("evaluation") or {}
            depth_score = (ev.get("scores") or {}).get("depth", 0)
            if topic_depth >= 3 or (topic_depth >= 2 and depth_score >= 70):
                topic_idx += 1
                topic_depth = 0
                if topic_idx >= len(dive_plan):
                    break
        current_dive_idx = topic_idx
        current_dive_depth = topic_depth

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

            # Agent loop: plan → action → plan → ... → decide
            state = await nodes.agent_loop(state, db)

            # Flush all pending events
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Update answer message with evaluation
            answer_msg.evaluation = state["current_evaluation"]

            # Handle post-decide state — Scan+Dive 구조에서 next_action은
            # scan_ask / dive_ask / build_dive_plan / end 중 하나
            action = state.get("next_action", "end")

            if action in ("scan_ask", "dive_ask", "build_dive_plan"):
                # 딥다이브 depth>=2 질문은 agent_followup, 나머지는 agent_question
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

                # phase/scan_plan/dive_plan 영속화
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")

            else:  # end
                session.status = "completed"
                session.total_questions = state["question_count"]
                session.report_data = state.get("overall_report")
                if state.get("overall_report"):
                    session.overall_score = state["overall_report"].get("overallScore")
                session.phase = "done"

            await db.commit()

            # 프론트 호환: 내부 action(scan_ask/dive_ask/build_dive_plan) → "next_question"
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
            })

    max_questions = session.max_questions or 7

    # 이력서 RAG / Fit Analysis 컨텍스트 복원 (Spec 4.2(b))
    from app.agent.resume_rag import has_resume_embeddings as _has_emb
    has_emb = await _has_emb(db, session.resume_id) if session.resume_id else False
    persisted_fit = session.fit_analysis

    # Scan/Dive 페이즈 컨텍스트 복원
    phase = session.phase or "scan"
    scan_plan = session.scan_plan or []
    dive_plan = session.dive_plan or []

    scan_evaluations = [
        h["evaluation"] for h in conversation_history[:len(scan_plan)] if h.get("evaluation")
    ]
    current_scan_idx = min(len(scan_evaluations), len(scan_plan))

    current_dive_idx = 0
    current_dive_depth = 0
    if phase == "dive" and dive_plan:
        dive_history = conversation_history[len(scan_plan):]
        topic_idx = 0
        topic_depth = 0
        for entry in dive_history:
            topic_depth += 1
            ev = entry.get("evaluation") or {}
            depth_score = (ev.get("scores") or {}).get("depth", 0)
            if topic_depth >= 3 or (topic_depth >= 2 and depth_score >= 70):
                topic_idx += 1
                topic_depth = 0
                if topic_idx >= len(dive_plan):
                    break
        current_dive_idx = topic_idx
        current_dive_depth = topic_depth

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
                # 페이즈별 skip 처리
                if phase == "scan":
                    # scan: dummy eval push, idx++
                    new_scan_idx = current_scan_idx + 1
                    state["scan_evaluations"] = scan_evaluations + [{"scores": {"depth": 0}}]
                    state["current_scan_idx"] = new_scan_idx
                    if new_scan_idx >= len(scan_plan):
                        # 훑기 소진 → dive 전환
                        state = await nodes.build_dive_plan_node(state, db)
                        if not state.get("dive_plan"):
                            # dive_plan 비어있으면 종료
                            should_end = True
                        else:
                            state = await nodes.dive_ask(state, db)
                    else:
                        state = await nodes.scan_ask(state, db)
                else:
                    # dive: 현재 주제 중단 + 다음 주제로
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

                # phase/scan_plan/dive_plan 영속화
                session.phase = state.get("phase")
                session.scan_plan = state.get("scan_plan")
                session.dive_plan = state.get("dive_plan")

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
            yield {"event": "error", "data": json.dumps({"error": "건너뛰기에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/end ----------

@router.post("/api/agent-interview/{session_id}/end")
async def end_interview(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually end interview early. 프로필 업데이트 + 리포트 생성까지 수행."""
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

    # 대화 히스토리 복원
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

    # 리소스 로드 (프로필 업데이트 및 리포트 생성용)
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

    from app.agent.profile_agent import load_user_profile
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

    # 대화 내역이 없으면 리포트 생성 건너뜀 (LLM 호출 낭비 + 의미 없는 리포트 방지)
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
