# Learning Coach Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learning Coach 시스템 프롬프트 + 모델 응답 품질을 룰 + LLM-judge로 자동 채점하는 pytest 기반 평가 하네스 구축.

**Architecture:** 케이스마다 개별 YAML, pytest parametrize로 로딩, runner는 `AGENTIC_SYSTEM_PROMPT` + fixture context + user message를 OpenAI에 직접 호출 (graph 우회). scorer는 룰 함수 + gpt-4o judge 호출. `@pytest.mark.eval`로 격리.

**Tech Stack:** pytest, pytest-asyncio, pyyaml, OpenAI Python SDK (기존), `app.lib.llm_client`

**Spec:** `docs/superpowers/specs/2026-04-25-learning-coach-eval-harness-design.md`

---

## File Structure

**Create:**
- `backend/tests/eval/__init__.py`
- `backend/tests/eval/learning_coach/__init__.py`
- `backend/tests/eval/learning_coach/schema.py` — dataclass + YAML 로더
- `backend/tests/eval/learning_coach/runner.py` — 시스템 프롬프트 조립 + LLM 호출
- `backend/tests/eval/learning_coach/scorers.py` — 룰 채점 + judge 호출
- `backend/tests/eval/learning_coach/conftest.py` — `eval` mark 등록 + 케이스 로드 fixture
- `backend/tests/eval/learning_coach/test_eval.py` — pytest 진입점
- `backend/tests/eval/learning_coach/cases/new_topic_first_question.yaml`
- `backend/tests/eval/learning_coach/cases/stuck_unknown_answer.yaml`
- `backend/tests/eval/learning_coach/cases/goal_swap_detection.yaml`
- `backend/tests/eval/learning_coach/cases/srs_due_review.yaml`
- `backend/tests/eval/learning_coach/cases/session_close_signal.yaml`

**Modify:**
- `backend/pyproject.toml` — `pyyaml` 의존성 추가, `[tool.pytest.ini_options]` markers 등록

---

## Task 1: 의존성 추가 + pytest marker 등록

**Files:**
- Modify: `backend/pyproject.toml`

- [ ] **Step 1: pyyaml 추가 + eval marker 등록**

`backend/pyproject.toml` 끝에 추가하고 dependencies에 `pyyaml>=6.0` 추가:

```toml
[project]
name = "voiceprep-backend"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "python-multipart>=0.0.9",
    "sqlalchemy[asyncio]>=2.0",
    "asyncpg>=0.29",
    "bcrypt>=4.0",
    "openai>=1.40",
    "edge-tts>=6.1",
    "pydantic>=2.7",
    "pydantic-settings>=2.3",
    "httpx>=0.27",
    "pymupdf>=1.24",
    "sse-starlette>=2.0",
    "cryptography>=42.0",
    "joserfc>=1.0",
    "langgraph>=0.2",
    "langsmith>=0.1",
    "pyyaml>=6.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
]

[tool.pytest.ini_options]
markers = [
    "eval: 평가 하네스 — 실제 OpenAI 호출. `pytest -m eval`로만 실행됨",
]
```

- [ ] **Step 2: docker 컨테이너에 pyyaml 설치 확인**

```bash
docker compose exec backend pip install pyyaml
docker compose exec backend python -c "import yaml; print(yaml.__version__)"
```
Expected: 버전 출력 (6.x)

- [ ] **Step 3: Commit**

```bash
git add backend/pyproject.toml
git commit -m "Add pyyaml dependency and eval pytest marker"
```

---

## Task 2: 케이스 스키마 + YAML 로더

**Files:**
- Create: `backend/tests/eval/__init__.py`
- Create: `backend/tests/eval/learning_coach/__init__.py`
- Create: `backend/tests/eval/learning_coach/schema.py`
- Create: `backend/tests/eval/learning_coach/test_schema.py`

- [ ] **Step 1: 빈 __init__.py 두 개 생성**

```bash
touch backend/tests/eval/__init__.py
touch backend/tests/eval/learning_coach/__init__.py
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/eval/learning_coach/test_schema.py`:

```python
"""Schema parsing tests — dataclass and YAML loader."""
from pathlib import Path

import pytest

from backend.tests.eval.learning_coach.schema import Case, load_case, load_all_cases


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
```

