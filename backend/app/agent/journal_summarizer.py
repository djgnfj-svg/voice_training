# backend/app/agent/journal_summarizer.py
from __future__ import annotations

import logging
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm_json
from app.config import settings
from app.prompts.journal import SUMMARIZER_PROMPT
from app.agent.journal_rag import upsert_journal_embedding

logger = logging.getLogger(__name__)


async def generate_summary(
    db: AsyncSession,
    user_id: str,
    session_id: str,
    messages: list[dict],
) -> dict:
    """Generate session summary and save to RAG.
    Returns: {"summary": "...", "highlights": [...]}
    """
    if not messages:
        return {"summary": "대화 없음", "highlights": []}

    conversation = ""
    for m in messages:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        conversation += f"{role_label}: {m.get('content', '')}\n"

    prompt = SUMMARIZER_PROMPT.format(conversation=conversation)

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)
    except Exception:
        logger.exception("Summarizer LLM call failed")
        return {"summary": "요약 생성 실패", "highlights": []}

    summary = result.get("summary", "")

    if summary:
        metadata = {
            "session_id": session_id,
            "date": date.today().isoformat(),
            "highlights": result.get("highlights", []),
        }
        try:
            await upsert_journal_embedding(
                db, user_id, "daily_summary", summary, metadata,
            )
        except Exception:
            logger.exception("Failed to save summary to RAG")

    return result
