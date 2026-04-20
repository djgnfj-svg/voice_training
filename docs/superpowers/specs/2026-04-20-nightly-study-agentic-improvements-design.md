# CS 학습 어시스트 — 에이전트답게 동작하도록 개선

- 작성일: 2026-04-20
- 대상 모듈: `backend/app/agent/ns_*`, `backend/app/routers/nightly_study.py`, `backend/app/prompts/nightly_study.py`, `frontend/src/hooks/useNightlyStudyStream.ts`, `frontend/src/components/nightly-study/session-view.tsx`, `frontend/src/lib/nightly-study-api.ts`
- 관련 스펙: `docs/superpowers/specs/2026-04-17-nightly-study-redesign-design.md`

## 배경

CS 학습 어시스트(구 오늘의 학습 v2)는 2026-04-17 재설계 이후 운영 중이지만, 실제 사용 시 "에이전트답게" 움직이지 않는 세 가지 결함이 확인됨. 각 결함은 독립적으로 고칠 수 있으나, 모두 "상태 인지 + 진행 신호"라는 공통 축에 걸려 있어 한 스펙으로 묶어 처리.

### 검증된 현재 동작

1. **목표 변경 미반영** — `start_session`에서 `goal_id` 고정(`backend/app/routers/nightly_study.py`), 진행 중 유저가 새 목표를 말해도 현 세션의 curriculum은 이전 목표에 속함. `pivot` 툴은 같은 curriculum 내 주제 전환만 담당(`backend/app/agent/ns_pivot.py`).
2. **RAG 기반 이어가기 부재** — 세션 첫 인사는 LLM 없이 고정 템플릿(`backend/app/routers/nightly_study.py`의 `start_session`). RAG는 유저 발화 후 planner가 필요할 때만 호출되므로, 재방문 첫 인사에 과거 맥락이 전혀 반영되지 않음.
3. **진행 표시 부재** — SSE 이벤트는 `text/meta/error/end`만 있고 `phase` 이벤트 없음(`backend/app/agent/ns_orchestrator.py`). 프론트는 `isStreaming` boolean만 관찰(`frontend/src/hooks/useNightlyStudyStream.ts`) → planner/RAG latency 구간이 UI상 멈춘 것처럼 보임.

## 목표

- 재방문 시 "지난번 X 했죠, 오늘 Y 해볼까요?" 수준의 자연스러운 이어가기.
- 유저가 세션 중 새 목표를 말하면 감지 → 확인 → 현재 세션 curriculum 즉시 swap.
- 모든 긴 처리 구간(planner/RAG/LLM 생성)에 단계별 시각 피드백 노출.

## 비목표

- 자동 테스트 인프라 신설. nightly-study는 기존에 자동 테스트가 없고, 본 개선은 기반 변경이 아니라 UX/흐름 보강이므로 수동 체크리스트로 대응.
- 음성 효과음 추가. 음성 대화 주력 기능이므로 비프/차임은 대화 흐름을 방해함.
- `learning_goals`/`learning_messages`/`learning_embeddings` 등 기존 테이블 스키마 변경. `learning_sessions`에 pending 상태 저장용 JSONB 컬럼 1개만 추가(nullable).

## 설계

### 1. SSE `phase` 이벤트 + 프론트 인디케이터 (C)

**백엔드** — `backend/app/agent/ns_orchestrator.py`의 turn 처리 루프에 helper 추가.

```
async def emit_phase(phase: str, label: str) -> str:
    payload = {"phase": phase, "label": label}
    return f"event: phase\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
```

단계별 emit 지점:
- `thinking` — planner LLM 호출 직전
- `retrieving` — `retrieve_memory` 또는 RAG 검색 툴 실행 직전
- `generating` — 최종 응답 LLM 호출 직전

`label`은 한국어 한 줄 카피: "생각하는 중", "지난 대화 살펴보는 중", "답변 준비 중".

**프론트** — `frontend/src/hooks/useNightlyStudyStream.ts`에 `phase` state + `onPhase` 콜백 추가. `frontend/src/components/nightly-study/session-view.tsx`에 인디케이터 컴포넌트 배치 (대화 흐름을 깨지 않도록 말풍선 대체 자리 또는 상단 고정 바). `text` 이벤트가 처음 도착하면 phase 초기화.

**SSE 스키마**:
```
event: phase
data: {"phase": "retrieving", "label": "지난 대화 살펴보는 중"}
```

**`start_session` 응답에도 적용** — 첫 발화(특히 재방문 이어가기 LLM 호출) 전에 `retrieving`/`generating` phase를 짧게 방출해 로딩 구간을 감춤.