- [ ] **Step 3: 실행해서 실패 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_schema.py -v
```
Expected: FAIL — `ModuleNotFoundError: schema`

- [ ] **Step 4: schema.py 구현**

`backend/tests/eval/learning_coach/schema.py`:

```python
"""Eval case schema — dataclasses and YAML loader."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml


@dataclass
class Message:
    role: Literal["user", "assistant"]
    content: str


@dataclass
class Fixture:
    goal: str
    subject: str
    current_topic: str
    proficiency: int
    recent_messages: list[Message]
    user_message: str


@dataclass
class Rules:
    must_not_contain: list[str] = field(default_factory=list)
    must_address_any: list[str] = field(default_factory=list)
    must_have_question: bool = False
    max_chars: int | None = None


@dataclass
class Judge:
    criteria: str
    pass_threshold: int = 3


@dataclass
class Case:
    id: str
    description: str
    fixture: Fixture
    rules: Rules
    judge: Judge


def load_case(path: Path) -> Case:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    fx = raw["fixture"]
    fixture = Fixture(
        goal=fx["goal"],
        subject=fx["subject"],
        current_topic=fx["current_topic"],
        proficiency=int(fx["proficiency"]),
        recent_messages=[Message(**m) for m in fx.get("recent_messages", [])],
        user_message=fx["user_message"],
    )
    r = raw.get("rules") or {}
    rules = Rules(
        must_not_contain=list(r.get("must_not_contain", [])),
        must_address_any=list(r.get("must_address_any", [])),
        must_have_question=bool(r.get("must_have_question", False)),
        max_chars=r.get("max_chars"),
    )
    j = raw["judge"]
    judge = Judge(criteria=j["criteria"], pass_threshold=int(j.get("pass_threshold", 3)))
    return Case(id=raw["id"], description=raw["description"], fixture=fixture, rules=rules, judge=judge)


def load_all_cases(dir_path: Path) -> list[Case]:
    return [load_case(p) for p in sorted(dir_path.glob("*.yaml"))]
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_schema.py -v
```
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add backend/tests/eval/__init__.py backend/tests/eval/learning_coach/__init__.py backend/tests/eval/learning_coach/schema.py backend/tests/eval/learning_coach/test_schema.py
git commit -m "Add eval case schema and YAML loader"
```

---

## Task 3: 룰 채점기

**Files:**
- Create: `backend/tests/eval/learning_coach/scorers.py` (rules 부분)
- Create: `backend/tests/eval/learning_coach/test_scorers_rules.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/eval/learning_coach/test_scorers_rules.py`:

```python
"""Rule scorer tests."""
from backend.tests.eval.learning_coach.schema import Rules
from backend.tests.eval.learning_coach.scorers import check_rules


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
```

- [ ] **Step 2: 실행해서 실패 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_scorers_rules.py -v
```
Expected: FAIL — `ModuleNotFoundError: scorers`

- [ ] **Step 3: scorers.py 룰 부분 구현**

`backend/tests/eval/learning_coach/scorers.py`:

```python
"""Rule + LLM-judge scorers."""
from __future__ import annotations

from dataclasses import dataclass, field

from backend.tests.eval.learning_coach.schema import Rules


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
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_scorers_rules.py -v
```
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add backend/tests/eval/learning_coach/scorers.py backend/tests/eval/learning_coach/test_scorers_rules.py
git commit -m "Add rule scorer for eval harness"
```

---

## Task 4: LLM-judge 채점기

**Files:**
- Modify: `backend/tests/eval/learning_coach/scorers.py`
- Create: `backend/tests/eval/learning_coach/test_scorers_judge.py`

- [ ] **Step 1: 실패하는 테스트 작성 (모킹된 OpenAI로)**

`backend/tests/eval/learning_coach/test_scorers_judge.py`:

```python
"""LLM judge tests with mocked OpenAI client."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.tests.eval.learning_coach.schema import Fixture, Judge
from backend.tests.eval.learning_coach.scorers import check_judge


@pytest.mark.asyncio
async def test_judge_parses_score_and_reason(monkeypatch) -> None:
    fake = AsyncMock()
    fake.return_value = '{"score": 4, "reason": "비유가 좋음"}'
    monkeypatch.setattr("backend.tests.eval.learning_coach.scorers._call_judge_llm", fake)

    fixture = _fixture()
    judge = Judge(criteria="설명 명확성", pass_threshold=3)
    result = await check_judge("응답 본문", judge, fixture)

    assert result.score == 4
    assert result.reason == "비유가 좋음"
    assert result.passed is True


