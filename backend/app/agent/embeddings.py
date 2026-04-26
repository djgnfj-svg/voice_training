# backend/app/agent/embeddings.py
from __future__ import annotations

import logging
import os

from app.config import settings
from app.lib.llm_client import _get_client

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "text-embedding-3-small"

_MOCK_MODE = os.environ.get("E2E_MOCK_LLM") == "1"


async def create_embedding(text: str) -> list[float]:
    """Create embedding vector for given text using OpenAI.

    When E2E_MOCK_LLM=1, returns a deterministic 1536-dim vector instead.
    """
    if _MOCK_MODE:
        from app.lib.llm_mock import mock_embedding

        return mock_embedding(text)

    if not settings.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required for embeddings")
    client = _get_client()
    response = await client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
    )
    return response.data[0].embedding
