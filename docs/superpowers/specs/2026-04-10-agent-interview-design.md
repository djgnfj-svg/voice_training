# AI 면접 코치 에이전트 시스템 설계

## 개요

사용자를 깊이 이해하고 기억하는 AI 면접 코치 에이전트.
기존 단일 LLM 호출 면접을 **멀티 에이전트 + RAG 기반 대화형 면접**으로 전환한다.

### 핵심 가치
- 사용자의 강점/약점/패턴/맥락을 장기 기억 (세션 간 RAG)
- 면접 도중 실시간 적응 (난이도 조정, 주제 전환)
- 질문을 미리 생성하지 않고, 대화 흐름에 따라 완전 동적 생성

### 범위
- **v1 (이번 구현)**: 프로필 에이전트 + 면접관 에이전트 + 평가 에이전트
- **v2 (향후)**: 리서치 에이전트 (회사/시장 분석 RAG)

---

## 아키텍처

```
클라이언트 (Next.js)
  │
  │  SSE 스트림 (질문/평가 실시간 전달)
  │
  ▼
FastAPI 엔드포인트 (/api/agent-interview/*)
  │
  ▼
오케스트레이터 (LangGraph 상태 머신 — 규칙 기반 분기, LLM 호출 없음)
  │
  ├→ 프로필 에이전트 (Haiku + pgvector RAG)
  │     - 면접 시작: 사용자 프로필 로드
  │     - 면접 종료: 평가 결과 기반 프로필 업데이트
  │     - tools: search_profile(), update_profile()
  │
  ├→ 면접관 에이전트 (Haiku, LLM 호출만)
  │     - 프로필+이력서+채용공고+대화 히스토리 기반 질문 동적 생성
  │     - 평가 결과 보고 다음 행동 결정 (꼬리질문/새질문/종료)
  │
  └→ 평가 에이전트 (Haiku, LLM 호출만)
        - 답변 평가 + 피드백 + 과거 약점 대비 성장 비교
```

### 오케스트레이터 상태 흐름

```
START → load_profile → generate_question → wait_answer
  → evaluate_answer → decide_next
      ├→ follow_up → wait_answer
      ├→ next_question → generate_question
      └→ end → update_profile → END
```

- 오케스트레이터는 LLM 호출 없이 상태 전이 규칙으로만 동작
- `decide_next`에서 면접관 에이전트가 다음 행동을 판단 (유일한 LLM 판단 지점)

### 멀티 에이전트 확장 설계

v1은 최소 단위(3개 에이전트)로 시작하되, 각 에이전트의 로직을 독립적인 tool 함수로 분리해둔다.
나중에 리서치 에이전트 추가 시 오케스트레이터에 노드 하나 추가 + tool 함수 연결로 확장 가능.

---

## LangGraph 상태 (State)

```python
class InterviewState(TypedDict):
    # 세션 기본 정보
    session_id: str
    user_id: str

    # 입력 컨텍스트
    resume: dict              # 파싱된 이력서
    job_posting: dict | None  # 채용공고 (선택)

    # 프로필 에이전트가 채움
    user_profile: dict        # RAG에서 로드한 사용자 프로필
                              # {strengths, weaknesses, history_summary, preferences}

    # 면접 진행 상태
    current_question: str     # 현재 질문
    current_answer: str       # 사용자 답변
    question_count: int       # 지금까지 질문 수
    follow_up_round: int      # 꼬리질문 라운드 (0=메인, 1=1차, 2=2차)

    # 평가 에이전트가 채움
    current_evaluation: dict  # 현재 답변 평가 결과

    # 면접관 에이전트가 채움
    next_action: str          # "follow_up" | "next_question" | "end"

    # 대화 히스토리 (면접관 에이전트의 컨텍스트)
    conversation_history: list[dict]  # [{role, question, answer, evaluation}]

    # 최종 결과
    overall_report: dict | None
```

---

## RAG: pgvector 스키마

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE user_profile_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES "User"(id),
    category VARCHAR(20) NOT NULL,  -- 'strength' | 'weakness' | 'pattern' | 'context'
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL, -- OpenAI text-embedding-3-small
    metadata JSONB DEFAULT '{}',     -- {topic, score, session_id, created_at 등}
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON user_profile_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 카테고리별 저장 예시

| category | content 예시 |
|----------|-------------|
| `strength` | "React 상태관리(useState, useReducer) 설명이 정확하고 실무 사례 풍부" |
| `weakness` | "DB 인덱싱 관련 질문에서 3회 연속 60점 이하, B-Tree 구조 설명 부정확" |
| `pattern` | "답변 초반에 결론 없이 배경부터 길게 설명하는 경향" |
| `context` | "본인 진술: React 실무 2년, 백엔드는 학습 중" |

### 프로필 에이전트 RAG 흐름

- **면접 시작**: `search_profile(user_id, query)` — 이력서+채용공고 키워드로 유사도 검색, 상위 10개 반환
- **면접 종료**: 평가 결과 분석 → 새 강점/약점 텍스트 생성 → 임베딩 생성 → upsert (기존 유사 항목은 업데이트)

### 임베딩 모델

OpenAI `text-embedding-3-small` (1536차원). 이미 Whisper용 OpenAI 키가 있으므로 추가 설정 불필요.

