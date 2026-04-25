"""Rule + LLM-judge scorers."""
from __future__ import annotations

from dataclasses import dataclass, field

from tests.eval.learning_coach.schema import Rules


@dataclass
class RuleResult:
    passed: bool
    failures: list[str] = field(default_factory=list)


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
