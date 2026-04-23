from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import logging

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.interview import InterviewSession, InterviewAnswer
from app.models.resume import Resume
from app.models.enums import SessionStatus

logger = logging.getLogger(__name__)

router = APIRouter()


# --- POST /api/interview/setup ---
class SetupRequest(BaseModel):
    resumeId: str
    jobPostingId: str | None = None
    deepMode: bool = False
    mode: str | None = None  # 'standard' or 'deep'
    textMode: bool = False


@router.post("/api/interview/setup")
async def setup_interview(
    body: SetupRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.question import plan_interview, generate_questions
    from uuid import uuid4

    deep_mode = body.deepMode or body.mode == "deep"

    # Verify resume
    res = await db.execute(
        select(Resume).where(Resume.id == body.resumeId, Resume.user_id == user.id)
    )
    resume = res.scalar_one_or_none()
    if not resume:
        raise HTTPException(404, {"error": "?대젰?쒕? 李얠쓣 ???놁뒿?덈떎"})

    try:
        plan = await plan_interview(
            db, resume_id=body.resumeId, job_posting_id=body.jobPostingId,
            user_id=user.id, deep_mode=deep_mode,
        )
        questions = await generate_questions(
            db,
            type_=plan.get("type", "TECHNICAL"),
            categories=plan.get("categories", []),
            difficulty=plan.get("difficulty", "INTERMEDIATE"),
            total_questions=plan.get("totalQuestions", 5),
            resume_id=body.resumeId,
            user_id=user.id,
            job_posting_id=body.jobPostingId,
            deep_mode=deep_mode,
        )
    except ValueError as e:
        logger.warning("Interview setup validation error: %s", e)
        if "not found" in str(e).lower():
            raise HTTPException(404, {"error": "요청한 리소스를 찾을 수 없습니다"})
        raise HTTPException(400, {"error": "잘못된 요청입니다"})

    # Create session
    session_id = str(uuid4())
    session = InterviewSession(
        id=session_id,
        user_id=user.id,
        resume_id=body.resumeId,
        job_posting_id=body.jobPostingId,
        type=plan.get("type", "TECHNICAL"),
        categories=plan.get("categories", []),
        difficulty=plan.get("difficulty", "INTERMEDIATE"),
        total_questions=len(questions),
        status="IN_PROGRESS",
        text_mode=body.textMode,
    )
    db.add(session)

    # Pre-create answer records
    for q in questions:
        answer = InterviewAnswer(
            id=str(uuid4()),
            session_id=session_id,
            question_index=q.get("index", 0),
            question_text=q.get("text", ""),
            question_source=q.get("source", "general"),
            category=q.get("category"),
            difficulty=q.get("difficulty"),
        )
        db.add(answer)

    await db.commit()

    return {"sessionId": session_id, "plan": plan, "questions": questions}


# --- GET /api/interview/in-progress ---
@router.get("/api/interview/in-progress")
async def get_in_progress(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cutoff = datetime.utcnow() - timedelta(hours=24)
    result = await db.execute(
        select(InterviewSession)
        .where(
            InterviewSession.user_id == user.id,
            InterviewSession.status == SessionStatus.IN_PROGRESS,
            InterviewSession.created_at >= cutoff,
        )
        .order_by(InterviewSession.created_at.desc())
        .limit(1)
    )
    session = result.scalar_one_or_none()
    if not session:
        return {"session": None}

    # Count answered
    count_res = await db.execute(
        select(func.count()).where(
            InterviewAnswer.session_id == session.id,
            InterviewAnswer.answer_transcript.isnot(None),
        )
    )
    answered = count_res.scalar() or 0

    return {
        "session": {
            "id": session.id,
            "type": session.type,
            "totalQuestions": session.total_questions,
            "answeredCount": answered,
            "createdAt": session.created_at.isoformat()
            if session.created_at
            else None,
        }
    }


# --- GET /api/interview/{session_id}/questions ---
@router.get("/api/interview/{session_id}/questions")
async def get_questions(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(InterviewSession)
        .options(selectinload(InterviewSession.answers))
        .where(
            InterviewSession.id == session_id,
            InterviewSession.user_id == user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})

    deep_mode = any(a.question_source == "deep_technical" for a in session.answers)

    questions = []
    for a in sorted(session.answers, key=lambda x: x.question_index):
        q: dict = {
            "index": a.question_index,
            "text": a.question_text,
            "source": a.question_source,
            "category": a.category or (session.categories[0] if session.categories else "general"),
            "difficulty": a.difficulty or session.difficulty or "INTERMEDIATE",
        }
        if a.answer_transcript is not None:
            q["answer"] = {
                "answerTranscript": a.answer_transcript,
                "overallScore": a.overall_score,
                "briefFeedback": a.brief_feedback,
                "detailedFeedback": a.detailed_feedback,
                "modelAnswer": a.model_answer,
                "followUpQuestion": a.follow_up_question,
                "scores": a.scores,
                "responseTimeSec": a.response_time_sec,
                "audioUrl": a.audio_url,
            }
        questions.append(q)

    return {
        "questions": questions,
        "sessionStatus": session.status,
        "interviewType": session.type,
        "deepMode": deep_mode,
        "textMode": session.text_mode or False,
    }


# --- GET /api/interview/{session_id}/practice ---
@router.get("/api/interview/{session_id}/practice")
async def get_practice(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(InterviewSession)
        .options(selectinload(InterviewSession.answers))
        .where(
            InterviewSession.id == session_id,
            InterviewSession.user_id == user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})
    if session.status != SessionStatus.COMPLETED:
        raise HTTPException(400, {"error": "세션이 아직 완료되지 않았습니다"})

    answers = [
        {
            "questionIndex": a.question_index,
            "questionText": a.question_text,
            "questionSource": a.question_source,
            "answerTranscript": a.answer_transcript,
            "modelAnswer": a.model_answer,
            "overallScore": a.overall_score,
            "briefFeedback": a.brief_feedback,
        }
        for a in sorted(session.answers, key=lambda x: x.question_index)
    ]

    return {
        "sessionId": session.id,
        "type": session.type,
        "categories": session.categories,
        "difficulty": session.difficulty,
        "answers": answers,
    }


# --- POST /api/interview/evaluate ---
class EvaluateRequest(BaseModel):
    sessionId: str
    questionIndex: int
    answerTranscript: str
    responseTimeSec: int | None = None
    deepMode: bool = False
    relatedKeyPoints: list[str] | None = None


@router.post("/api/interview/evaluate")
async def evaluate_answer(
    body: EvaluateRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.evaluation import evaluate_answer as eval_answer

    try:
        result = await eval_answer(
            db,
            session_id=body.sessionId,
            question_index=body.questionIndex,
            answer_transcript=body.answerTranscript,
            user_id=user.id,
            response_time_sec=body.responseTimeSec,
            deep_mode=body.deepMode,
            related_key_points=body.relatedKeyPoints,
        )
        return result
    except ValueError as e:
        logger.warning(f"Evaluate answer validation error: {e}")
        if "not found" in str(e).lower():
            raise HTTPException(404, {"error": "요청한 리소스를 찾을 수 없습니다"})
        raise HTTPException(400, {"error": "잘못된 요청입니다"})
    except Exception as e:
        logger.exception("Failed to evaluate answer")
        raise HTTPException(500, {"error": "泥섎━ 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎"})


# --- POST /api/interview/practice-evaluate ---
class PracticeEvaluateRequest(BaseModel):
    questionText: str = Field(min_length=1)
    answerTranscript: str = Field(min_length=1)
    interviewType: str
    deepMode: bool = False
    relatedKeyPoints: list[str] | None = None
    previousContext: dict | None = None
    sessionId: str | None = None


@router.post("/api/interview/practice-evaluate")
async def practice_evaluate(
    body: PracticeEvaluateRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.evaluation import evaluate_stateless

    result = await evaluate_stateless(
        question_text=body.questionText,
        answer_transcript=body.answerTranscript,
        interview_type=body.interviewType,
        deep_mode=body.deepMode,
        related_key_points=body.relatedKeyPoints,
        previous_context=body.previousContext,
    )

    return result


# --- POST /api/interview/{session_id}/complete ---
@router.post("/api/interview/{session_id}/complete")
async def complete_interview(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.report import generate_report

    result = await db.execute(
        select(InterviewSession).where(
            InterviewSession.id == session_id,
            InterviewSession.user_id == user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})

    session.status = SessionStatus.COMPLETED
    await db.commit()

    report = await generate_report(db, session_id=session_id, user_id=user.id)
    return report


# --- GET /api/interview/{session_id}/report ---
@router.get("/api/interview/{session_id}/report")
async def get_report(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.report import generate_report

    result = await db.execute(
        select(InterviewSession).where(
            InterviewSession.id == session_id,
            InterviewSession.user_id == user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "?몄뀡??李얠쓣 ???놁뒿?덈떎"})

    if session.report_data:
        return session.report_data

    report = await generate_report(db, session_id=session_id, user_id=user.id)
    return report