@pytest.mark.asyncio
async def test_judge_below_threshold(monkeypatch) -> None:
    fake = AsyncMock(return_value='{"score": 2, "reason": "비유 부족"}')
    monkeypatch.setattr("backend.tests.eval.learning_coach.scorers._call_judge_llm", fake)

    result = await check_judge("응답", Judge(criteria="x", pass_threshold=3), _fixture())
    assert result.passed is False


@pytest.mark.asyncio
async def test_judge_invalid_json_retried_then_fails(monkeypatch) -> None:
    fake = AsyncMock(side_effect=["not json", "still bad"])
    monkeypatch.setattr("backend.tests.eval.learning_coach.scorers._call_judge_llm", fake)

    result = await check_judge("r", Judge(criteria="x"), _fixture())
    assert result.passed is False
    assert result.score == 0
    assert "judge_parse_failed" in result.reason


def _fixture() -> Fixture:
    return Fixture(
        goal="g", subject="s", current_topic="t", proficiency=0,
        recent_messages=[], user_message="u",
    )
```

- [ ] **Step 2: 실행해서 실패 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_scorers_judge.py -v
```
Expected: FAIL — `ImportError: cannot import name 'check_judge'`

- [ ] **Step 3: scorers.py에 judge 함수 추가**

`backend/tests/eval/learning_coach/scorers.py` 끝에 추가:

```python
import json
import logging
import os
from dataclasses import dataclass

from app.lib.llm_client import call_llm
from backend.tests.eval.learning_coach.schema import Fixture, Judge

logger = logging.getLogger(__name__)

JUDGE_MODEL = os.getenv("EVAL_JUDGE_MODEL", "gpt-4o")


@dataclass
class JudgeResult:
    passed: bool
    score: int
    reason: str


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
```

위 파일에서 기존 `from __future__ import annotations` 아래로 import들이 모이도록 정리. 최종 파일 상단:

```python
"""Rule + LLM-judge scorers."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from app.lib.llm_client import call_llm
from backend.tests.eval.learning_coach.schema import Fixture, Judge, Rules
```

(중복 import 제거)

- [ ] **Step 4: 테스트 통과 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_scorers_judge.py -v
```
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add backend/tests/eval/learning_coach/scorers.py backend/tests/eval/learning_coach/test_scorers_judge.py
git commit -m "Add LLM judge scorer with retry-once parser"
```

---

## Task 5: Runner — 시스템 프롬프트 + LLM 직접 호출

**Files:**
- Create: `backend/tests/eval/learning_coach/runner.py`
- Create: `backend/tests/eval/learning_coach/test_runner.py`

**설명:** graph 전체 호출은 DB 강결합으로 첫 PR 범위 외. 대신 `AGENTIC_SYSTEM_PROMPT` + fixture를 JSON context로 박아 OpenAI에 직접 호출. 실제 graph가 system prompt에 같은 형태로 context를 주입하므로 (`graph.py:576`), 회귀의 핵심은 동일.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/eval/learning_coach/test_runner.py`:

```python
"""Runner test — uses mocked LLM to verify prompt assembly."""
from unittest.mock import AsyncMock

import pytest

from backend.tests.eval.learning_coach.runner import build_messages, run_case
from backend.tests.eval.learning_coach.schema import Fixture, Message


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
    monkeypatch.setattr("backend.tests.eval.learning_coach.runner._call_sut_llm", fake)

    out = await run_case(_fx())
    assert out == "모의 응답입니다"
    fake.assert_awaited_once()
```

- [ ] **Step 2: 실행해서 실패 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_runner.py -v
```
Expected: FAIL — `ModuleNotFoundError: runner`

- [ ] **Step 3: runner.py 구현**

`backend/tests/eval/learning_coach/runner.py`:

