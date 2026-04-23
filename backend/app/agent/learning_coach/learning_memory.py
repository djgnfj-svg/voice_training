from __future__ import annotations

import json
import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import create_embedding

logger = logging.getLogger(__name__)

TOP_K = 3


async def search_learning_memory(
    db: AsyncSession,
    user_id: str,
    query: str,
    top_k: int = TOP_K,
    category: Optional[str] = None,
    node_id: Optional[str] = None,
) -> list[dict]:
    """Cosine similarity search on learning_embeddings."""
    embedding = await create_embedding(query)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    conditions = ["user_id = :user_id"]
    params: dict = {"user_id": user_id, "embedding": embedding_str, "top_k": top_k}

    if category:
        conditions.append("category = :category")
        params["category"] = category
    if node_id:
        conditions.append("node_id = :node_id")
        params["node_id"] = node_id

    # SAFETY: conditions contains only hardcoded SQL fragments (e.g. "category = :category").
    # All values are passed via the parameterized `params` dict; never append
    # user-supplied strings directly to conditions.
    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT id, category, content, metadata,
                   1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM learning_embeddings
            WHERE {where_clause}
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """),
        params,
    )
    return [
        {
            "id": str(row.id),
            "category": row.category,
            "content": row.content,
            "metadata": row.metadata,
            "similarity": round(row.similarity, 4),
        }
        for row in result.fetchall()
    ]


async def insert_learning_memory(
    db: AsyncSession,
    user_id: str,
    category: str,
    content: str,
    node_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> str:
    """Insert a new learning_embedding row. Returns row id."""
    embedding = await create_embedding(content)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    result = await db.execute(
        text("""
            INSERT INTO learning_embeddings (user_id, node_id, category, content, embedding, metadata)
            VALUES (:user_id, :node_id, :category, :content, CAST(:embedding AS vector), CAST(:metadata AS jsonb))
            RETURNING id
        """),
        {
            "user_id": user_id,
            "node_id": node_id,
            "category": category,
            "content": content,
            "embedding": embedding_str,
            "metadata": json.dumps(metadata or {}),
        },
    )
    row = result.one()
    await db.commit()
    return str(row.id)
