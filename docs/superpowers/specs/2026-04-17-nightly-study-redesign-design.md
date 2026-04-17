# 오늘의 학습 재설계 (Nightly Study Rebuild)

**작성일**: 2026-04-17
**상태**: 설계 승인 대기

## 배경 및 목적

현재 "오늘의 학습"은 정적 Subject/Topic 트리 기반 튜터 대화 구조다. 이 구조는 "매일 꾸준한 학습 습관 형성"이라는 브랜드 포지셔닝과 맞지 않아 처음부터 다시 설계한다.

**핵심 컨셉**: 유저가 목표(예: "백엔드 엔지니어", "AI Agent 엔지니어")를 음성으로 입력하면, AI 에이전트가 매 세션 대화 속에서 유저의 현재 수준을 점진적으로 파악하며 기초부터 깊게 파고드는 맞춤형 학습 코치.

**타겟 환경**: 모바일 전용 (데스크톱 접근 시 안내 페이지로 리다이렉트)

## 핵심 설계 결정

| 항목 | 결정 |
|---|---|
| 목적 | 매일 꾸준한 학습 습관 + SRS 기반 장기 기억 |
| 주제 선택 | 유저 목표 입력 → 대화로 점진적 진단 |
| 커리큘럼 구조 | 시드(LLM 생성) + 대화 중 AI가 동적 확장 |
| 세션 중 주제 전환 | 유저 요청 시 허용 (pivot) |
| 세션 길이 | 1토픽 깊이 우선, 시간 무제한 |
| SRS 메커니즘 | proficiency(0~100) + nextReviewAt (내부용, UI 노출 안 함) |
| 대화 모드 | 적응형 — proficiency에 따라 튜터링/평가/소크라틱 자동 전환 |
| 입출력 | 음성 전용 (코드 블록/렌더링 없음) |
| 온보딩 | 대화 안에서 AI가 자연스럽게 목표 수집 (별도 화면 없음) |
| 과금 | 일일 무료 1세션 + 초과는 크레딧 1코인 |
| Planner | Agentic 툴 기반 — LLM이 매 턴 툴 선택 및 실행 |
| 세션 종료 | AI 제안 또는 유저 종료 버튼 |
| 기존 DB | 기존 6개 테이블(Subject/Topic/UserKnowledge/LearningAgentSession/LearningAgentMessage/DailyProgress) 전부 드롭 |
| 기억 | 구조화 필드(proficiency 등) + 학습 전용 pgvector RAG (면접/저널과 격리) |
| 세션 결과 | 카드 3장(하이라이트/이해한 것/streak) + 자동 TTS 음성 브리핑 |

## 아키텍처

```
Mobile browser
  ├─ STT (Web Speech API 또는 Whisper)
  ├─ TTS (기존 tts 서비스 — gpt-4o-mini-tts + sage + 2.0x)
  └─ UI: 단일 페이지 /nightly-study (시작 → 대화 → 브리핑)
       ↓ HTTPS/SSE
  ┌──────────────────────────────────────┐
  │ FastAPI: Learning Orchestrator        │
  │                                        │
  │ Planner (LLM 1회/턴)                   │
  │  └─ tool 선택 + 순차 실행 루프          │
  │                                        │
  │ Tools:                                 │
  │  ├─ retrieve_memory  (RAG 검색)         │
  │  ├─ evaluate_answer  (proficiency 갱신) │
  │  ├─ explain_concept  (튜터링 모드)      │
  │  ├─ ask_probing      (소크라틱 모드)    │
  │  ├─ quiz             (평가 모드)        │
  │  ├─ pivot_topic      (주제 전환)        │
  │  ├─ extend_curriculum(새 노드 생성)     │
  │  └─ suggest_end      (종료 제안)        │
  └──────────────────────────────────────┘
       ↓
  PostgreSQL (Supabase) + pgvector
```

