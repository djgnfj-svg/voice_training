# backend/app/agent/journal_extractor.py
from __future__ import annotations

import logging
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm_json
from app.config import settings
from app.prompts.journal import EXTRACTOR_PROMPT
from app.agent.journal_rag import upsert_journal_embedding

logger = logging.getLogger(__name__)

VALID_CATEGORIES = {"emotion", "event", "growth", "concern", "relationship", "goal"}
MAX_MESSAGES_FOR_EXTRACTION = 40


async def extract_and_save(
    db: AsyncSession,
    user_id: str,
    session_id: str,
    messages: list[dict],
) -> int:
    """Extract long-term insights from an entire session and save to RAG.

    Called once at session end (not per message) so the LLM sees full context
    and can judge importance across the whole conversation.
    Returns number of items saved.
    """
    if not messages:
        return 0

    tail = messages[-MAX_MESSAGES_FOR_EXTRACTION:]
    conversation = ""
    for m in tail:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        conversation += f"{role_label}: {m.get('content', '')}\n"

    prompt = EXTRACTOR_PROMPT.format(conversation=conversation)

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.2)
    except Exception:
        logger.exception("Extractor LLM call failed")
        return 0

    items = result.get("items", [])
    saved = 0

    for item in items:
        category = item.get("category", "")
        content = item.get("content", "")
        importance = item.get("importance", "low")

        # RAG는 장기 기억 전용 — high만 저장 (일상 감정/사건 저장 방지)
        if not content or category not in VALID_CATEGORIES or importance != "high":
            continue

        metadata = {
            "session_id": session_id,
            "date": date.today().isoformat(),
            "importance": importance,
        }

        try:
            await upsert_journal_embedding(db, user_id, category, content, metadata)
            saved += 1
            logger.info("[journal.extract] saved category=%s content=%r", category, content[:80])
        except Exception:
            logger.exception("Failed to save journal embedding: %s", content[:50])

    logger.info(
        "[journal.extract] session=%s total_items=%d saved=%d",
        session_id, len(items), saved,
    )
    return saved
