"""Unit tests for job posting image extraction service."""
from __future__ import annotations

import pytest

from app.services import job_posting as svc


@pytest.mark.asyncio
async def test_extract_text_from_image_returns_stripped_text(monkeypatch):
    """Vision LLM 응답의 앞뒤 공백을 strip 해서 반환해야 한다."""
    captured: dict = {}

    async def fake_vision(prompt, image_data_url, **kwargs):
        captured["prompt"] = prompt
        captured["image_data_url"] = image_data_url
        captured["kwargs"] = kwargs
        return "\n\n[회사] 백엔드 개발자\n- Java 3년+\n\n"

    monkeypatch.setattr(svc, "call_llm_vision", fake_vision)

    result = await svc.extract_text_from_image("data:image/png;base64,AAA")

    assert result == "[회사] 백엔드 개발자\n- Java 3년+"
    assert captured["image_data_url"] == "data:image/png;base64,AAA"
    assert "채용공고 텍스트" in captured["prompt"]
    assert captured["kwargs"].get("temperature") == 0.0
    assert captured["kwargs"].get("detail") == "auto"


@pytest.mark.asyncio
async def test_extract_text_from_image_empty_response(monkeypatch):
    """LLM이 빈 문자열을 반환하면 그대로 빈 문자열 반환."""
    async def fake_vision(prompt, image_data_url, **kwargs):
        return ""

    monkeypatch.setattr(svc, "call_llm_vision", fake_vision)

    result = await svc.extract_text_from_image("data:image/png;base64,AAA")
    assert result == ""


@pytest.mark.asyncio
async def test_extract_text_from_image_propagates_llm_error(monkeypatch):
    """LLM 예외는 그대로 전파되어 라우터가 500으로 처리하게 한다."""
    async def fake_vision(prompt, image_data_url, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(svc, "call_llm_vision", fake_vision)

    with pytest.raises(RuntimeError, match="boom"):
        await svc.extract_text_from_image("data:image/png;base64,AAA")