**매 턴 흐름**:
1. 유저 발화 → STT → text
2. Planner LLM 호출 — 사용자 의도 분류(답변/질문/pivot) + 평가 + 다음 모드 + 실행할 툴 시퀀스 결정
3. 툴 순차 실행 (최대 3개, 평균 1~2개)
4. 최종 assistant 텍스트 → TTS → 재생
5. state 업데이트 (proficiency, RAG insert, streak 등)

**모드 선택 로직**:
- proficiency 0~30 → `tutoring` (AI가 개념 설명 → 이해 확인)
- proficiency 30~70 → `quiz` (AI가 질문 → 유저 답변 → 평가)
- proficiency 70+ → `socratic` (AI는 답 안 주고 유도 질문만)
- planner가 유저 상태 보고 override 가능

## DB 스키마 (신규 7개 테이블)

기존 6개 테이블은 전부 드롭. Prisma NextAuth 전용 원칙에 따라 SQLAlchemy + raw SQL 마이그레이션으로 관리.

### `learning_goals`
유저당 1개의 active 목표.
```sql
id                UUID PK
user_id           TEXT FK users.id
title             TEXT                    -- 원본 입력 (예: "AI Agent 엔지니어")
normalized_goal   TEXT                    -- LLM 정규화 키 (예: "AI_AGENT_ENGINEER")
status            TEXT                    -- 'active' | 'archived'
created_at        TIMESTAMPTZ
-- unique partial index: (user_id) WHERE status='active'
```

### `curriculum_nodes`
목표별 학습 노드. 시드(`source='seed'`) + 대화 중 확장(`source='extended'`) 혼재.
```sql
id            UUID PK
goal_id       UUID FK learning_goals.id
title         TEXT                        -- 예: "이벤트 루프"
description   TEXT                        -- 1~2줄 요약
depth_level   INT                         -- 0=뿌리(기초), 1=중간, 2=응용
parent_id     UUID FK self NULL           -- 의존성 (제네릭→타입시스템)
source        TEXT                        -- 'seed' | 'extended'
keywords      TEXT[]                      -- 매칭/검색용
created_at    TIMESTAMPTZ
-- INDEX on goal_id, parent_id
```

### `node_mastery`
유저별 노드별 SRS 상태.
```sql
user_id         TEXT
node_id         UUID FK curriculum_nodes.id
proficiency     INT                       -- 0~100
success_count   INT
failure_count   INT
streak_count    INT                       -- 연속 정답
last_studied_at TIMESTAMPTZ
next_review_at  TIMESTAMPTZ               -- 내부용, UI 노출 안 함
last_mode       TEXT                      -- 'tutoring' | 'quiz' | 'socratic'
PRIMARY KEY (user_id, node_id)
```

### `learning_sessions`
세션 단위 레코드.
```sql
id                 UUID PK
user_id            TEXT FK users.id
goal_id            UUID FK learning_goals.id
status             TEXT                   -- 'active' | 'completed'
started_at         TIMESTAMPTZ
ended_at           TIMESTAMPTZ NULL
turn_count         INT
is_free_session    BOOL
credit_deducted    INT                    -- atomic flag (중복 차감 방지)
summary            TEXT NULL              -- 종료 시 LLM 요약
highlights         JSONB NULL             -- {headline, learned[], improved[]}
voice_briefing     TEXT NULL              -- TTS 스크립트
```

### `learning_messages`
턴별 메시지 로그.
```sql
id             UUID PK
session_id     UUID FK learning_sessions.id
message_index  INT
role           TEXT                       -- 'user' | 'assistant'
content        TEXT
mode           TEXT NULL                  -- 이 턴의 모드
tool_calls     JSONB NULL                 -- planner가 실행한 툴+결과 (디버깅)
node_id        UUID FK curriculum_nodes.id NULL
created_at     TIMESTAMPTZ
```

