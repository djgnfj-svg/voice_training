"""Runner test — uses mocked LLM to verify prompt assembly."""
from unittest.mock import AsyncMock

import pytest

from tests.eval.learning_coach.runner import build_messages, run_case
from tests.eval.learning_coach.schema import Fixture, Message


def _fx(**overrides) -> Fixture:
    base = dict(
        goal="DB 마스터", subject="Database", current_topic="B-Tree",
        proficiency=10, recent_messages=[], user_message="B-Tree 뭐예요",
    )
    base.update(overrides)
    return Fixture(**base)


def test_build_messages_includes_system_prompt_and_context() -> None:
    fixture = _fx()
    msgs = build_messages(fixture)

    assert msgs[0]["role"] == "system"
    assert "DB 마스터" in msgs[0]["content"]
    assert "B-Tree" in msgs[0]["content"]
    assert msgs[-1]["role"] == "user"
    assert msgs[-1]["content"] == "B-Tree 뭐예요"


def test_build_messages_includes_recent_history() -> None:
    fixture = _fx(recent_messages=[
        Message(role="user", content="이전 질문"),
        Message(role="assistant", content="이전 답변"),
    ])
    msgs = build_messages(fixture)
    assert any(m["role"] == "user" and m["content"] == "이전 질문" for m in msgs)
    assert any(m["role"] == "assistant" and m["content"] == "이전 답변" for m in msgs)


@pytest.mark.asyncio
async def test_run_case_returns_llm_text(monkeypatch) -> None:
    fake = AsyncMock(return_value="모의 응답입니다")
    monkeypatch.setattr("tests.eval.learning_coach.runner._call_sut_llm", fake)

    out = await run_case(_fx())
    assert out == "모의 응답입니다"
    fake.assert_awaited_once()
