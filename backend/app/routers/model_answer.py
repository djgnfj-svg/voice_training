from __future__ import annotations

import asyncio
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


def _format_chunks(chunks: list[dict]) -> str:
    """search_resume 결과를 프롬프트용 텍스트로 직렬화."""
    if not chunks:
        return "(이력서 관련 청크 없음)"
    lines = []
    for c in chunks:
        lines.append(f"- [{c['chunk_type']}] {c['content']}")
    return "\n".join(lines)


@router.post("/api/model-answer/generate")
async def generate_model_answer(
    body: ModelAnswerRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.credit import (
        can_start_session,
        deduct_for_feature,
        mark_free_trial_used,
        CREDIT_COSTS,
        InsufficientCreditsError,
        FreeTrialAlreadyUsedError,
    )
    from app.services.question import plan_interview
    from app.lib.llm_client import call_llm_json, MODELS
    from app.agent.interview.resume_rag import has_resume_embeddings, search_resume
    from app.prompts.model_answer import (
        QUESTION_GEN_RESUME_PROMPT,
        QUESTION_GEN_WITH_JOB_PROMPT,
        MODEL_ANSWER_PROMPT,
    )
    from app.models.activity import ActivityLog, ActivityItem
    from uuid import uuid4

    if not body.resumeId:
        raise HTTPException(400, {"error": "이력서 ID가 필요합니다"})

    res = await db.execute(
        select(Resume).where(Resume.id == body.resumeId, Resume.user_id == user.id)
    )
    resume = res.scalar_one_or_none()
    if not resume:
        raise HTTPException(404, {"error": "이력서를 찾을 수 없습니다"})

    credit_check = await can_start_session(db, user.id)
    if not credit_check["allowed"]:
        raise HTTPException(
            402, {"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"}
        )

    plan = await plan_interview(db, resume_id=body.resumeId, user_id=user.id)

    parsed_resume = (
        json.dumps(resume.parsed_data, ensure_ascii=False)
        if resume.parsed_data
        else ""
    )

    # Step 1: 질문 batch 생성
    if body.jobPostingText:
        q_prompt = QUESTION_GEN_WITH_JOB_PROMPT.format(
            interviewType=plan["type"],
            categories=", ".join(plan["categories"]),
            difficulty=plan["difficulty"],
            totalQuestions=plan["totalQuestions"],
            parsedResume=parsed_resume,
            jobPostingText=body.jobPostingText,
        )
    else:
        q_prompt = QUESTION_GEN_RESUME_PROMPT.format(
            interviewType=plan["type"],
            categories=", ".join(plan["categories"]),
            difficulty=plan["difficulty"],
            totalQuestions=plan["totalQuestions"],
            parsedResume=parsed_resume,
        )

    try:
        q_result = await call_llm_json(
            q_prompt, model=MODELS["QUESTION_GEN"], max_tokens=3000, temperature=0.7
        )
        questions = q_result.get("questions", [])
    except Exception:
        logger.exception("model-answer: question batch generation failed")
        raise HTTPException(500, {"error": "AI 생성에 실패했습니다"})

    if not questions:
        raise HTTPException(500, {"error": "AI 생성에 실패했습니다"})

    # Step 2: 모범답안 개별 병렬 생성
    use_rag = await has_resume_embeddings(db, body.resumeId)
    logger.info(
        "model-answer: generating %d answers (rag=%s)", len(questions), use_rag
    )

    job_block = (
        f"## 채용공고\n{body.jobPostingText}\n" if body.jobPostingText else ""
    )

    async def _gen_answer(q: dict) -> dict | None:
        try:
            if use_rag:
                chunks = await search_resume(
                    db, user.id, body.resumeId, query=q.get("text", ""), top_k=3
                )
                resume_context = _format_chunks(chunks)
            else:
                resume_context = parsed_resume or "(이력서 정보 없음)"

            prompt = MODEL_ANSWER_PROMPT.format(
                question=q.get("text", ""),
                category=q.get("category", ""),
                difficulty=q.get("difficulty", plan["difficulty"]),
                resumeContext=resume_context,
                jobPostingBlock=job_block,
            )
            result = await call_llm_json(
                prompt, model=MODELS["QUESTION_GEN"], max_tokens=2048, temperature=0.7
            )
            return {
                **q,
                "modelAnswer": result.get("modelAnswer", ""),
                "keyPoints": result.get("keyPoints", []),
                "answerTips": result.get("answerTips", []),
            }
        except Exception:
            logger.exception("model-answer: answer generation failed for q=%r", q.get("text"))
            return None

    results = await asyncio.gather(*[_gen_answer(q) for q in questions])
    merged = [r for r in results if r is not None and r.get("modelAnswer")]

    if not merged:
        raise HTTPException(500, {"error": "AI 생성에 실패했습니다"})

    # 크레딧 차감
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
                {"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"},
            )
    else:
        try:
            await mark_free_trial_used(db, user.id)
        except FreeTrialAlreadyUsedError:
            raise HTTPException(
                402, {"error": "FREE_TRIAL_ALREADY_USED", "code": "FREE_TRIAL_ALREADY_USED"}
            )

    # ActivityLog
    activity_log_id = None
    try:
        log_id = str(uuid4())
        log = ActivityLog(
            id=log_id, user_id=user.id, type="MODEL_ANSWER", resume_id=body.resumeId
        )
        db.add(log)
        for i, q in enumerate(merged):
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

    return {"plan": plan, "questions": merged, "activityLogId": activity_log_id}