### `learning_embeddings`
학습 전용 pgvector RAG. 면접/저널 RAG와 격리 (테이블 분리).
```sql
id         UUID PK
user_id    TEXT
node_id    UUID FK curriculum_nodes.id NULL
category   TEXT      -- 'misconception' | 'explanation' | 'connection' | 'question'
content    TEXT
embedding  VECTOR(1536)   -- OpenAI text-embedding-3-small
metadata   JSONB
created_at TIMESTAMPTZ
-- ivfflat index on embedding
```

### `learning_streaks`
유저별 연속 학습 집계.
```sql
user_id              TEXT PK
current_streak       INT                  -- 연속 학습일
longest_streak       INT
total_sessions       INT
total_nodes_learned  INT                  -- proficiency >= 70 도달 노드 수
last_session_date    DATE                 -- streak 계산용
```

## Planner & 툴 상세

### Planner 호출 포맷

**입력**:
```json
{
  "user_utterance": "이벤트 루프는 콜스택이랑 태스크 큐를 왔다갔다 하는 거죠",
  "current_node": { "id": "...", "title": "이벤트 루프", "depth_level": 1 },
  "current_mode": "quiz",
  "node_mastery": { "proficiency": 45, "streak": 0, "failures": 2 },
  "recent_messages": [/* 최근 6턴 */],
  "rag_hits": [/* retrieve_memory 선행 결과 top-3 */],
  "curriculum_context": {
    "root_nodes": [/* 현 goal의 뿌리 노드 3~5개 */],
    "parents_of_current": [/* 선행 노드 */]
  },
  "turn_count": 12,
  "session_started_minutes_ago": 8
}
```

**출력** (JSON):
```json
{
  "intent": "answer",          // answer | question | pivot | meta
  "pivot_target": null,        // intent=pivot이면 "gRPC" 등
  "evaluation": {              // intent=answer일 때만
    "correct": true,
    "partial": false,
    "proficiency_delta": 8,
    "misconception": null,
    "notes": "태스크 큐 정확. 마이크로태스크 언급 없음"
  },
  "next_mode": "socratic",
  "actions": [
    { "tool": "retrieve_memory", "args": { "query": "마이크로태스크 큐" } },
    { "tool": "ask_probing",     "args": { "hint": "마이크로태스크 vs 매크로태스크 구분", "depth_target": 70 } }
  ],
  "should_suggest_end": false,
  "briefing_note": "태스크 큐 개념 이해 확인됨"
}
```

### 툴 명세

| 툴 | 입력 | 출력 | LLM 호출 |
|---|---|---|---|
| `retrieve_memory` | query | RAG top-3 결과 | 임베딩 1회 |
| `evaluate_answer` | (planner 출력 수용) | `node_mastery` 갱신 | 없음 (DB write) |
| `explain_concept` | node, user_level | 설명 텍스트 | LLM 1회 |
| `ask_probing` | hint, depth_target | 소크라틱 질문 | LLM 1회 |
| `quiz` | node, difficulty | 평가 질문 | LLM 1회 |
| `pivot_topic` | target | 기존 노드 매칭 or 신규 생성 후 current_node 교체 | 매칭 실패 시 LLM 1회 |
| `extend_curriculum` | 오개념/빈틈 | 신규 `curriculum_nodes` INSERT | LLM 1회 |
| `suggest_end` | (없음) | 종료 제안 멘트 생성 | LLM 1회 |
| `create_goal` | title | `learning_goals` INSERT + 시드 생성 BackgroundTask 예약 | 없음 (백그라운드는 LLM 1회) |
| `generate_immediate_reply` | text | 고정 멘트 반환 (LLM 호출 없이 planner가 준 텍스트 그대로) | 없음 |

**턴당 LLM 호출 평균**: planner 1회 + 생성형 툴 1~2회 = 2~3회.

### Pivot 처리

```
intent=pivot 감지 (planner)
  ↓
pivot_target 추출 (예: "gRPC")
  ↓
curriculum_nodes에 기존 노드 매칭? (keywords/title 유사도)
  YES → current_node 전환
  NO  → extend_curriculum LLM 호출 → 새 노드 INSERT → current_node 전환
  ↓
전환 멘트 생성 ("네, gRPC로 넘어가죠. HTTP는 익숙하세요?")
```

