# backend/app/agent/profile_agent.py
from __future__ import annotations

import json
import logging
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import create_embedding
from app.config import settings
from app.lib.anthropic_client import call_llm_json

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
                   1 - (embedding <=> :embedding::vector) AS similarity
            FROM user_profile_embeddings
            WHERE "userId" = :user_id
            ORDER BY embedding <=> :embedding::vector
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
            SELECT id, 1 - (embedding <=> :embedding::vector) AS similarity
            FROM user_profile_embeddings
            WHERE "userId" = :user_id AND category = :category
            ORDER BY embedding <=> :embedding::vector
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
                SET content = :content, embedding = :embedding::vector,
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
                VALUES (:id, :user_id, :category, :content, :embedding::vector, :metadata)
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
            search_parts.append("기술: " + ", ".join(skills[:10]))
        projects = resume_data.get("projects", [])
        if projects:
            search_parts.append("프로젝트: " + ", ".join(p.get("name", "") for p in projects[:3]))
    if job_posting_data and isinstance(job_posting_data, dict):
        position = job_posting_data.get("position", "")
        if position:
            search_parts.append("포지션: " + position)

    query = " ".join(search_parts) if search_parts else "면접 준비 기술 역량"

    profiles = await search_profile(db, user_id, query)

    organized: dict[str, list[str]] = {
        "strengths": [],
        "weaknesses": [],
        "patterns": [],
        "context": [],
    }
    for p in profiles:
        cat = p["category"]
        key = cat + "s" if cat in ("strength", "weakness") else cat + "s"
        if key in organized:
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
                f"질문: {entry['question']}\n점수: {score}\n피드백: {entry['evaluation'].get('briefFeedback', '')}"
            )

    if not summary_parts:
        return

    summary = "\n---\n".join(summary_parts)

    prompt = f"""다음 면접 세션 결과를 분석하여 이 사용자의 프로필 인사이트를 추출하세요.

<session_results>
{summary}
</session_results>

다음 JSON 형식으로 반환하세요:
{{
  "strengths": ["강점 1", "강점 2"],
  "weaknesses": ["약점 1", "약점 2"],
  "patterns": ["패턴 1"]
}}

- 각 항목은 구체적이고 기술적으로 작성 (예: "React useState/useReducer 설명이 정확하고 실무 사례 풍부")
- 이번 세션에서 새로 발견된 것만 포함
- 해당 카테고리에 인사이트가 없으면 빈 배열
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
