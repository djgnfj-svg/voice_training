"""Rule scorer tests."""
from tests.eval.learning_coach.schema import Rules
from tests.eval.learning_coach.scorers import check_rules


def test_must_not_contain_pass() -> None:
    rules = Rules(must_not_contain=["```", "##"])
    result = check_rules("그냥 일반 텍스트입니다.", rules)
    assert result.passed is True
    assert result.failures == []


def test_must_not_contain_fail() -> None:
    rules = Rules(must_not_contain=["```"])
    result = check_rules("코드 예시: ```python\nx=1\n```", rules)
    assert result.passed is False
    assert any("must_not_contain" in f for f in result.failures)


def test_must_address_any_fail() -> None:
    rules = Rules(must_address_any=["B-Tree", "비트리"])
    result = check_rules("해시는 키-값 매핑입니다.", rules)
    assert result.passed is False


def test_must_address_any_pass() -> None:
    rules = Rules(must_address_any=["B-Tree", "비트리"])
    result = check_rules("B-Tree는 균형 트리입니다.", rules)
    assert result.passed is True


def test_must_have_question_pass_kr_qmark() -> None:
    rules = Rules(must_have_question=True)
    assert check_rules("이해되시나요？", rules).passed is True


def test_must_have_question_fail() -> None:
    rules = Rules(must_have_question=True)
    assert check_rules("이건 설명입니다.", rules).passed is False


def test_max_chars_fail() -> None:
    rules = Rules(max_chars=10)
    assert check_rules("이 문장은 열 글자보다 깁니다.", rules).passed is False


def test_combined_failures_listed() -> None:
    rules = Rules(must_not_contain=["```"], must_have_question=True)
    result = check_rules("```code```", rules)
    assert result.passed is False
    assert len(result.failures) == 2
