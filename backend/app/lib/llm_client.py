"""OpenAI LLM 클라이언트 — 텍스트/JSON/스트리밍 호출을 통합 제공.

모델은 `settings.AGENT_MODEL`(기본 `gpt-4o-mini`)을 쓰며, `.env`의 `AGENT_MODEL`
환경변수로 런타임 교체 가능.

계측: 각 호출은 `tag` 인자(호출처 식별자)를 받아 1줄 JSON 로그로
prompt/cached/completion 토큰과 latency_ms(+ 스트리밍은 ttft_ms)를 남긴다.
환경변수 `LLM_METRICS_FILE`이 지정되면 같은 라인을 해당 파일에 append한다.
mock 모드에서는 계측을 우회한다.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, AsyncIterator

from openai import AsyncOpenAI

from app.config import settings

logger = logging.getLogger(__name__)

_MOCK_MODE = os.environ.get("E2E_MOCK_LLM") == "1"

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if not settings.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not configured")
        _client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    return _client


# ---------------------------------------------------------------------------
# Instrumentation
# ---------------------------------------------------------------------------

def _extract_usage(usage: Any) -> dict[str, int]:
    """OpenAI usage 객체에서 토큰 수를 안전하게 추출."""
    if usage is None:
        return {"prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0}
    prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
    completion_tokens = getattr(usage, "completion_tokens", 0) or 0
    details = getattr(usage, "prompt_tokens_details", None)
    cached_tokens = 0
    if details is not None:
        cached_tokens = getattr(details, "cached_tokens", 0) or 0
    return {
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(completion_tokens),
        "cached_tokens": int(cached_tokens),
    }


def _emit_metric(record: dict[str, Any]) -> None:
    """1줄 JSON으로 stdout(logger) + (옵션) LLM_METRICS_FILE에 기록.

    파일 append는 O_APPEND + 1회 write로 다중 프로세스/스레드 안전.
    실패해도 호출자에 예외 전파하지 않음.
    """
    try:
        line = json.dumps(record, ensure_ascii=False, default=str)
    except Exception:
        return
    logger.info(line)
    path = os.environ.get("LLM_METRICS_FILE")
    if not path:
        return
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        fd = os.open(path, flags, 0o644)
        try:
            os.write(fd, (line + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except Exception:
        # 메트릭 실패는 호출 실패가 아님
        logger.debug("LLM_METRICS_FILE write failed", exc_info=True)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _build_cached_messages(
    *,
    system: str | None,
    cached_context: str | None,
    variable: str | None,
    fallback_user: str | None,
) -> list[dict]:
    """OpenAI 자동 프롬프트 캐시에 적합한 messages 구성.

    구조: [system(고정)] → [user(cached_context, 세션 불변)] → [assistant(ack)] → [user(variable)]
    호출 간 앞쪽 prefix(system + cached_context + ack)가 동일하면 ≥1024 토큰 시 자동 캐시 적중.
    `cached_context`가 없으면 `system`만 prefix로 두고 가변부를 user로 둠 (호환 경로).
    """
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    if cached_context:
        messages.append({"role": "user", "content": cached_context})
        messages.append({"role": "assistant", "content": "이해했습니다. 입력을 기다립니다."})
    user_content = variable if variable is not None else fallback_user
    if user_content is not None:
        messages.append({"role": "user", "content": user_content})
    return messages


async def call_llm(
    prompt: str | None = None,
    *,
    model: str | None = None,
    temperature: float = 0.5,
    max_tokens: int = 4096,
    system: str | None = None,
    cached_context: str | None = None,
    variable: str | None = None,
    tag: str | None = None,
) -> str:
    """LLM 호출 → 원문 텍스트 반환.

    호환: 기존 `prompt` 위치 인자(단일 user 메시지) 그대로 동작.
    캐시 친화: `cached_context`(세션 불변 prefix) + `variable`(턴별 가변)을 분리해 넘기면
    호출 간 앞쪽 prefix가 동일해져 OpenAI 자동 캐시(≥1024 토큰) 적중률을 높일 수 있다.
    """
    client = _get_client()
    messages = _build_cached_messages(
        system=system,
        cached_context=cached_context,
        variable=variable,
        fallback_user=prompt,
    )
    if not messages:
        raise ValueError("call_llm requires either prompt or variable/cached_context")

    used_model = model or settings.AGENT_MODEL
    started = time.perf_counter()
    response = await client.chat.completions.create(
        model=used_model,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=messages,
    )
    latency_ms = int((time.perf_counter() - started) * 1000)
    usage = _extract_usage(getattr(response, "usage", None))
    _emit_metric({
        "event": "llm_call",
        "fn": "call_llm",
        "tag": tag,
        "model": used_model,
        "prompt_tokens": usage["prompt_tokens"],
        "cached_tokens": usage["cached_tokens"],
        "completion_tokens": usage["completion_tokens"],
        "ttft_ms": None,
        "latency_ms": latency_ms,
        "ts": time.time(),
    })
    return response.choices[0].message.content or ""


_JSON_GUARD_SYSTEM = "You must respond with valid JSON only. No markdown, no explanation, just JSON."


async def call_llm_json(
    prompt: str | None = None,
    *,
    model: str | None = None,
    temperature: float = 0.5,
    max_tokens: int = 4096,
    system: str | None = None,
    cached_context: str | None = None,
    variable: str | None = None,
    tag: str | None = None,
) -> dict | list:
    """LLM 호출 → JSON 파싱 결과 반환. OpenAI 네이티브 JSON mode 사용.

    캐시 친화 슬롯:
      - `system`: system 메시지(없으면 JSON guard 문구만 사용). 호출 간 동일 유지.
      - `cached_context`: 세션 내 불변 컨텍스트 (페르소나/루브릭/스키마/요약/JD/프로필 등).
        ≥1024 토큰이면 OpenAI 자동 프롬프트 캐싱 적중.
      - `variable`: 턴별 가변 입력 (현재 질문/답변/스캔 인덱스 등).
    호환: 기존 단일 `prompt` 인자도 그대로 동작 (cached_context/variable 미지정 시 user 메시지).
    """
    client = _get_client()
    # JSON guard 문구는 항상 system 맨 앞에 둔다. 호출자가 system을 추가로 주면 결합.
    effective_system = _JSON_GUARD_SYSTEM if system is None else f"{_JSON_GUARD_SYSTEM}\n\n{system}"
    messages = _build_cached_messages(
        system=effective_system,
        cached_context=cached_context,
        variable=variable,
        fallback_user=prompt,
    )
    if len(messages) < 2:
        raise ValueError("call_llm_json requires either prompt or variable/cached_context")

    used_model = model or settings.AGENT_MODEL
    started = time.perf_counter()
    response = await client.chat.completions.create(
        model=used_model,
        max_tokens=max_tokens,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=messages,
    )
    latency_ms = int((time.perf_counter() - started) * 1000)
    usage = _extract_usage(getattr(response, "usage", None))
    _emit_metric({
        "event": "llm_call",
        "fn": "call_llm_json",
        "tag": tag,
        "model": used_model,
        "prompt_tokens": usage["prompt_tokens"],
        "cached_tokens": usage["cached_tokens"],
        "completion_tokens": usage["completion_tokens"],
        "ttft_ms": None,
        "latency_ms": latency_ms,
        "ts": time.time(),
    })
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
    tag: str | None = None,
) -> AsyncIterator[str]:
    """LLM 스트리밍 호출 → 토큰 텍스트를 순차적으로 yield."""
    client = _get_client()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    used_model = model or settings.AGENT_MODEL
    started = time.perf_counter()
    stream = await client.chat.completions.create(
        model=used_model,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=messages,
        stream=True,
        stream_options={"include_usage": True},
    )
    ttft_ms: int | None = None
    final_usage: Any = None
    async for chunk in stream:
        # usage는 stream_options=include_usage 시 마지막 chunk에 채워짐
        chunk_usage = getattr(chunk, "usage", None)
        if chunk_usage is not None:
            final_usage = chunk_usage
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta.content
        if delta:
            if ttft_ms is None:
                ttft_ms = int((time.perf_counter() - started) * 1000)
            yield delta
    latency_ms = int((time.perf_counter() - started) * 1000)
    usage = _extract_usage(final_usage)
    _emit_metric({
        "event": "llm_call",
        "fn": "call_llm_stream",
        "tag": tag,
        "model": used_model,
        "prompt_tokens": usage["prompt_tokens"],
        "cached_tokens": usage["cached_tokens"],
        "completion_tokens": usage["completion_tokens"],
        "ttft_ms": ttft_ms,
        "latency_ms": latency_ms,
        "ts": time.time(),
    })


async def call_llm_vision(
    prompt: str,
    image_data_url: str,
    *,
    model: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    detail: str = "auto",
    tag: str | None = None,
) -> str:
    """Vision LLM 호출 → 원문 텍스트 반환.

    image_data_url: `data:image/png;base64,...` 형식의 data URL 또는 http(s) URL.
    detail: "low" | "high" | "auto".
    """
    client = _get_client()
    used_model = model or settings.AGENT_MODEL
    started = time.perf_counter()
    response = await client.chat.completions.create(
        model=used_model,
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
    latency_ms = int((time.perf_counter() - started) * 1000)
    usage = _extract_usage(getattr(response, "usage", None))
    _emit_metric({
        "event": "llm_call",
        "fn": "call_llm_vision",
        "tag": tag,
        "model": used_model,
        "prompt_tokens": usage["prompt_tokens"],
        "cached_tokens": usage["cached_tokens"],
        "completion_tokens": usage["completion_tokens"],
        "ttft_ms": None,
        "latency_ms": latency_ms,
        "ts": time.time(),
    })
    return response.choices[0].message.content or ""


# ---------------------------------------------------------------------------
# E2E mock override — when E2E_MOCK_LLM=1, swap real impls for stubs.
# Mock은 **kwargs를 받으므로 tag를 그대로 넘겨도 안전. 계측은 우회.
# ---------------------------------------------------------------------------
if _MOCK_MODE:
    from app.lib import llm_mock  # noqa: E402

    call_llm = llm_mock.call_llm  # type: ignore[assignment]
    call_llm_json = llm_mock.call_llm_json  # type: ignore[assignment]
    call_llm_stream = llm_mock.call_llm_stream  # type: ignore[assignment]
    call_llm_vision = llm_mock.call_llm_vision  # type: ignore[assignment]
    logger.warning("E2E_MOCK_LLM=1 — llm_client using stub responses")
