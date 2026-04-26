"""Eval entrypoint — parametrized over case YAML files.

Run: pytest tests/eval/learning_coach/ -m eval -v
"""
from __future__ import annotations

import pytest

from tests.eval.learning_coach.conftest import all_cases
from tests.eval.learning_coach.runner import run_case
from tests.eval.learning_coach.schema import Case
from tests.eval.learning_coach.scorers import check_judge, check_rules


@pytest.mark.eval
@pytest.mark.asyncio
@pytest.mark.parametrize("case", all_cases(), ids=lambda c: c.id)
async def test_learning_coach_eval(case: Case) -> None:
    response = await run_case(case.fixture)

    rule_result = check_rules(response, case.rules)
    assert rule_result.passed, (
        f"\n[{case.id}] 룰 실패:\n  - "
        + "\n  - ".join(rule_result.failures)
        + f"\n응답:\n{response}"
    )

    judge_result = await check_judge(response, case.judge, case.fixture)
    assert judge_result.passed, (
        f"\n[{case.id}] judge {judge_result.score}/5 — {judge_result.reason}"
        f"\n응답:\n{response}"
    )
