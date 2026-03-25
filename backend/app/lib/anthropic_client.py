from __future__ import annotations

import json
import logging
import re

from anthropic import AsyncAnthropic

from app.config import settings

logger = logging.getLogger(__name__)

_client: AsyncAnthropic | None = None


def _get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    return _client


MODELS = {
    "ANALYSIS": "claude-haiku-4-5-20251001",
    "EVALUATION": "claude-haiku-4-5-20251001",
    "QUESTION_GEN": "claude-haiku-4-5-20251001",
}


async def call_llm(
    prompt: str,
    *,
    model: str | None = None,
    temperature: float = 0.5,
    max_tokens: int = 4096,
    system: str | None = None,
) -> str:
    """Call Claude and return raw text content."""
    client = _get_client()
    response = await client.messages.create(
        model=model or MODELS["ANALYSIS"],
        max_tokens=max_tokens,
        temperature=temperature,
        **({"system": system} if system else {}),
        messages=[{"role": "user", "content": prompt}],
    )
    text_block = next((b for b in response.content if b.type == "text"), None)
    return text_block.text if text_block else ""


async def call_llm_json(
    prompt: str,
    *,
    model: str | None = None,
    temperature: float = 0.5,
    max_tokens: int = 4096,
) -> dict | list:
    """Call Claude expecting JSON response. Strips markdown fences and parses."""
    system = "You must respond with valid JSON only. No markdown, no explanation, just JSON."
    content = await call_llm(
        prompt,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        system=system,
    )
    if not content:
        raise ValueError("Empty response from Claude")

    # Strip markdown code blocks if present
    cleaned = re.sub(r"^```(?:json)?\s*\n?", "", content, flags=re.IGNORECASE)
    cleaned = re.sub(r"\n?```\s*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip()

    return json.loads(cleaned)
