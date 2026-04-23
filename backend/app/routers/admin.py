from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_admin_user

router = APIRouter()


# ---------- nightly-study RAG/Seed test ----------

class NsTestSearchBody(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    category: str | None = None  # misconception | explanation | connection | question


@router.post("/api/admin/ns-test/search")
async def ns_test_search(
    body: NsTestSearchBody,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    from app.agent.learning_coach.learning_memory import search_learning_memory
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
    from app.agent.learning_coach.learning_memory import insert_learning_memory
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
    """Generate seed curriculum as JSON without DB insert."""
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