### 2. 재방문 세션 RAG 기반 이어가기 (B)

**분기 조건** — `backend/app/routers/nightly_study.py`의 `start_session`:
- 유저의 `learning_sessions` 레코드 수 == 0 → 기존 고정 자기소개 유지
- 그 외 → 신규 헬퍼 `generate_continuation_greeting(user_id, goal_id)` 호출

**헬퍼 위치** — `backend/app/agent/ns_orchestrator.py`에 추가 (또는 `ns_*` 중 greeter 전용 모듈로 분리 가능하나, 단일 함수라 orchestrator에 두는 쪽이 경로 단순).

**Context 수집 (동기, 한 번)**:
- 직전 `learning_sessions.summary` 1건 (최근 1개, NULL이면 skip)
- `node_mastery` 최근 7일 + proficiency 낮은 순 top-3
- 오늘 target node 임베딩으로 `learning_embeddings` 코사인 유사도 top-3
- 오늘 target node 제목

**LLM 호출** — `backend/app/lib/llm_client.py`의 `call_llm`, 새 프롬프트 상수 `CONTINUATION_GREETING_PROMPT` (`backend/app/prompts/nightly_study.py` 추가):

```
너는 CS 학습 코치다. 아래 맥락을 참고해 음성 대화용 이어가기 인사 1~2문장을 생성하라.

[지난 세션 요약] {last_session_summary}
[최근 약했던 개념] {weak_nodes}
[관련 기억] {rag_snippets}
[오늘 제안 주제] {target_node}

규칙:
- 반말 + 친근한 톤
- 1~2문장, 최대 60자
- 코드/리스트/마크다운 금지
- "안녕하세요" 같은 첫 인사말 금지 (이미 재방문)
- 오늘 제안 주제 자연스럽게 포함
```

**실패 처리** — LLM 호출 실패/타임아웃 시 기존 재방문 고정 템플릿("다시 오셨네요. 오늘은 '{target_node}' 해볼까요?")으로 fallback.

**phase 연동** — 이 LLM 호출 전에 `retrieving`/`generating` phase 방출.

### 3. 세션 중 목표 변경 감지 + Swap (A)

**2턴 프로토콜**.

**Turn 1 — 감지 & 확인 요청**:
- Planner 프롬프트(`backend/app/prompts/nightly_study.py`)에 의도 분류 `change_goal` 추가:
  - 감지 패턴 예시: "나 ~하려고", "목표를 ~로 바꿀래", "~도 준비할래", "~직군으로 갈래"
  - 단순 주제 언급(예: "React 해보고 싶어")은 `pivot_topic`으로 유지. `change_goal`은 직군/포지션/전공 수준 변경으로 한정
- 감지 시 planner가 `propose_goal_change` 액션 방출 (새 툴, `backend/app/agent/ns_tools.py` 또는 별도 모듈)
- 툴 동작:
  - DB 변경 **없음**
  - SSE `text`: "목표를 '{new_goal}'로 바꿀까요? 지금까지 진행한 '{old_goal}' 커리큘럼은 보관됩니다."
  - SSE `meta`에 `awaitingGoalConfirm: {proposedGoal: string}` 포함
- Pending 상태는 `learning_sessions.pending_action JSONB NULL` 컬럼에 저장. 값 예: `{"type": "goal_change", "proposedGoal": "프론트엔드 엔지니어", "proposedAt": "2026-04-20T..."}`. Turn 2 시작 시 planner가 세션 로드하며 `pending_action`을 읽어 분기.
- 마이그레이션: `ALTER TABLE learning_sessions ADD COLUMN IF NOT EXISTS pending_action JSONB NULL;` (신규 SQL 파일 1개, raw SQL)

**Turn 2 — 확인 & Swap**:
- planner가 pending `awaitingGoalConfirm` 있음을 인지
- 유저 응답 긍정 감지("응", "ㅇㅇ", "그래", "좋아", "바꿔줘" 등) 시 `confirm_goal_change` 툴 실행:
  1. `learning_goals.status = 'archived'` (기존 active)
  2. 새 `learning_goals` INSERT with `status='active'`, title=`proposedGoal`
  3. `ns_seed.generate_seed_curriculum(new_goal_id)` 호출 → `curriculum_nodes` INSERT
  4. 현재 `learning_sessions.goal_id` UPDATE + `target_node_id`를 새 시드의 첫 노드로 reset
  5. SSE `text`: 새 target node로 시작 멘트
  6. SSE `meta`: `goalChangedTo: {id, title}`, `nodeChangedTo: {...}`