**범위 밖 pivot** (예: "요리 알려줘") → planner가 `intent=meta`로 판정 → 거절 멘트 + 원래 주제 복귀.

## 온보딩 흐름 (대화 내 처리)

별도 온보딩 화면 없음. `learning_goals`가 없는 유저가 `/start`를 호출하면 `initialMode='onboarding'`로 표시되고, 프론트는 바로 세션 화면으로 진입한다. 이후 대화는 아래 흐름.

```
[turn 1]
  AI 첫 발화 (세션 생성 시 고정 프롬프트):
    "어떤 개발자가 되고 싶으세요?"
  유저: "AI Agent 엔지니어"

[turn 2 처리]
  planner 입력: current_node=null, current_mode='onboarding'
  planner 출력:
    - intent: 'meta'
    - actions: [
        { tool: 'create_goal', args: { title: "AI Agent 엔지니어" } },
        { tool: 'generate_immediate_reply', args: { text: "좋아요, 같이 기초부터 해볼게요. 잠시만요..." } }
      ]
  백그라운드(BackgroundTask): 시드 커리큘럼 LLM 생성 → curriculum_nodes INSERT → learning_goals.status='active'
  assistant 응답 즉시 반환 (유저 대기 ~0초)

[turn 3 처리]
  시드 생성 완료. planner가 current_node 선정 (depth_level=0 노드 중 하나)
  이후 일반 학습 흐름
```

**시드 생성이 turn 3까지 안 끝나면**: planner가 "잠시 기다려 주세요" 멘트 반복. 실패 시 에러 메시지 (유저가 다시 시작).

## 시드 커리큘럼 생성

**프롬프트 요지**:
```
유저 목표: "{title}"
시드 커리큘럼을 JSON 배열로 생성하라.
- 뿌리 노드 8~15개 (이 목표 달성에 필수인 기초 개념)
- 각 노드: {title, description, depth_level, parent_id, keywords[]}
- 실제 면접/실무에서 자주 묻히는 기초에 편중
- "배우고 싶은 프레임워크"가 아니라 "프레임워크를 이해하는 데 필요한 원리" 중심
```

## 프론트 UX

**라우트**: `/nightly-study` (단일 페이지)

**모바일 전용**:
- `frontend/middleware.ts`에 UA 체크 추가
- 데스크톱 UA → `/nightly-study/mobile-only` 안내 페이지 (QR 코드로 내 폰에서 열기)

### 랜딩 상태

```
상단 미니: 🔥 N일 streak | 총 M개 학습
중앙 큰 버튼: ● 시작 (마이크 아이콘)
하단: 이전 세션 5건 접힘 (확장 시 브리핑 재생 가능)
```

### 대화 중 상태 (전체 화면)

```
상단: 현재 토픽 배지 (예: "이벤트 루프")
중앙: transcript (유저/AI 말풍선)
하단 컨트롤: [말하기(push-to-talk)] [종료]
```

### 종료 후 브리핑 상태

```
카드 1: 오늘의 하이라이트 (1줄)
카드 2: 새로 이해한 것 / 개선 포인트 (토픽별 변화)
카드 3: Streak / 진도 (🔥 N일, 총 M개)
  ↓
자동 TTS 재생: "지난번엔 X를 헷갈려했는데 오늘은 원리를 설명했어요..."
  ↓
[확인] → 홈으로
```

## API 엔드포인트

