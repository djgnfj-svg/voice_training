from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_admin_user
from app.lib.llm_client import call_llm_stream
from app.models.resume import Resume
from app.prompts.cunning import build_cunning_suggest_prompt

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------- Schemas ----------

class ConversationEntry(BaseModel):
    question: str
    answer: str


class CunningSuggestRequest(BaseModel):
    resumeId: str
    question: str = Field(min_length=1)
    jobPostingText: str | None = None
    conversationHistory: list[ConversationEntry] | None = None


# ---------- POST /api/cunning/suggest ----------

@router.post("/api/cunning/suggest")
async def cunning_suggest(
    body: CunningSuggestRequest,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify resume
    result = await db.execute(
        select(Resume).where(Resume.id == body.resumeId, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(404, {"error": "이력서를 찾을 수 없습니다"})

    parsed_resume = (
        resume.parsed_data
        if isinstance(resume.parsed_data, str)
        else json.dumps(resume.parsed_data, indent=2, ensure_ascii=False)
    )

    history = (
        [{"question": e.question, "answer": e.answer} for e in body.conversationHistory]
        if body.conversationHistory
        else None
    )

    prompts = build_cunning_suggest_prompt(
        parsed_resume,
        body.question,
        job_posting_text=body.jobPostingText,
        conversation_history=history,
    )

    async def event_generator():
        try:
            async for delta in call_llm_stream(
                prompts["user"],
                system=prompts["system"],
                max_tokens=512,
                temperature=0.7,
            ):
                yield {"data": json.dumps({"text": delta})}
            yield {"data": "[DONE]"}
        except Exception as e:
            logger.error("Cunning suggest streaming error: %s", e)
            yield {"data": json.dumps({"error": "\ub2f5\ubcc0 \uc0dd\uc131 \uc911 \uc624\ub958\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4"})}

    return EventSourceResponse(event_generator())