```python
"""Runner — assembles SUT prompt and calls OpenAI directly.

Bypasses the graph's DB integration on purpose. The system prompt template
matches what `build_learning_graph.load_context` injects (see
`backend/app/agent/learning_coach/graph.py:576`), so prompt/model regressions
are still detected.
"""
from __future__ import annotations

import json
from typing import Any

from app.config import settings
from app.lib.llm_client import call_llm
from app.prompts.learning_coach import AGENTIC_SYSTEM_PROMPT
from backend.tests.eval.learning_coach.schema import Fixture


def _fixture_to_context(fixture: Fixture) -> dict[str, Any]:
    return {
        "goal_title": fixture.goal,
        "subject": fixture.subject,
        "target_node": {"title": fixture.current_topic},
        "weak_nodes": [{"title": fixture.current_topic, "proficiency": fixture.proficiency}],
        "recent_summaries": [],
        "profile": {"current_goal": fixture.goal},
    }


def build_messages(fixture: Fixture) -> list[dict[str, str]]:
    context = _fixture_to_context(fixture)
    system = AGENTIC_SYSTEM_PROMPT + "\n\nContext JSON:\n" + json.dumps(context, ensure_ascii=False)
    msgs: list[dict[str, str]] = [{"role": "system", "content": system}]
    for m in fixture.recent_messages:
        msgs.append({"role": m.role, "content": m.content})
    msgs.append({"role": "user", "content": fixture.user_message})
    return msgs


async def _call_sut_llm(messages: list[dict[str, str]]) -> str:
    # call_llm takes a single prompt string. Concatenate messages as a structured prompt.
    parts = []
    for m in messages:
        parts.append(f"[{m['role'].upper()}]\n{m['content']}")
    prompt = "\n\n".join(parts)
    return await call_llm(prompt, model=settings.AGENT_MODEL, temperature=0.4)


async def run_case(fixture: Fixture) -> str:
    msgs = build_messages(fixture)
    return await _call_sut_llm(msgs)
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_runner.py -v
```
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add backend/tests/eval/learning_coach/runner.py backend/tests/eval/learning_coach/test_runner.py
git commit -m "Add eval runner: system prompt assembly + SUT LLM call"
```

---

## Task 6: 케이스 5개 작성

**Files:**
- Create: `backend/tests/eval/learning_coach/cases/new_topic_first_question.yaml`
- Create: `backend/tests/eval/learning_coach/cases/stuck_unknown_answer.yaml`
- Create: `backend/tests/eval/learning_coach/cases/goal_swap_detection.yaml`
- Create: `backend/tests/eval/learning_coach/cases/srs_due_review.yaml`
- Create: `backend/tests/eval/learning_coach/cases/session_close_signal.yaml`

- [ ] **Step 1: cases 디렉토리 생성**

```bash
mkdir -p backend/tests/eval/learning_coach/cases
```

- [ ] **Step 2: case 1 — new_topic_first_question.yaml**

```yaml
id: new_topic_first_question
description: 신규 토픽 진입 시 코치가 음성 친화 + 꼬리질문으로 시작하는가

fixture:
  goal: "DB 인덱스 마스터하기"
  subject: "Database"
  current_topic: "B-Tree 인덱스"
  proficiency: 0
  recent_messages: []
  user_message: "오늘은 B-Tree 인덱스부터 시작할게요"

rules:
  must_not_contain: ["```", "##", "**"]
  must_address_any: ["B-Tree", "비트리", "인덱스"]
  must_have_question: true
  max_chars: 600

judge:
  criteria: |
    신규 토픽 첫 발화 상황. 응답이:
    1. 학습자가 음성으로 듣기 좋은 자연스러운 한국어인가 (코드 블록·헤더·과한 별표 없음)
    2. 토픽의 핵심 개념을 한두 문장으로 안내하는가
    3. 학습자의 사전 지식을 확인하는 질문을 던지는가
  pass_threshold: 3
```

- [ ] **Step 3: case 2 — stuck_unknown_answer.yaml**

```yaml
id: stuck_unknown_answer
description: 사용자가 "모르겠다"고 했을 때 코치가 막힌 부분을 풀어주는가

fixture:
  goal: "DB 인덱스 마스터하기"
  subject: "Database"
  current_topic: "B-Tree 인덱스"
  proficiency: 10
  recent_messages:
    - role: assistant
      content: "B-Tree와 Hash 인덱스의 차이를 설명해보실 수 있나요?"
  user_message: "B-Tree랑 Hash 차이 모르겠어요"

rules:
  must_not_contain: ["```", "##"]
  must_address_any: ["B-Tree", "비트리", "해시", "Hash"]
  must_have_question: true
  max_chars: 700

judge:
  criteria: |
    사용자가 "모르겠다"고 한 상황. 응답이:
    1. 두 자료구조의 핵심 차이를 음성으로 듣기 좋게 설명하는가
    2. 학습자가 따라올 수 있는 비유나 예시를 쓰는가
    3. 다음 학습 단계로 이끄는 질문을 던지는가
  pass_threshold: 3
```

- [ ] **Step 4: case 3 — goal_swap_detection.yaml**

```yaml
id: goal_swap_detection
description: 목표 변경 신호를 코치가 인식하고 확인하는가