### `POST /api/nightly-study/start`
- Body: 없음
- 처리:
  1. 기존 `active` 세션 있으면 `completed`로 자동 close (요약 없이)
  2. 일일 무료 판정: 당일 `is_free_session=true` 세션 없으면 무료
  3. 무료 아니면 credit_balance >= 1 확인 + 원자적 차감 (`WHERE credit_balance >= 1` 조건부 UPDATE, rowcount 체크)
  4. 크레딧 부족 → 402 `{ error, code: "INSUFFICIENT_CREDITS" }`
  5. `learning_goals` 조회:
     - 없으면 `initialMode='onboarding'` 반환
     - 있으면 SRS로 다음 노드 선정 (`next_review_at <= now` OR 신규 노드) → `initialMode='learning'`
  6. `learning_sessions` INSERT
- 응답: `{ sessionId, initialMode, targetNode? }`

### `POST /api/nightly-study/{sessionId}/turn` (SSE 스트림)
- Body: `{ userUtterance: string }`
- 소유권 검증: `session.user_id == req.user.id`
- SSE events:
  - `text` — assistant 메시지 청크
  - `meta` — 턴 메타데이터 (현 모드, 노드 교체, proficiency 변화 등)
  - `end` — 턴 완료
  - `error` — 에러
- 내부 처리: planner → 툴 순차 실행 → state 업데이트

### `POST /api/nightly-study/{sessionId}/end`
- Body: `{ reason: "user" | "ai_suggested" }`
- 처리:
  1. `status='completed'`, `ended_at=now`
  2. LLM 호출: 요약 + highlights + voice_briefing 생성
  3. `node_mastery` 최종 반영
  4. `learning_streaks` 업데이트 (오늘 `last_session_date`면 streak+1, 아니면 1)
  5. BackgroundTask로 `learning_embeddings` INSERT (오개념/핵심 설명)
- 응답: `{ summary, highlights, voiceBriefing, streakUpdated }`

### `POST /api/nightly-study/goal`
- Body: `{ title: string }`
- 처리: 기존 active goal을 archived로, 새 active INSERT, 시드 커리큘럼 LLM 생성 후 INSERT
- 온보딩 + 변경 겸용 단일 엔드포인트
- 응답: `{ goalId, seedNodeCount }`

### `GET /api/nightly-study/status`
- 응답:
  ```json
  {
    "dailyFreeUsed": false,
    "creditBalance": 15,
    "streak": { "current": 5, "longest": 12, "totalSessions": 23, "totalNodesLearned": 18 },
    "hasGoal": true,
    "todayTargetNode": { "title": "이벤트 루프", "description": "..." },
    "recentSessions": [/* 최근 5건 id/startedAt/headline */]
  }
  ```

### `GET /api/nightly-study/sessions/{sessionId}`
- 브리핑 재생 및 과거 세션 상세 조회
- 응답: `{ session, messages[], highlights, voiceBriefing }`

## 에러 처리

| 시나리오 | 처리 |
|---|---|
| 크레딧 부족 | `/start` 402 → `/credits` 리다이렉트 |
| 데스크톱 접근 | 미들웨어에서 `/nightly-study/mobile-only` 안내 페이지로 |
| LLM / STT / TTS 실패 | "다시 시도해주세요" 에러 표시. 세션은 유지 |
| Pivot 범위 밖 요청 | Planner가 `intent=meta` 판정 → 거절 멘트 + 원 주제 복귀 |
| 기존 active 세션 존재 | `/start` 호출 시 자동 close 후 새 세션 |
| 탭 닫힘 / 네트워크 끊김 | 서버 개입 없음. 다음 `/start` 때 자동 close |

**의도적으로 구현하지 않는 것**:
- 세션 이어하기 / resume
- 턴 수 상한 가드
- abandoned 상태 전이 / cron 청소
- LLM 재시도 / fallback 체인
- 음성 인식 다단계 폴백

## 테스트

**백엔드 (단위)**:
- proficiency 계산 (evaluate 결과 → delta 적용)
- SRS `next_review_at` 산출 규칙
- streak 업데이트 로직 (연속일 / 갭 / 리셋)
- pivot 매칭 (키워드 유사도 매칭)

