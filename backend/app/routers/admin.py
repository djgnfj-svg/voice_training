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


# ---------- nightly-study RAG/Seed 테스트 ----------

class NsTestSearchBody(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    category: str | None = None  # misconception | explanation | connection | question


@router.post("/api/admin/ns-test/search")
async def ns_test_search(
    body: NsTestSearchBody,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    from app.agent.nightly_study.ns_rag import search_learning_memory
    hits = await search_learning_memory(
        db, user_id=user.id, query=body.query,
        top_k=5, category=body.category,
    )
    return {"hits": hits}


class NsTestInsertBody(BaseModel):
    category: str = Field(pattern=r"^(misconception|explanation|connection|question)$")
    content: str = Field(min_length=1, max_length=2000)


@router.post("/api/admin/ns-test/insert")
async def ns_test_insert(
    body: NsTestInsertBody,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    from app.agent.nightly_study.ns_rag import insert_learning_memory
    new_id = await insert_learning_memory(
        db, user_id=user.id, category=body.category, content=body.content,
    )
    return {"id": new_id}


class NsTestSeedBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/api/admin/ns-test/seed-preview")
async def ns_test_seed_preview(
    body: NsTestSeedBody,
    user: AuthUser = Depends(get_admin_user),
):
    """Generate seed curriculum as JSON — no DB insert."""
    from app.lib.llm_client import call_llm_json
    from app.prompts.nightly_study import SEED_CURRICULUM_PROMPT
    prompt = SEED_CURRICULUM_PROMPT.replace("{goal_title}", body.title)
    data = await call_llm_json(prompt)
    return {"goal": body.title, "data": data}


@router.get("/api/admin/ns-test/my-embeddings")
async def ns_test_my_embeddings(
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """List admin's own learning_embeddings (most recent 20)."""
    from sqlalchemy import text
    rows = (await db.execute(
        text("""
            SELECT id, category, content, created_at
            FROM learning_embeddings
            WHERE user_id=:u
            ORDER BY created_at DESC
            LIMIT 20
        """),
        {"u": user.id},
    )).fetchall()
    return {
        "rows": [
            {
                "id": str(r.id),
                "category": r.category,
                "content": r.content,
                "createdAt": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    }
