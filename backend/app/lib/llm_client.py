"""OpenAI LLM 클라이언트 — 텍스트/JSON/스트리밍 호출을 통합 제공.

모델은 `settings.AGENT_MODEL`(기본 `gpt-4o-mini`)을 쓰며, `.env`의 `AGENT_MODEL`
환경변수로 런타임 교체 가능.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from openai import AsyncOpenAI

from app.config import settings

logger = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if not settings.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not configured")
        _client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    return _client


async def call_llm(
    prompt: str,
    *,
    model: str | None = None,
    temperature: float = 0.5,
    max_tokens: int = 4096,
    system: str | None = None,
) -> str:
    """LLM 호출 → 원문 텍스트 반환."""
    client = _get_client()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    response = await client.chat.completions.create(
        model=model or settings.AGENT_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=messages,
    )
    return response.choices[0].message.content or ""


async def call_llm_json(
    prompt: str,
    *,
    model: str | None = None,
    temperature: float = 0.5,
    max_tokens: int = 4096,
) -> dict | list:
    """LLM 호출 → JSON 파싱 결과 반환. OpenAI 네이티브 JSON mode 사용."""
    client = _get_client()
    system = "You must respond with valid JSON only. No markdown, no explanation, just JSON."

    response = await client.chat.completions.create(
        model=model or settings.AGENT_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
    )
    content = response.choices[0].message.content or ""
    if not content:
        raise ValueError("Empty response from LLM")
    return json.loads(content)


async def call_llm_stream(
    prompt: str,
    *,
    model: str | None = None,
    temperature: float = 0.5,
    max_tokens: int = 2048,
    system: str | None = None,
) -> AsyncIterator[str]:
    """LLM 스트리밍 호출 → 토큰 텍스트를 순차적으로 yield."""
    client = _get_client()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    stream = await client.chat.completions.create(
        model=model or settings.AGENT_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=messages,
        stream=True,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta


async def call_llm_vision(
    prompt: str,
    image_data_url: str,
    *,
    model: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    detail: str = "auto",
) -> str:
    """Vision LLM 호출 → 원문 텍스트 반환.

    image_data_url: `data:image/png;base64,...` 형식의 data URL 또는 http(s) URL.
    detail: "low" | "high" | "auto".
    """
    client = _get_client()
    response = await client.chat.completions.create(
        model=model or settings.AGENT_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_data_url, "detail": detail},
                    },
                ],
            }
        ],
    )
    return response.choices[0].message.content or ""