- 부정 응답("아니", "놔둬" 등) 시 pending 해제, 기존 흐름 복귀

**프론트 반영** — `session-view`에서 `meta.awaitingGoalConfirm` 수신 시 별도 UI는 불필요 (AI 응답 텍스트가 이미 질문). `meta.goalChangedTo` 수신 시 headline 즉시 업데이트.

## 영향 범위

**백엔드**:
- `backend/app/agent/ns_orchestrator.py` — emit_phase helper, generate_continuation_greeting, pending goal change state 처리
- `backend/app/agent/ns_tools.py` (또는 신규 `ns_goal_change.py`) — propose_goal_change, confirm_goal_change
- `backend/app/prompts/nightly_study.py` — CONTINUATION_GREETING_PROMPT, planner 프롬프트에 change_goal intent
- `backend/app/routers/nightly_study.py` — start_session 분기 (첫 세션 vs 재방문)
- `backend/app/agent/ns_seed.py` — 목표 변경 시 재호출 (기존 함수 그대로 사용)

**프론트엔드**:
- `frontend/src/hooks/useNightlyStudyStream.ts` — phase 이벤트 파싱, onPhase 콜백
- `frontend/src/components/nightly-study/session-view.tsx` — 인디케이터, goalChangedTo 수신 시 headline 업데이트
- `frontend/src/lib/nightly-study-api.ts` — 필요 시 타입 추가 (`PhaseEvent`, `GoalChangedMeta`)

**DB** — `learning_sessions.pending_action JSONB NULL` 컬럼 1개 추가 (raw SQL 마이그레이션, Prisma 미관여). 나머지 테이블 스키마 변경 없음.

## 테스트 (수동 체크리스트)

1. **첫 세션 자기소개** — 신규 유저로 로그인 → 시작하기 → 고정 자기소개가 나옴 (LLM 호출 없음 확인, 네트워크 탭).
2. **재방문 이어가기** — 같은 유저로 2회차 세션 → 이어가기 인사 1~2문장 생성, 지난 주제 언급 + 오늘 target 포함.
3. **재방문 시 phase 노출** — 시작 버튼 누른 직후 `retrieving` → `generating` 인디케이터 관찰.
4. **Turn 중 phase 노출** — 유저 발화 직후 `thinking` → (필요 시 `retrieving`) → `generating` 순으로 노출.
5. **목표 변경 긍정 flow** — 세션 중 "나 프론트엔드로 바꿀래" → AI 확인 질문 → "응" → curriculum swap 확인 + 새 target node로 재시작 멘트.
6. **목표 변경 부정 flow** — 확인 질문 → "아니" → 원래 흐름 복귀, DB 변경 없음 확인.
7. **단순 주제 언급은 pivot** — "React 잠깐 해볼까" → `change_goal`이 아니라 `pivot_topic` 실행 확인.
8. **Fallback** — LLM 인위 실패(API 키 일시 제거 등) 시 고정 템플릿으로 재방문 인사 대체.

## 커밋 계획

메모리 원칙(작업 단위별 커밋 분리)에 따라 3 커밋, 쉬운 것부터:

1. `feat(nightly-study): SSE phase 이벤트 + 프론트 진행 인디케이터` — ① 전체
2. `feat(nightly-study): 재방문 세션 RAG 기반 이어가기 인사` — ② 전체. ①의 phase emit을 start_session 경로에 적용
3. `feat(nightly-study): 세션 중 목표 변경 감지 + 확인 후 curriculum swap` — ③ 전체 (마이그레이션 SQL 포함)

## 위험 & 완화

- **LLM 인사 생성 지연** — 첫 세션 시작 UX가 느려질 수 있음. 완화: phase 인디케이터로 신호 + 타임아웃 짧게(2~3초) + fallback 준비.
- **목표 변경 오탐** — 유저가 단순 호기심으로 말한 걸 변경으로 인지하면 귀찮음. 완화: planner 프롬프트에 change_goal 조건을 직군/포지션 수준으로 한정, 확인 질문으로 2단 방어.
- **Pending 영속 TTL** — `pending_action`이 남은 채 유저가 세션을 오래 방치하고 돌아와 다른 주제를 말하면 엉뚱하게 목표 변경으로 해석될 수 있음. 완화: planner가 `pending_action.proposedAt` 확인해 5분 이상 경과 시 무시 + 세션 종료(`end_session`) 시 `pending_action = NULL`로 초기화.
- **RAG 미스** — 재방문인데 과거 embedding/summary가 비어있는 경우. 완화: context 비어있으면 fallback 텍스트로 강등.