**백엔드 (통합)**:
- `/start` → `/turn × N` → `/end` 전체 플로우 (LLM mock)
- 일일 무료 판정 (같은 날 두 세션이면 두 번째는 차감)
- 크레딧 원자성 (잔액 부족 시 차감 안 됨)
- 소유권 (타인 세션 403)

**프론트**:
- `useNightlyStudyStream` 훅 SSE 이벤트 파싱
- 랜딩 → 대화 → 브리핑 E2E (MSW로 SSE mock)
- middleware UA 차단 확인

**수동 체크**:
- 실제 모바일 Chrome/Safari 음성 입출력
- 온보딩 첫 턴 응답 지연 (시드 생성 백그라운드 체감)

## 파일 구조 (예정)

### 백엔드
```
backend/app/
  agent/
    learning_v2_planner.py       # planner LLM 래퍼
    learning_v2_tools.py         # 8개 툴 구현
    learning_v2_nodes.py         # 오케스트레이터 (plan → action 루프)
    learning_v2_state.py         # 상태 타입
    learning_v2_rag.py           # learning_embeddings 검색/저장
    learning_v2_srs.py           # proficiency / next_review 계산
    learning_v2_seed.py          # 시드 커리큘럼 LLM 생성
    learning_v2_summarizer.py    # 세션 요약 + 브리핑 생성
  prompts/
    learning_v2.py               # planner / tutor / quiz / socratic / seed / summary 프롬프트
  routers/
    nightly_study.py             # API 엔드포인트 (기존 nightly-study 라우터 교체)
  db/migrations/
    YYYYMMDD_nightly_study_v2.sql  # 기존 6개 테이블 DROP + 신규 7개 CREATE
```

### 프론트
```
frontend/src/
  app/(authenticated)/nightly-study/
    page.tsx                     # 랜딩 (단일 페이지)
    mobile-only/page.tsx         # 데스크톱 안내
  components/nightly-study/
    session-view.tsx             # 대화 중 화면
    briefing-view.tsx            # 종료 후 카드 3장 + TTS
    streak-badge.tsx
  hooks/
    useNightlyStudyStream.ts     # SSE 파싱
  lib/
    nightly-study-api.ts         # API 클라이언트
  middleware.ts                  # UA 체크 추가
```

## 기존 코드 정리

삭제 대상:
- `backend/app/agent/learning_nodes.py`
- `backend/app/agent/learning_planner.py`
- `backend/app/agent/learning_state.py`
- `backend/app/agent/tutor_agent.py`
- `backend/app/prompts/learning.py` (기존)
- `frontend/src/app/(authenticated)/nightly-study/session/page.tsx`
- `frontend/src/lib/learning-agent-api.ts` (기존)
- Prisma 스키마에서 `Subject`, `Topic`, `UserKnowledge`, `LearningAgentSession`, `LearningAgentMessage`, `DailyProgress` 모델 제거

## 마이그레이션 순서 (구현 시 참조)

1. 새 마이그레이션 SQL 작성 (기존 6 테이블 DROP → 신규 7 테이블 CREATE)
2. 백엔드 신규 모듈 작성 (prompts → tools → planner → nodes → router)
3. 프론트 신규 페이지/훅/컴포넌트 작성
4. middleware UA 차단 추가
5. 기존 코드 삭제 + Prisma 스키마 정리
6. 수동 테스트 (실제 모바일)

## 적용 원칙 (프로젝트 규칙)

- Prisma는 NextAuth 전용. 에이전트 테이블은 SQLAlchemy + raw SQL
- 저널/면접 RAG와 격리 — `learning_embeddings` 테이블 분리
- 크레딧 차감은 AI 호출 성공 후. 원자적 `credit_deducted` flag로 중복 방지
- 무료 체험은 `WHERE ... AND is_free_session=true` 원자적 UPDATE
- DB 리소스 조회 시 `user_id` 소유권 검증
- HTTPException detail은 `{"error": "..."}` 형태로 통일
- 음성 전용, 코드 블록/렌더링 없음
