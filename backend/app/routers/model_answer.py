from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.resume import Resume

logger = logging.getLogger(__name__)

router = APIRouter()


class ModelAnswerRequest(BaseModel):
    resumeId: str
    jobPostingText: str | None = None


@router.post("/api/model-answer/generate")
async def generate_model_answer(
    body: ModelAnswerRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.credit import (
        can_start_session,
        deduct_for_feature,
        CREDIT_COSTS,
        InsufficientCreditsError,
    )
    from app.services.question import plan_interview
    from app.lib.anthropic_client import call_llm_json, MODELS
    from app.prompts.model_answer import (
        MODEL_ANSWER_RESUME_PROMPT,
        MODEL_ANSWER_WITH_JOB_PROMPT,
    )
    from app.models.activity import ActivityLog, ActivityItem
    from uuid import uuid4

    if not body.resumeId:
        raise HTTPException(400, "resumeId is required")

    # Verify resume
    res = await db.execute(
        select(Resume).where(Resume.id == body.resumeId, Resume.user_id == user.id)
    )
    resume = res.scalar_one_or_none()
    if not resume:
        raise HTTPException(404, "Resume not found")

    # Check credits
    credit_check = await can_start_session(db, user.id)
    if not credit_check["allowed"]:
        raise HTTPException(
            402, {"error": "INSUFFICIENT_CREDITS", "code": "INSUFFICIENT_CREDITS"}
        )

    # Plan
    plan = await plan_interview(db, resume_id=body.resumeId, user_id=user.id)

    # Build prompt
    parsed_resume = (
        json.dumps(resume.parsed_data, ensure_ascii=False)
        if resume.parsed_data
        else ""
    )

    if body.jobPostingText:
        prompt = MODEL_ANSWER_WITH_JOB_PROMPT.format(
            interviewType=plan.get("type", "TECHNICAL"),
            categories=", ".join(plan.get("categories", [])),
            difficulty=plan.get("difficulty", "INTERMEDIATE"),
            totalQuestions=plan.get("totalQuestions", 5),
            parsedResume=parsed_resume,
            jobPostingText=body.jobPostingText,
        )
    else:
        prompt = MODEL_ANSWER_RESUME_PROMPT.format(
            interviewType=plan.get("type", "TECHNICAL"),
            categories=", ".join(plan.get("categories", [])),
            difficulty=plan.get("difficulty", "INTERMEDIATE"),
            totalQuestions=plan.get("totalQuestions", 5),
            parsedResume=parsed_resume,
        )

    # Call Claude
    try:
        result = await call_llm_json(
            prompt, model=MODELS["QUESTION_GEN"], max_tokens=8192, temperature=0.7
        )
        questions = result.get("questions", [])
    except Exception:
        raise HTTPException(500, "AI 생성에 실패했습니다")

    # Deduct credits
    using_free_trial = credit_check["usingFreeTrial"]
    if not using_free_trial:
        try:
            await deduct_for_feature(
                db,
                user.id,
                str(uuid4()),
                "모범답안 생성",
                CREDIT_COSTS["MODEL_ANSWER"],
                "SESSION_DEBIT",
            )
        except InsufficientCreditsError:
            raise HTTPException(
                402,
                {"error": "INSUFFICIENT_CREDITS", "code": "INSUFFICIENT_CREDITS"},
            )
    else:
        # Mark free trial used — 조건부 UPDATE로 동시 요청 방어
        from sqlalchemy import update as sql_update
        from app.models.user import User

        result = await db.execute(
            sql_update(User)
            .where(User.id == user.id, User.free_trial_used == False)  # noqa: E712
            .values(free_trial_used=True)
        )
        if result.rowcount == 0:
            raise HTTPException(
                402, {"error": "FREE_TRIAL_ALREADY_USED", "code": "FREE_TRIAL_ALREADY_USED"}
            )
        await db.commit()

    # Create activity log (non-blocking)
    activity_log_id = None
    try:
        log_id = str(uuid4())
        log = ActivityLog(
            id=log_id, user_id=user.id, type="MODEL_ANSWER", resume_id=body.resumeId
        )
        db.add(log)
        for i, q in enumerate(questions):
            item = ActivityItem(
                id=str(uuid4()),
                activity_log_id=log_id,
                index=i,
                question=q.get("text", ""),
                answer=q.get("modelAnswer", ""),
                extra={
                    "keyPoints": q.get("keyPoints", []),
                    "answerTips": q.get("answerTips", []),
                },
            )
            db.add(item)
        await db.commit()
        activity_log_id = log_id
    except Exception:
        logger.warning("Failed to create activity log for model answer", exc_info=True)

    return {"plan": plan, "questions": questions, "activityLogId": activity_log_id}
