# AI 코치 면접 평가 고도화 설계 (2026-04-15)

## 배경

현재 AI 코치 면접(에이전트 면접)의 평가/리포트는 다음 한계가 있다.

- **질문별 평가**: 5개 역량 점수(clarity/accuracy/practicality/depth/completeness) + 피드백/모범답안은 나오지만, **어떤 기술 개념이 답변에 있었고 빠졌는지**가 구조화되어 있지 않음. 피드백은 서술형이라 프론트가 요약·집계할 수 없음.
- **종합 리포트**: `generate_report`가 `conversation_history`를 원문 배열로 LLM에 통째 주입. 점수·phase·주제별 집계가 프롬프트에 없어 **LLM이 "느낌"으로 강점/약점 생성**. 강점/개선점이 어느 질문과 연결되는지도 불명.
- **사용자 요구**: "어느 기술이 어떻게 부족한지" **구체적 키워드 수준**으로 드러나야 함. "답변 깊이 부족" 같은 추상 서술 지양.

## 목표

1. **A 단계**: 리포트 생성 직전에 코드로 점수·phase·주제 집계를 만들어 프롬프트에 주입. LLM이 수치 근거로 리포트 작성.
2. **B 단계**: 리포트 스키마 확장. 강점/개선점에 질문 레퍼런스(`questionRefs`) 포함, `questionHighlights`·`phaseInsight`·`technicalDiagnosis` 필드 추가. 프론트 UI 확장.
3. **기술 키워드 축**: 질문별 평가에 `demonstratedKeywords` / `missingKeywords` 추가. 리포트는 이를 집계해 `technicalDiagnosis`에 `studyHint`까지 포함.

비목표: 기존 완료 세션 마이그레이션 없음(신 필드 미존재 시 프론트 방어적 렌더).

---

## A 단계: 리포트 집계 데이터 주입

### 서버 계산 집계 함수

`backend/app/agent/evaluator_agent.py`(또는 별도 `report_aggregator.py`)에 다음 순수 함수 추가.

```python
def aggregate_evaluations(conversation_history: list[dict]) -> dict:
    """
    각 턴의 evaluation을 모아 리포트 프롬프트에 주입할 집계 데이터 생성.

    Returns:
        {
            "categoryBreakdown": {
                "clarity": {"avg": float, "min": float, "max": float},
                "accuracy": {...},
                "practicality": {...},
                "depth": {...},
                "completeness": {...},
            },
            "overallStats": {"avg": float, "min": float, "max": float, "count": int},
            "extremes": {
                "best": {"qIdx": int, "question": str, "score": float},
                "worst": {"qIdx": int, "question": str, "score": float},
            },
            "phaseAnalysis": {
                "scan": {"avg": float, "count": int, "qIndices": [int]},
                "dive": {"avg": float, "count": int, "qIndices": [int]},
            },
            "diveTopicAnalysis": [
                {"topicLabel": str, "angle": "weakness"|"strength",
                 "avg": float, "qIndices": [int]}
            ],
            "keywordStats": {
                "demonstrated": [{"keyword": str, "count": int, "qIndices": [int]}],  # top 10
                "missing": [{"keyword": str, "count": int, "qIndices": [int]}],        # top 10
            },
        }
    ```

- 입력 `conversation_history`는 기존 구조 유지. 각 턴에서 `evaluation.scores.*`, `evaluation.overallScore`, `phase`, `topicLabel`/`angle`, `demonstratedKeywords`, `missingKeywords`를 읽는다.
- `phase`/`topicLabel`/`angle`은 이미 세션 state에 존재하는 `scan_plan` / `dive_plan` + `current_scan_idx` / `current_dive_idx`로부터 각 턴에 기록되도록 `nodes.py`에서 메시지 저장 시 주입. (현재 `AgentInterviewMessage`에는 없으므로 `evaluation` JSON 내부에 `meta.phase` 등으로 포함).
- 키워드 집계는 소문자 정규화 + 트리밍 후 빈도순 정렬. 동률 시 먼저 등장한 순.

### 리포트 프롬프트 수정

`backend/app/prompts/agent.py`의 `REPORT_PROMPT`에 `{aggregate_block}` 플레이스홀더 추가.

`evaluator_agent.generate_report()`에서:

1. `aggregate_evaluations(conversation_history)` 호출
2. 집계를 사람이 읽기 좋은 텍스트 블록으로 포맷 (JSON 덤프 아님 — 표/불릿으로)
3. 프롬프트에 주입

프롬프트 지시 핵심:

- "아래 집계 수치를 **근거로** 분석하라. 강점/개선점은 구체적 질문 번호와 기술 키워드를 인용하라."
- "추상 표현 금지. 반드시 기술 용어/개념명 인용."

---

## B 단계: 리포트 스키마 확장

### 신 리포트 JSON 구조

