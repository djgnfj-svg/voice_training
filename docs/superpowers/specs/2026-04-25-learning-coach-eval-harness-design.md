# Learning Coach Eval Harness — Design

작성일: 2026-04-25
대상 모듈: `backend/app/agent/learning_coach/`
브랜치: `feat/learning-coach-eval-harness`

## 목적

Learning Coach 그래프의 응답 품질을 데이터셋 + 자동 채점으로 측정해, 프롬프트·모델 변경 시 회귀를 감지한다.

## 범위

**포함 (첫 PR):**
- 단일 응답(single-turn) 평가 단위
- 룰 채점기 + LLM-judge 채점기
- 케이스마다 개별 YAML 파일
- pytest 진입점 (`-m eval` 마크로 분리)
- 케이스 5개

**제외 (다음 PR):**
- 멀티턴 시나리오
- 응답 캐싱
- CI 통합
- 점수 리포트 JSON dump
- 50개 케이스 확장

## 결정 사항

| 항목 | 결정 |
|---|---|
| 평가 단위 | 단일 응답. 단, 케이스 스키마는 `recent_messages` 배열을 두어 멀티턴 확장 친화 |
| 채점 방식 | 룰 + LLM-judge 둘 다 |
| 케이스 형식 | 케이스마다 개별 YAML (`cases/<id>.yaml`) |
| SUT 모델 | `gpt-4o-mini` (운영 동일, `AGENT_MODEL` 따라감) |
| Judge 모델 | `gpt-4o` (`EVAL_JUDGE_MODEL` env로 오버라이드 가능) |
| 실행 | pytest, `@pytest.mark.eval` |
| DB 처리 | monkeypatch로 메모리 페이크 (graph의 DB 조회 함수만 패치, LLM은 진짜 호출) |

## 디렉토리 구조

```
backend/
├── tests/
│   └── eval/
│       └── learning_coach/
│           ├── __init__.py
│           ├── conftest.py          # pytest fixtures
│           ├── test_eval.py         # 진입점 (parametrize)
│           ├── runner.py            # graph 호출 어댑터
│           ├── scorers.py           # 룰 채점 + judge 호출
│           ├── schema.py            # YAML → dataclass + 로더
│           └── cases/
│               ├── new_topic_first_question.yaml
│               ├── stuck_unknown_answer.yaml
│               ├── goal_swap_detection.yaml
│               ├── srs_due_review.yaml
│               └── session_close_signal.yaml
└── pyproject.toml                   # `eval` marker + pyyaml 추가
```

**책임 분리:**
- `schema.py` — Case/Fixture/Rules/Judge dataclass, YAML 파싱, 케이스 로더
- `runner.py` — fixture를 graph에 주입하고 응답 받기
- `scorers.py` — 룰 채점 함수, judge 호출 함수
- `test_eval.py` — pytest 진입, 위 셋을 묶음
- `conftest.py` — `load_cases()` fixture, judge 클라이언트 fixture

## 케이스 스키마

```python
@dataclass
class Message:
    role: Literal["user", "assistant"]
    content: str

@dataclass
class Fixture:
    goal: str
    subject: str
    current_topic: str
    proficiency: int                 # 0~100
    recent_messages: list[Message]   # 멀티턴 확장용. single-turn은 []
    user_message: str                # 평가 직전 사용자 발화

@dataclass
class Rules:
    must_not_contain: list[str] = field(default_factory=list)
    must_address_any: list[str] = field(default_factory=list)
    must_have_question: bool = False
    max_chars: int | None = None

@dataclass
class Judge:
    criteria: str                    # judge에게 줄 평가 기준 (한국어)
    pass_threshold: int = 3          # 0~5 척도

@dataclass
class Case:
    id: str
    description: str
    fixture: Fixture
    rules: Rules
    judge: Judge
```

**YAML 예시 (`cases/stuck_unknown_answer.yaml`):**
```yaml
id: stuck_unknown_answer
description: 사용자가 "모르겠다"고 했을 때 코치가 막힌 부분을 풀어주는가

fixture:
  goal: "DB 인덱스 마스터하기"
  subject: "Database"
  current_topic: "B-Tree 인덱스"
  proficiency: 10
  recent_messages: []
  user_message: "B-Tree랑 Hash 차이 모르겠어요"

rules:
  must_not_contain: ["```", "##"]
  must_address_any: ["B-Tree", "비트리", "해시", "Hash"]
  must_have_question: true
  max_chars: 600

