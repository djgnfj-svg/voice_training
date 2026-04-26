"""Schema parsing tests — dataclass and YAML loader."""
from pathlib import Path

import pytest

from tests.eval.learning_coach.schema import Case, load_case, load_all_cases


def test_load_case_minimal(tmp_path: Path) -> None:
    yaml_text = """
id: sample
description: 샘플 케이스
fixture:
  goal: "DB 마스터"
  subject: "Database"
  current_topic: "B-Tree"
  proficiency: 10
  recent_messages: []
  user_message: "B-Tree 뭐예요"
rules:
  must_not_contain: ["```"]
  must_address_any: ["B-Tree"]
  must_have_question: true
  max_chars: 500
judge:
  criteria: "두 자료구조의 차이를 설명하는가"
  pass_threshold: 3
"""
    f = tmp_path / "sample.yaml"
    f.write_text(yaml_text, encoding="utf-8")

    case = load_case(f)
    assert isinstance(case, Case)
    assert case.id == "sample"
    assert case.fixture.proficiency == 10
    assert case.fixture.user_message == "B-Tree 뭐예요"
    assert case.rules.must_have_question is True
    assert case.rules.max_chars == 500
    assert case.judge.pass_threshold == 3


def test_load_all_cases_returns_list(tmp_path: Path) -> None:
    (tmp_path / "a.yaml").write_text(_minimal_yaml("a"), encoding="utf-8")
    (tmp_path / "b.yaml").write_text(_minimal_yaml("b"), encoding="utf-8")

    cases = load_all_cases(tmp_path)
    ids = sorted(c.id for c in cases)
    assert ids == ["a", "b"]


def test_load_case_missing_field_raises(tmp_path: Path) -> None:
    yaml_text = "id: bad\ndescription: missing fixture\n"
    f = tmp_path / "bad.yaml"
    f.write_text(yaml_text, encoding="utf-8")

    with pytest.raises((KeyError, TypeError)):
        load_case(f)


def _minimal_yaml(case_id: str) -> str:
    return f"""
id: {case_id}
description: t
fixture:
  goal: g
  subject: s
  current_topic: t
  proficiency: 0
  recent_messages: []
  user_message: u
rules: {{}}
judge:
  criteria: c
"""
