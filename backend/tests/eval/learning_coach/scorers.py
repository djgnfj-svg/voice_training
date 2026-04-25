"""Rule + LLM-judge scorers."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from app.lib.llm_client import call_llm
from tests.eval.learning_coach.schema import Fixture, Judge, Rules

logger = logging.getLogger(__name__)

JUDGE_MODEL = os.getenv("EVAL_JUDGE_MODEL", "gpt-4o")


@dataclass
class RuleResult:
    passed: bool
    failures: list[str] = field(default_factory=list)


@dataclass
class JudgeResult:
    passed: bool
    score: int
    reason: str


def check_rules(response: str, rules: Rules) -> RuleResult:
    failures: list[str] = []

    for needle in rules.must_not_contain:
        if needle in response:
            failures.append(f"must_not_contain: '{needle}' present")

    if rules.must_address_any:
        if not any(kw in response for kw in rules.must_address_any):
            failures.append(f"must_address_any: none of {rules.must_address_any} present")

    if rules.must_have_question:
        if "?" not in response and "？" not in response:
            failures.append("must_have_question: no '?' found")

    if rules.max_chars is not None and len(response) > rules.max_chars:
        failures.append(f"max_chars: {len(response)} > {rules.max_chars}")

    return RuleResult(passed=not failures, failures=failures)


_JUDGE_PROMPT = """당신은 한국어 학습 코치 응답을 평가하는 평가자입니다.

[사용자 발화]
{user_message}

[코치 응답]
{response}

[평가 기준]
{criteria}

위 기준 각각이 얼마나 잘 충족되었는지 종합해서 0~5점으로 채점하세요.
JSON 외의 출력은 금지.
{{"score": <0~5 정수>, "reason": "<한 문장 이유>"}}
"""


async def _call_judge_llm(prompt: str) -> str:
    return await call_llm(prompt, model=JUDGE_MODEL, temperature=0)


async def check_judge(response: str, judge: Judge, fixture: Fixture) -> JudgeResult:
    prompt = _JUDGE_PROMPT.format(
        user_message=fixture.user_message,
        response=response,
        criteria=judge.criteria,
    )
    for attempt in (1, 2):
        try:
            raw = await _call_judge_llm(prompt)
            data = json.loads(raw.strip().strip("`"))
            score = int(data["score"])
            reason = str(data.get("reason", ""))
            return JudgeResult(
                passed=score >= judge.pass_threshold,
                score=score,
                reason=reason,
            )
        except (json.JSONDecodeError, KeyError, ValueError, TypeError) as e:
            logger.warning("judge parse failed (attempt %d): %s", attempt, e)
            continue
    return JudgeResult(passed=False, score=0, reason="judge_parse_failed")
