# backend/app/agent/profile_agent.py
from __future__ import annotations

import json
import logging
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import create_embedding
from app.config import settings
from app.lib.llm_client import call_llm_json

logger = logging.getLogger(__name__)

TOP_K = 10
SIMILARITY_THRESHOLD = 0.85


async def search_profile(
    db: AsyncSession,
    user_id: str,
    query: str,
    top_k: int = TOP_K,
) -> list[dict]:
    """Search user profile embeddings by cosine similarity."""
    query_embedding = await create_embedding(query)
    embedding_str = "[" + ",".join(str(v) for v in query_embedding) + "]"

    result = await db.execute(
        text("""
            SELECT id, category, content, metadata,
                   1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM user_profile_embeddings
            WHERE "userId" = :user_id
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """),
        {"user_id": user_id, "embedding": embedding_str, "top_k": top_k},
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


async def update_profile(
    db: AsyncSession,
    user_id: str,
    category: str,
    content: str,
    metadata: dict | None = None,
) -> str:
    """Upsert a profile embedding. If similar entry exists (>0.85), update it."""
    embedding = await create_embedding(content)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    # Check for similar existing entry
    result = await db.execute(
        text("""
            SELECT id, 1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM user_profile_embeddings
            WHERE "userId" = :user_id AND category = :category
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT 1
        """),
        {"user_id": user_id, "embedding": embedding_str, "category": category},
    )
    existing = result.fetchone()

    if existing and existing.similarity >= SIMILARITY_THRESHOLD:
        # Update existing
        await db.execute(
            text("""
                UPDATE user_profile_embeddings
                SET content = :content, embedding = CAST(:embedding AS vector),
                    metadata = :metadata, "updatedAt" = NOW()
                WHERE id = :id
            """),
            {
                "id": str(existing.id),
                "content": content,
                "embedding": embedding_str,
                "metadata": json.dumps(metadata or {}),
            },
        )
        await db.commit()
        return str(existing.id)
    else:
        # Insert new
        new_id = str(uuid4())
        await db.execute(
            text("""
                INSERT INTO user_profile_embeddings (id, "userId", category, content, embedding, metadata)
                VALUES (:id, :user_id, :category, :content, CAST(:embedding AS vector), :metadata)
            """),
            {
                "id": new_id,
                "user_id": user_id,
                "category": category,
                "content": content,
                "embedding": embedding_str,
                "metadata": json.dumps(metadata or {}),
            },
        )
        await db.commit()
        return new_id


async def load_user_profile(
    db: AsyncSession,
    user_id: str,
    resume_data: dict,
    job_posting_data: dict | None = None,
) -> dict:
    """Load user profile for interview start. Searches RAG with resume/job context."""
    search_parts = []
    if isinstance(resume_data, dict):
        skills = resume_data.get("skills", [])
        if skills:
            search_parts.append("湲곗닠: " + ", ".join(skills[:10]))
        projects = resume_data.get("projects", [])
        if projects:
            search_parts.append("?꾨줈?앺듃: " + ", ".join(p.get("name", "") for p in projects[:3]))
    if job_posting_data and isinstance(job_posting_data, dict):
        position = job_posting_data.get("position", "")
        if position:
            search_parts.append("?ъ??? " + position)

    query = " ".join(search_parts) if search_parts else "硫댁젒 以鍮?湲곗닠 ??웾"

    profiles = await search_profile(db, user_id, query)

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


async def save_session_insights(
    db: AsyncSession,
    user_id: str,
    conversation_history: list[dict],
    session_id: str,
) -> None:
    """Analyze session results and save new insights to profile RAG."""
    if not conversation_history:
        return

    summary_parts = []
    for entry in conversation_history:
        if entry.get("question") and entry.get("evaluation"):
            score = entry["evaluation"].get("overall_score", 0) or entry["evaluation"].get("overallScore", 0)
            summary_parts.append(
                f"吏덈Ц: {entry['question']}\n?먯닔: {score}\n?쇰뱶諛? {entry['evaluation'].get('briefFeedback', '')}"
            )

    if not summary_parts:
        return

    summary = "\n---\n".join(summary_parts)

    prompt = f"""?ㅼ쓬 硫댁젒 ?몄뀡 寃곌낵瑜?遺꾩꽍?섏뿬 ???ъ슜?먯쓽 ?꾨줈???몄궗?댄듃瑜?異붿텧?섏꽭??

<session_results>
{summary}
</session_results>

?ㅼ쓬 JSON ?뺤떇?쇰줈 諛섑솚?섏꽭??
{{
  "strengths": ["媛뺤젏 1", "媛뺤젏 2"],
  "weaknesses": ["?쎌젏 1", "?쎌젏 2"],
  "patterns": ["?⑦꽩 1"]
}}

- 媛???ぉ? 援ъ껜?곸씠怨?湲곗닠?곸쑝濡??묒꽦 (?? "React useState/useReducer ?ㅻ챸???뺥솗?섍퀬 ?ㅻТ ?щ? ?띾?")
- ?대쾲 ?몄뀡?먯꽌 ?덈줈 諛쒓껄??寃껊쭔 ?ы븿
- ?대떦 移댄뀒怨좊━???몄궗?댄듃媛 ?놁쑝硫?鍮?諛곗뿴
"""

    try:
        insights = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)
    except Exception:
        logger.exception("Failed to extract session insights")
        return

    metadata = {"session_id": session_id}

    for strength in insights.get("strengths", []):
        if strength.strip():
            await update_profile(db, user_id, "strength", strength.strip(), metadata)

    for weakness in insights.get("weaknesses", []):
        if weakness.strip():
            await update_profile(db, user_id, "weakness", weakness.strip(), metadata)

    for pattern in insights.get("patterns", []):
        if pattern.strip():
            await update_profile(db, user_id, "pattern", pattern.strip(), metadata)