```jsonc
{
  "overallScore": 72.3,
  "summary": "전반적으로 React 렌더링 최적화에는 강하나 분산 시스템 개념이 약함. ...",

  // 기존 필드 (LLM 생성)
  "strengths": [
    { "text": "useMemo/useCallback의 의존성 배열 이해가 정확", "questionRefs": [2, 4] }
  ],
  "improvements": [
    { "text": "동시성 제어 개념 전반 누락", "questionRefs": [3, 7] }
  ],
  "growthNotes": null,
  "recommendations": ["Saga 패턴 학습", "MySQL 락 정리"],

  // 신규: 서버 계산 (LLM 생성 아님)
  "categoryBreakdown": {
    "clarity": { "avg": 78, "min": 60, "max": 95 },
    "accuracy": { "avg": 65, ... },
    ...
  },
  "phaseAnalysis": {
    "scan": { "avg": 74, "count": 3, "qIndices": [0, 1, 2] },
    "dive": { "avg": 68, "count": 4, "qIndices": [3, 4, 5, 6] }
  },
  "diveTopicAnalysis": [
    { "topicLabel": "분산 트랜잭션", "angle": "weakness", "avg": 52, "qIndices": [3, 4] }
  ],

  // 신규: LLM 생성
  "questionHighlights": {
    "best": { "qIdx": 2, "reason": "React fiber reconciliation을 구체적 예시로 설명" },
    "worst": { "qIdx": 3, "reason": "saga/2PC 언급 없이 'DB 롤백'으로만 답변" }
  },
  "phaseInsight": "훑기 단계에서는 프로젝트 맥락을 잘 설명했으나, 딥다이브로 갈수록 원리 설명이 얕아짐. ...",
  "technicalDiagnosis": {
    "strongTopics": [
      { "keyword": "React Hooks", "evidence": "Q2, Q4" }
    ],
    "weakTopics": [
      {
        "keyword": "분산 트랜잭션",
        "reason": "Q3에서 saga/2PC 언급 없이 'DB 롤백'으로만 답변",
        "studyHint": "Saga 패턴 + 보상 트랜잭션, 2PC의 blocking 특성"
      }
    ]
  }
}
```

### 프론트 UI 확장

`frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx`:

- **종합 분석 탭**: 상단에 `technicalDiagnosis.weakTopics` 카드 (keyword + reason + studyHint). `questionHighlights` 2카드(best/worst). `phaseAnalysis`를 scan vs dive 바 비교.
- **질문별 상세 탭**: 기존 점수 세부 + `demonstratedKeywords`(녹색 배지)·`missingKeywords`(빨간 배지) 표시.
- **개선점 탭**: `improvements[].questionRefs`로 각 항목을 클릭하면 해당 질문으로 점프.

방어적 렌더: 신 필드 `undefined` 시 해당 섹션 숨김. 기존 완료 세션도 정상 표시.

---

## 평가 프롬프트 변경 (`EVALUATOR_PROMPT`)

출력 JSON에 2개 필드 추가:

```jsonc
{
  "scores": { ... },
  "briefFeedback": "...",
  "detailedFeedback": "...",
  "modelAnswer": "...",
  "demonstratedKeywords": ["JWT", "refresh token rotation", "HttpOnly cookie"],
  "missingKeywords": ["CSRF 방어", "토큰 만료 처리"]
}
```

프롬프트 지시:

- "답변에서 실제로 다룬 기술 개념을 `demonstratedKeywords`에 원문 그대로 또는 정식 명칭으로 3~8개. 일반 단어(예: '서버', '데이터') 금지 — 식별 가능한 기술·패턴·개념만."
- "해당 질문 주제와 이력서의 기술스택을 고려할 때 **언급됐어야 하나 빠진** 핵심 개념을 `missingKeywords`에 0~5개. 없으면 빈 배열."
- "추상 표현(예: '이해 부족', '설명 부족') 금지. 반드시 기술 용어/개념명."

후처리(`_normalize_evaluation`):

- 두 배열 길이 상한 클램프(demonstrated 8, missing 5)
- 공백/중복 제거, 소문자 정규화 키로 dedupe하되 표시는 원형 유지
- `_quality_cap` 적용 답변은 두 배열 모두 빈 배열로 강제

---

## 데이터 저장

- `AgentInterviewMessage.evaluation` JSON에 신 필드 포함(스키마 변경 불필요, JSONB).
- `AgentInterviewSession.reportData` JSON에 신 필드 포함(스키마 변경 불필요).
- 각 턴 저장 시 `evaluation.meta`에 `phase` / `scanIdx` / `diveIdx` / `topicLabel` / `angle` 기록 → 집계 함수의 입력.

## 테스트

- `backend/tests/` 하에 `test_report_aggregator.py` 추가:
  - 빈 conversation → 안전하게 0/빈배열 반환
  - scan 3 + dive 3 샘플 → phaseAnalysis 정확
  - keyword 빈도 집계·중복 제거
  - `_quality_cap` 씌운 턴의 키워드 제외 확인
- `test_evaluator_agent.py`에 `demonstratedKeywords`/`missingKeywords` 클램프·dedupe 테스트 추가
- 수동: dev 환경에서 면접 1회 진행 → report 필드 전부 채워지는지 + 프론트 렌더 확인

## 구현 순서

1. `EVALUATOR_PROMPT` 확장 + `_normalize_evaluation` 클램프/dedupe (+ 단위 테스트)
2. `nodes.py`에서 각 턴 저장 시 `evaluation.meta` phase/topic 기록
3. `report_aggregator.py` 신설 + 단위 테스트
4. `REPORT_PROMPT` 재설계 + `generate_report` 집계 주입 + 신 스키마 출력
5. 프론트 `session/[id]/page.tsx` 방어적 렌더로 신 필드 표시
6. dev 통합 점검 → 커밋 분리(평가/집계/리포트/프론트)