fixture:
  goal: "DB 인덱스 마스터하기"
  subject: "Database"
  current_topic: "B-Tree 인덱스"
  proficiency: 30
  recent_messages: []
  user_message: "사실 저 이제 Kubernetes 공부하고 싶어요"

rules:
  must_not_contain: ["```"]
  must_address_any: ["Kubernetes", "쿠버네티스", "목표", "변경"]
  must_have_question: true
  max_chars: 500

judge:
  criteria: |
    학습자가 명시적으로 다른 주제로 전환을 요청한 상황. 응답이:
    1. 목표 변경 의도를 명확히 인식하고 확인하는가
    2. 현재 진행 중인 학습을 마무리할지 즉시 전환할지 학습자에게 묻는가
    3. 강요나 거절 없이 학습자 주도성을 존중하는가
  pass_threshold: 3
```

- [ ] **Step 5: case 4 — srs_due_review.yaml**

```yaml
id: srs_due_review
description: 복습 due 토픽을 코치가 자연스럽게 꺼내는가

fixture:
  goal: "DB 인덱스 마스터하기"
  subject: "Database"
  current_topic: "Hash 인덱스 복습"
  proficiency: 55
  recent_messages: []
  user_message: "오늘 뭐부터 할까요?"

rules:
  must_not_contain: ["```"]
  must_address_any: ["Hash", "해시", "복습"]
  must_have_question: true
  max_chars: 500

judge:
  criteria: |
    복습 due 상황 (proficiency 중간 + 토픽 이름에 "복습" 명시). 응답이:
    1. 복습이 필요하다는 점을 자연스럽게 안내하는가
    2. 학습자가 기억을 떠올릴 수 있는 가벼운 질문으로 시작하는가
    3. 어려운 강의식이 아니라 대화체로 풀어가는가
  pass_threshold: 3
```

- [ ] **Step 6: case 5 — session_close_signal.yaml**

```yaml
id: session_close_signal
description: 사용자가 종료 의향을 보일 때 코치가 정리·요약을 제안하는가

fixture:
  goal: "DB 인덱스 마스터하기"
  subject: "Database"
  current_topic: "B-Tree 인덱스"
  proficiency: 40
  recent_messages:
    - role: user
      content: "B-Tree 노드 분할 이해했어요"
    - role: assistant
      content: "잘하셨어요. 인덱스 갱신 비용도 같이 볼까요?"
  user_message: "오늘은 여기까지 할게요"

rules:
  must_not_contain: ["```"]
  must_address_any: ["오늘", "정리", "요약", "마무리"]
  max_chars: 500

judge:
  criteria: |
    학습자가 종료 의향을 표현한 상황. 응답이:
    1. 종료 의사를 존중하며 강요하지 않는가
    2. 오늘 학습한 핵심을 한두 문장으로 정리해주거나 정리할지 묻는가
    3. 다음 학습으로 자연스럽게 이어가는 격려를 포함하는가
  pass_threshold: 3
```

- [ ] **Step 7: Commit**

```bash
git add backend/tests/eval/learning_coach/cases/
git commit -m "Add 5 initial eval cases for learning coach"
```

---

## Task 7: pytest 진입점 + conftest

**Files:**
- Create: `backend/tests/eval/learning_coach/conftest.py`
- Create: `backend/tests/eval/learning_coach/test_eval.py`

- [ ] **Step 1: conftest.py 작성**

`backend/tests/eval/learning_coach/conftest.py`:

```python
"""Eval pytest fixtures + case discovery."""
from pathlib import Path

import pytest

from backend.tests.eval.learning_coach.schema import Case, load_all_cases

CASES_DIR = Path(__file__).parent / "cases"


def all_cases() -> list[Case]:
    return load_all_cases(CASES_DIR)
```

- [ ] **Step 2: test_eval.py 작성**

`backend/tests/eval/learning_coach/test_eval.py`:

```python
"""Eval entrypoint — parametrized over case YAML files.

Run: pytest backend/tests/eval/learning_coach/ -m eval -v
"""
from __future__ import annotations

import pytest

