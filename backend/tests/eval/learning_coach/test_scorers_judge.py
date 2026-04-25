"""LLM judge tests with mocked OpenAI client."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from tests.eval.learning_coach.schema import Fixture, Judge
from tests.eval.learning_coach.scorers import check_judge


@pytest.mark.asyncio
async def test_judge_parses_score_and_reason(monkeypatch) -> None:
    fake = AsyncMock()
    fake.return_value = '{"score": 4, "reason": "비유가 좋음"}'
    monkeypatch.setattr("tests.eval.learning_coach.scorers._call_judge_llm", fake)

    fixture = _fixture()
    judge = Judge(criteria="설명 명확성", pass_threshold=3)
    result = await check_judge("응답 본문", judge, fixture)

    assert result.score == 4
    assert result.reason == "비유가 좋음"
    assert result.passed is True


@pytest.mark.asyncio
async def test_judge_below_threshold(monkeypatch) -> None:
    fake = AsyncMock(return_value='{"score": 2, "reason": "비유 부족"}')
    monkeypatch.setattr("tests.eval.learning_coach.scorers._call_judge_llm", fake)

    result = await check_judge("응답", Judge(criteria="x", pass_threshold=3), _fixture())
    assert result.passed is False


@pytest.mark.asyncio
async def test_judge_invalid_json_retried_then_fails(monkeypatch) -> None:
    fake = AsyncMock(side_effect=["not json", "still bad"])
    monkeypatch.setattr("tests.eval.learning_coach.scorers._call_judge_llm", fake)

    result = await check_judge("r", Judge(criteria="x"), _fixture())
    assert result.passed is False
    assert result.score == 0
    assert "judge_parse_failed" in result.reason


def _fixture() -> Fixture:
    return Fixture(
        goal="g", subject="s", current_topic="t", proficiency=0,
        recent_messages=[], user_message="u",
    )
