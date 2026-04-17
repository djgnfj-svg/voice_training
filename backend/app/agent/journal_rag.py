# backend/app/agent/journal_rag.py
from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import create_embedding

logger = logging.getLogger(__name__)

TOP_K = 10
SIMILARITY_THRESHOLD = 0.85


async def search_journal(
    db: AsyncSession,
    user_id: str,
    query: str,
    top_k: int = TOP_K,
    category: str | None = None,
    since_date: date | None = None,
) -> list[dict]:
    """Search journal embeddings by cosine similarity."""
    query_embedding = await create_embedding(query)
    embedding_str = "[" + ",".join(str(v) for v in query_embedding) + "]"

    conditions = ['"userId" = :user_id']
    params: dict = {"user_id": user_id, "embedding": embedding_str, "top_k": top_k}

    if category:
        conditions.append("category = :category")
        params["category"] = category

    if since_date:
        conditions.append('"createdAt" >= :since_date')
        params["since_date"] = since_date

    # SAFETY: conditions contains only hardcoded SQL fragments (e.g. "category = :category").
    # All values are passed via the parameterized `params` dict — never append
    # user-supplied strings directly to conditions.
    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT id, category, content, metadata,
                   1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM journal_embeddings
            WHERE {where_clause}
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """),
        params,
    )
    rows = result.fetchall()
    return [
        {
            "id": str(row.id),
            "category": row.category,
            "content": row.content,
            "metadata": row.metadata,
            "similarity": round(row.similarity, 4),
        }
        for row in rows
    ]


async def upsert_journal_embedding(
    db: AsyncSession,
    user_id: str,
    category: str,
    content: str,
    metadata: dict | None = None,
) -> str:
    """Upsert a journal embedding. If similar entry exists (>=0.85), update it."""
    embedding = await create_embedding(content)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    result = await db.execute(
        text("""
            SELECT id, 1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM journal_embeddings
            WHERE "userId" = :user_id AND category = :category
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT 1
        """),
        {"user_id": user_id, "embedding": embedding_str, "category": category},
    )
    existing = result.fetchone()

    meta_json = json.dumps(metadata or {})

    if existing and existing.similarity >= SIMILARITY_THRESHOLD:
        await db.execute(
            text("""
                UPDATE journal_embeddings
                SET content = :content, embedding = CAST(:embedding AS vector),
                    metadata = :metadata, "updatedAt" = NOW()
                WHERE id = :id
            """),
            {
                "id": str(existing.id),
                "content": content,
                "embedding": embedding_str,
                "metadata": meta_json,
            },
        )
        await db.commit()
        return str(existing.id)
    else:
        new_id = str(uuid4())
        await db.execute(
            text("""
                INSERT INTO journal_embeddings (id, "userId", category, content, embedding, metadata)
                VALUES (:id, :user_id, :category, :content, CAST(:embedding AS vector), :metadata)
            """),
            {
                "id": new_id,
                "user_id": user_id,
                "category": category,
                "content": content,
                "embedding": embedding_str,
                "metadata": meta_json,
            },
        )
        await db.commit()
        return new_id


async def search_past_context(
    db: AsyncSession,
    user_id: str,
    query: str,
    days: int = 30,
    top_k: int = 5,
) -> list[dict]:
    """Search journal embeddings from the past N days by similarity."""
    since = date.today() - timedelta(days=days)
    return await search_journal(db, user_id, query, top_k=top_k, since_date=since)