judge:
  criteria: |
    사용자가 "모르겠다"고 한 상황. 응답이:
    1. 두 자료구조의 핵심 차이를 음성으로 듣기 좋게 설명하는가
    2. 학습자가 따라올 수 있는 비유나 예시를 쓰는가
    3. 다음 학습 단계로 이끄는 질문을 던지는가
  pass_threshold: 3
```

## 데이터 흐름

```
1. pytest 수집 시 cases/*.yaml 로드 → Case 객체 리스트
2. 각 Case마다 parametrize로 test_eval 실행
3. runner.run_case(case.fixture):
   a. graph의 DB 조회 함수를 fixture 값 반환하도록 monkeypatch
   b. graph.ainvoke(state) 호출 — 실제 OpenAI(gpt-4o-mini) 호출됨
   c. assistant 응답 string 반환
4. scorers.check_rules(response, case.rules) — 동기, 모든 룰 검사
5. scorers.check_judge(response, case.judge, case.fixture) — gpt-4o 호출
6. assert: 룰 모두 pass + judge score >= pass_threshold
```

## Judge 프롬프트

```
당신은 한국어 학습 코치 응답을 평가하는 평가자입니다.

[사용자 발화]
{fixture.user_message}

[코치 응답]
{response}

[평가 기준]
{judge.criteria}

위 기준 각각이 얼마나 잘 충족되었는지 종합해서 0~5점으로 채점하세요.
JSON 외의 출력은 금지.
{"score": <0~5 정수>, "reason": "<한 문장 이유>"}
```

## 룰 채점기 의미

| 룰 | 의미 |
|---|---|
| `must_not_contain` | 문자열 중 하나라도 포함되면 fail (예: ```` ``` ````, `##` — 음성 부적합 마크다운) |
| `must_address_any` | 리스트 중 하나도 포함 안 되면 fail (핵심 키워드 누락 방지) |
| `must_have_question` | true면 응답에 `?` 또는 `？`가 없을 때 fail |
| `max_chars` | 응답 길이 초과 시 fail |

## 에러 처리

- YAML 파싱 실패 → pytest 수집 단계에서 명확한 에러 (schema 검증)
- graph 호출 중 LLM 에러 → 그 케이스만 fail, 나머지 진행
- judge JSON 파싱 실패 → 1회 재시도, 여전히 실패면 케이스 fail
- 케이스당 timeout 30초

## 비용

50케이스 1회 실행:
- SUT (`gpt-4o-mini`) 50회 ≈ $0.05
- Judge (`gpt-4o`) 50회 ≈ $0.50
- 합계 약 $0.55 (≈ 800원)

`-m eval`로 격리되어 평소 pytest 실행 시 자동 skip → 비용 미발생.

## 환경 변수

- `OPENAI_API_KEY` — 기존, SUT + Judge 공통
- `EVAL_JUDGE_MODEL` — 신규, 기본 `gpt-4o`
- `AGENT_MODEL` — 기존, SUT가 따라감

## 실행 명령

```bash
# 평가 전체
pytest backend/tests/eval/learning_coach/ -m eval -v

# 특정 케이스만
pytest backend/tests/eval/learning_coach/ -m eval -v -k stuck_unknown

# 평소 (eval 자동 제외)
pytest backend/tests/
```

## 첫 PR Definition of Done

1. 디렉토리/파일 골격 생성
2. `schema.py` — dataclass + YAML 로더 + 검증
3. `runner.py` — graph 호출 + DB monkeypatch
4. `scorers.py` — 룰 + judge
5. `test_eval.py` — pytest 진입점
6. 케이스 5개 YAML
7. `pyproject.toml` — `eval` marker 등록 + `pyyaml` 의존성 추가
8. `pytest -m eval` 로컬 1회 통과 확인
9. 무관한 일반 테스트(`pytest backend/tests/`)에서 eval 자동 skip 확인

## 향후 확장 (다음 PR 후보)

- 멀티턴: `recent_messages` 활용한 시나리오 케이스
- 응답 캐싱: 프롬프트 해시 기반 디스크 캐시
- 점수 리포트: pytest hook으로 JSON dump
- 케이스 확장: 5 → 50개
- CI 통합: nightly 또는 프롬프트 변경 PR 트리거