---

## 에이전트 상세

### 프로필 에이전트

- **역할**: 사용자를 "기억"하는 전담 에이전트
- **입력**: user_id, 이력서 (시작 시), 평가 결과들 (종료 시)
- **출력**: user_profile dict
- **tools**: `search_profile(user_id, query)`, `update_profile(user_id, category, content, metadata)`
- **면접 시작**: 이력서+채용공고 키워드로 관련 프로필 검색 → strengths/weaknesses/patterns/context 정리
- **면접 종료**: conversation_history + evaluations 분석 → 새 강점/약점/패턴을 RAG에 저장, 기존 유사 항목과 중복 방지

### 면접관 에이전트

- **역할**: 질문 생성 + 면접 흐름 결정
- **입력**: user_profile, resume, job_posting, conversation_history, current_evaluation
- **출력**: current_question, next_action
- **tools**: 없음 (LLM 호출만)
- **질문 생성**: 프로필 약점 + 이력서 + 채용공고 + 대화 흐름을 보고 "지금 이 사람에게 가장 필요한 질문" 1개 동적 생성
- **다음 행동 결정**: depth < 80 & follow_up_round < 2 → follow_up, question_count >= 설정값(기본 5~10, 세션 시작 시 사용자 선택) → end, 그 외 → next_question
- **사용자 명시적 입력 처리**: "나 이거 잘 알아" → 난이도 올림

### 평가 에이전트

- **역할**: 답변 평가 + 피드백
- **입력**: current_question, current_answer, user_profile, conversation_history
- **출력**: current_evaluation
- **evaluation 구조**:
  ```json
  {
    "scores": {"clarity": 0, "accuracy": 0, "practicality": 0, "depth": 0, "completeness": 0},
    "overall_score": 0,
    "brief_feedback": "",
    "detailed_feedback": "",
    "model_answer": "",
    "weakness_detected": null
  }
  ```
- **프로필 활용**: 과거 약점을 알고 있어서 "저번에도 이 부분 약했는데 이번엔 개선됐네요" 같은 맥춤 피드백 가능
- **weakness_detected**: 있으면 면접 종료 시 프로필 에이전트가 수집

---

## API 설계

### 에이전트 면접 세션

```
POST   /api/agent-interview/start     세션 생성 + 프로필 로드 + 첫 질문 (SSE)
POST   /api/agent-interview/answer    답변 제출 → 평가 + 다음 질문 (SSE)
POST   /api/agent-interview/end       면접 종료 + 프로필 업데이트 + 리포트
GET    /api/agent-interview/{id}      세션 조회
```

### 프로필

```
GET    /api/profile                   내 프로필 요약 조회
POST   /api/profile/context           명시적 컨텍스트 입력
```

기존 `/api/interview/*` API는 그대로 유지. 에이전트 면접은 별도 엔드포인트로 분리.

### SSE 스트림 이벤트

```
event: status      data: {"phase": "loading_profile"}
event: status      data: {"phase": "generating_question"}
event: question    data: {"question": "...", "questionNumber": 1}
event: status      data: {"phase": "evaluating"}
event: evaluation  data: {"score": 75, "feedback": "..."}
event: question    data: {"question": "꼬리질문...", "questionNumber": 1, "followUpRound": 1}
event: complete    data: {"reportId": "..."}
```

---

## 프론트엔드 플로우

### 새로운 대화형 면접 UI

```
[면접 시작 페이지]
  이력서 선택 + 채용공고(선택) + 마이크 확인
  → "AI 코치 면접 시작" 클릭

[면접 진행 페이지] — 대화형 UI
  에이전트가 SSE로 질문 → 사용자 음성 답변 → 평가 → 다음 질문
  대화 흐름이 실시간으로 표시됨

[리포트 페이지]
  기존 리포트 + 성장 비교 (과거 프로필 대비) 추가
```

---

## 기술 스택

| 구성요소 | 기술 |
|---------|------|
| 에이전트 오케스트레이션 | LangGraph |
| LLM | Claude Haiku (설정으로 교체 가능) |
| 벡터 DB | pgvector (Supabase PostgreSQL) |
| 임베딩 | OpenAI text-embedding-3-small |
| 프론트-백 통신 | SSE (Server-Sent Events) |
| 백엔드 | FastAPI (기존) |
| 프론트엔드 | Next.js (기존) |

### 새로운 의존성

- `langgraph` — 에이전트 오케스트레이션
- `pgvector` (SQLAlchemy 확장) — 벡터 검색

---

## LLM 모델 설정

모든 에이전트의 모델을 설정값으로 관리하여 추후 한 줄 변경으로 교체 가능하게 한다.

```python
# backend/app/config.py
AGENT_MODEL = "claude-haiku-4-5-20251001"  # 추후 Sonnet으로 교체 가능
```

---

## v2 확장 계획 (이번 구현 범위 밖)

- **리서치 에이전트**: Tavily 웹 검색 + 회사/시장 정보 RAG 저장/검색
- **모델 업그레이드**: 오케스트레이터 or 면접관 에이전트를 Sonnet으로
- **RAG 확장**: 기술 지식 베이스 (CS/React/Next.js 개념) 벡터화
