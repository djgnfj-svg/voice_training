# backend/app/agent/embeddings.py
from __future__ import annotations

import logging

from app.config import settings
from app.lib.llm_client import _get_client

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "text-embedding-3-small"


async def create_embedding(text: str) -> list[float]:
    """Create embedding vector for given text using OpenAI."""
    if not settings.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required for embeddings")
    client = _get_client()
    response = await client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
    )
    return response.data[0].embedding