from backend.tests.eval.learning_coach.conftest import all_cases
from backend.tests.eval.learning_coach.runner import run_case
from backend.tests.eval.learning_coach.schema import Case
from backend.tests.eval.learning_coach.scorers import check_judge, check_rules


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
```

- [ ] **Step 3: eval 마크 분리 확인 (평소 pytest에서 자동 skip)**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_eval.py -v
```
Expected: 5 deselected (마크 없으면 안 돎)

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_eval.py -m eval --collect-only
```
Expected: 5 tests collected (id가 케이스 id로 표시됨)

- [ ] **Step 4: Commit**

```bash
git add backend/tests/eval/learning_coach/conftest.py backend/tests/eval/learning_coach/test_eval.py
git commit -m "Add eval pytest entrypoint with case parametrization"
```

---

## Task 8: 실제 OpenAI 호출 1회 통과 확인

**Files:** (없음 — 검증 단계)

- [ ] **Step 1: OPENAI_API_KEY 설정 확인**

```bash
docker compose exec backend python -c "from app.config import settings; print(bool(settings.OPENAI_API_KEY))"
```
Expected: `True`

- [ ] **Step 2: 케이스 1개만 실제 실행 (비용 최소)**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_eval.py -m eval -v -k new_topic_first_question
```
Expected: PASS or FAIL with concrete output (응답 + judge 점수)

만약 룰 실패면: `must_address_any` 키워드 조정 또는 케이스 의도 재검토.
만약 judge 실패면: judge.criteria가 너무 빡빡한지, 또는 SUT 프롬프트가 실제로 약한 부분인지 검토.

- [ ] **Step 3: 5개 전체 실행**

```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/test_eval.py -m eval -v
```
Expected: 결과 표 출력 — 각 케이스 PASS/FAIL.

**전부 PASS일 필요는 없음.** 평가 하네스의 가치는 "현재 베이스라인을 측정"하는 것. 실패한 케이스는 issue로 기록하고 향후 프롬프트 튜닝 대상으로 둠.

- [ ] **Step 4: 평소 테스트에서 eval 자동 skip 검증**

```bash
docker compose exec backend pytest backend/tests/ -v --ignore=backend/tests/eval/learning_coach/test_eval.py 2>&1 | tail -5
```
또는 직접 -m eval 안 붙여서:
```bash
docker compose exec backend pytest backend/tests/eval/learning_coach/ -v
```
Expected: schema/scorers/runner 테스트는 PASS, test_eval.py는 deselected

- [ ] **Step 5: 결과 노트 커밋 (옵션)**

만약 일부 케이스가 fail이라면 `docs/eval-baseline-2026-04-25.md`에 baseline 점수 기록:

```markdown
# Learning Coach Eval Baseline — 2026-04-25

| Case | Rules | Judge | Note |
|---|---|---|---|
| new_topic_first_question | PASS | 4/5 | |
| stuck_unknown_answer | PASS | 3/5 | |
| ... | ... | ... | ... |
```

```bash
git add docs/eval-baseline-2026-04-25.md
git commit -m "Record initial eval baseline"
```

(전부 PASS면 이 단계 skip)

---

## Task 9: PR 머지 준비

- [ ] **Step 1: 전체 테스트 sanity check**

```bash
docker compose exec backend pytest backend/tests/ -v 2>&1 | tail -20
```
Expected: 기존 테스트 모두 PASS, eval 테스트는 자동 deselected

- [ ] **Step 2: spec 파일과 plan 파일 push**

```bash
git push -u origin feat/learning-coach-eval-harness
```

- [ ] **Step 3: PR 생성 (사용자 결정 후)**

머지 전 사용자가 직접 PR 생성. 본문에 spec 링크 + 베이스라인 결과 포함.

---

## Self-Review Notes

**Spec coverage:**
- ✅ 단일 응답 평가: Task 5 runner
- ✅ 룰 + LLM-judge: Task 3, 4
- ✅ 개별 YAML 케이스: Task 6
- ✅ pytest -m eval 격리: Task 1, 7
- ✅ SUT = AGENT_MODEL, Judge = EVAL_JUDGE_MODEL: Task 4, 5
- ✅ 케이스 5개: Task 6
- ⚠️ DB monkeypatch는 첫 PR에서 미적용 (graph 우회로 단순화). spec과 차이 — 위 runner 주석에 명시. 다음 PR에서 graph 통합 시 도입 예정.

**Placeholder scan:** 없음. 모든 코드/명령 구체적으로 명시.

**Type consistency:**
- `Case`/`Fixture`/`Rules`/`Judge`/`Message` 모든 task에서 동일 시그니처
- `RuleResult.failures: list[str]`, `JudgeResult.score: int` 일관
- `_call_judge_llm` / `_call_sut_llm` monkeypatch 경로 일치 (test 파일과 src 파일 패치 경로 동일)
