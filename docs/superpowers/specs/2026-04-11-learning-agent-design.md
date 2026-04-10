# Learning Agent (오늘의 학습 에이전트 리빌드)

> 기존 Nightly Study를 에이전트 기반으로 완전 대체. 질문 뱅크 제거, 동적 질문 생성, 프로필 RAG 연동, 하나의 주제를 깊이 파고드는 AI 튜터.

## 1. 핵심 목표

- **질문 뱅크 제거** — JSON 파일 없이 AI가 완전 동적으로 질문/설명 생성
- **프로필 RAG 연동** — 에이전트 면접과 동일한 `user_profile_embeddings` 공유. 면접에서 발견된 약점을 학습에서 보강, 학습 진도가 면접 프로필에 반영
- **깊이 있는 튜터링** — 핵심 개념 → 왜 이렇게 동작하는지 → 내부 원리 → 엣지 케이스 → 실무 응용 → 면접 출제 패턴까지 한 주제를 끝까지 파고듦
- **자유 주제** — 고정 카테고리 없이 "Redis 캐싱", "마케팅 퍼널" 등 어떤 주제든 가능

## 2. 아키텍처

에이전트 면접의 `state → nodes → SSE` 패턴을 복사하되, 학습 전용 노드를 새로 만듦. `profile_agent`와 `call_llm_json` 같은 공용 유틸은 공유. 면접 코드를 건드리지 않음.

```
[Frontend 음성 UI]
      ↕ (POST + SSE ReadableStream)
[FastAPI Router] ← 노드 오케스트레이션
      ↓
[LearningState] ← 공유 상태 TypedDict
      ↓
[Nodes] → load_profile (재사용) / teach (신규) / assess (신규) / check_credit (신규) / update_profile (재사용)
      ↓
[Claude API] + [OpenAI Embeddings] + [pgvector RAG]
```

## 3. 상태 (`LearningState`)

```python
class LearningState(TypedDict, total=False):
    session_id: str
    user_id: str
    topic: str                    # 첫 턴에서 사용자가 말한 주제
    user_profile: str             # RAG에서 로드된 프로필
    conversation_history: list    # 누적 대화
    current_phase: str            # "explain" | "check" | "deepen" | "apply" | "wrap_up"
    llm_call_count: int           # teach/assess 호출 카운트 (무료/크레딧 전환 기준)
    credit_activated: bool        # 크레딧 구간 진입 여부
    pending_events: list          # SSE 이벤트 큐
```

## 4. 노드 함수

| 노드 | 역할 | 출처 |
|------|------|------|
| `load_profile` | 주제 기반 RAG 검색 → 기존 학습 기록/강점/약점 로드 | `profile_agent` 재사용 |
| `teach` | phase에 따라 설명/심화/응용 생성 | 신규 (`tutor_agent`) |
| `assess` | 사용자 발화 이해도 판단 + 다음 phase 결정 | 신규 |
| `check_credit` | llm_call_count 확인 → 무료 한도 초과 시 안내 이벤트 | 신규 |
| `update_profile` | 세션 인사이트 → RAG upsert | `profile_agent` 재사용 |

## 5. 대화 흐름

```
세션 시작
  → AI: "오늘은 어떤 걸 공부하고 싶어요?" (TTS)
  → 사용자: "이벤트 루프" (음성)
  → load_profile("이벤트 루프") → RAG 검색
      ├─ 기록 있음 → "지난번에 기본은 봤으니, 마이크로태스크 큐부터 갈게요"
      └─ 기록 없음 → "이벤트 루프 처음이시네요, 왜 이게 필요한지부터 시작할게요"
  → teach(explain)

대화 루프
  → 사용자 음성 응답
  → assess → 이해도 판단
      ├─ understanding: "none"/"partial" → teach(explain) 보충
      ├─ understanding: "solid" → teach(deepen) 심화
      ├─ understanding: "deep" → teach(apply) 응용/면접 팁
      └─ 사용자가 끝내기 원함 → wrap_up
  → (매 턴 check_credit 실행)

세션 종료
  → teach(wrap_up) 오늘 배운 내용 정리 + 다음 추천
  → update_profile → RAG에 학습 진도 저장
```

## 6. Tutor Agent Phase별 행동

| Phase | AI가 하는 일 | 예시 |
|-------|------------|------|
| `explain` | 핵심 개념 체계적 설명. 왜 존재하는지, 어떻게 동작하는지 | "이벤트 루프는 싱글 스레드인 JS가 비동기를 처리하는 메커니즘이에요..." |
| `check` | 이해 확인 질문. 단답이 아니라 설명을 유도 | "setTimeout(fn, 0)이 바로 실행 안 되는 이유를 설명해볼 수 있어요?" |
| `deepen` | 내부 동작, 엣지 케이스, 흔한 실수, 관련 개념 | "마이크로태스크 큐가 매크로태스크보다 먼저 처리되는데..." |
| `apply` | 실무 활용, 면접 출제 패턴, 코드 예시 | "실제 면접에서는 console.log 실행 순서를 물어봐요..." |
| `wrap_up` | 오늘 정리 + 다음 주제 제안 | "오늘 기본 흐름을 잡았으니, 다음엔 async/await 내부 동작을 다뤄보면 좋겠어요" |

## 7. Assess 노드 판단 기준

LLM이 사용자 답변을 보고 JSON 반환:

```json
{
  "understanding": "partial",
  "weak_points": ["마이크로태스크 큐 우선순위 혼동"],
  "next_phase": "explain",
  "reasoning": "콜스택은 이해했지만 태스크 큐 구분이 아직 불명확"
}
```

- `understanding: "none"` → `next_phase: "explain"` (재설명)
- `understanding: "partial"` → `next_phase: "explain"` (보충) 또는 `"check"` (확인 질문)
- `understanding: "solid"` → `next_phase: "deepen"` (심화)
- `understanding: "deep"` → `next_phase: "apply"` (응용)

## 8. 크레딧 & 무료 전환

- **무료 구간**: LLM 호출 3회까지 (`load_profile` 제외, `teach`/`assess`만 카운팅)
- **전환 시점**: 4번째 LLM 호출 직전에 `check_credit` 노드가 SSE `credit_prompt` 이벤트 발생
  - "여기서부터 더 깊이 들어가면 크레딧이 사용돼요. 계속할까요?"
  - 사용자 "응" → `credit_activated = True`, 세션 종료 시 크레딧 차감
  - 사용자 "아니" → `wrap_up` → 무료로 종료
- **차감**: 세션 종료 시 1회 차감 (AI 호출 성공 후 차감, 선차감 금지)
- **하루 1회 무료**: 기존 일일 제한 로직 유지. 추가 세션은 처음부터 크레딧 필요

```
세션 시작 (오늘 첫 세션?)
  ├─ Yes → 무료 시작, llm_call_count = 0
  │         3회 호출 후 → "크레딧 쓸까요?" 안내
  │           ├─ Yes → 크레딧 모드, 세션 종료 시 차감
  │           └─ No  → wrap_up, 무료로 종료
  └─ No  → 크레딧 필요, 잔액 확인 후 시작
```

## 9. API 엔드포인트

| 메서드 | 경로 | 역할 | 응답 |
|--------|------|------|------|
| `POST` | `/api/nightly-study/start` | 세션 생성 + "오늘 뭐 할래?" 첫 인사 | SSE stream |
| `POST` | `/api/nightly-study/{id}/respond` | 사용자 발화 처리 (주제 선택/답변/계속·종료) | SSE stream |
| `POST` | `/api/nightly-study/{id}/end` | 수동 종료 → wrap_up + profile 저장 | SSE stream |
| `GET` | `/api/nightly-study/status` | 오늘 무료 학습 완료 여부 | JSON |

### SSE 이벤트 타입

| 이벤트 | 데이터 | 시점 |
|--------|--------|------|
| `session` | `{sessionId}` | 세션 생성 |
| `status` | `{phase}` | 처리 단계 변경 |
| `tutor` | `{message, phase}` | AI 발화 (TTS 재생 대상) |
| `credit_prompt` | `{message}` | 무료 한도 도달, 계속 여부 확인 |
| `complete` | `{summary}` | 세션 종료 + 요약 |
| `error` | `{error}` | 에러 |

## 10. DB 모델

### 신규 테이블

```sql
LearningAgentSession
  id              UUID PK
  user_id         FK → User
  topic           String (nullable, 첫 턴에서 결정)
  status          ACTIVE | COMPLETED | ABANDONED
  llm_call_count  Int default 0
  credit_deducted Boolean default false
  is_free_session Boolean default false
  created_at      DateTime
  updated_at      DateTime

LearningAgentMessage
  id              UUID PK
  session_id      FK → LearningAgentSession
  message_index   Int
  role            "tutor" | "user"
  content         Text
  phase           String (nullable)
  assessment      JSON (nullable, assess 노드 결과)
  created_at      DateTime
```

### 기존 테이블 변경

- `ActivityType` enum에 `LEARNING_AGENT` 추가
- `user_profile_embeddings` — 카테고리에 `learning_progress` 추가 (학습 진도 기록)

### 건드리지 않는 테이블

- `Subject` / `Topic` / `UserKnowledge` — 기존 코드에서 참조할 수 있으므로 삭제하지 않음

## 11. 프론트엔드 구조

### 페이지 (기존 URL 유지)

```
/nightly-study                  ← 시작 페이지 (새로 작성)
  page.tsx
  ├── 오늘의 무료 학습 상태 표시
  ├── 최근 학습 이력 카드
  └── "학습 시작" 버튼

/nightly-study/session          ← 세션 페이지 (새로 작성)
  page.tsx
  ├── useLearningAgent 훅
  ├── 음성 대화 UI (AI 발화 + TTS + 사용자 음성 입력)
  ├── phase 표시 (설명 중 / 심화 중 / 응용 중...)
  ├── 크레딧 전환 다이얼로그
  └── 세션 완료 요약 카드
```

### 훅

- `useLearningAgent` — 신규 (useAgentInterview 패턴 복사 + 학습 특화)
- `useSpeechRecognition` / `useTextToSpeech` / `useAudioRecorder` — 기존 재사용

### Phase FSM

```
idle → connecting → tutor-speaking → user-speaking → processing → tutor-speaking → ...
                                                        ↓ (credit_prompt)
                                                   credit-confirm
                                                     ├─ Yes → processing
                                                     └─ No  → completing → summary
                                                        ↓ (complete)
                                                     summary
```

### SSE 연결

`createSSEFromPost()` 그대로 재사용. URL만 `/api/nightly-study/` 로 변경.

### 사이드바

기존 "오늘의 학습" 메뉴 이름/위치 그대로 유지.

## 12. 프로필 RAG 활용

- **세션 시작**: 사용자가 말한 주제로 RAG 검색 → 이전 학습 기록 기반 시작점 결정
- **세션 중**: 약점 RAG 참조 → 해당 부분 집중 설명
- **세션 종료**: 새로 발견된 강점/약점/학습 진도를 RAG에 upsert
- **면접 연동**: 학습에서 저장된 프로필이 에이전트 면접에서도 참조됨 (선순환)

## 13. 삭제 대상

| 대상 | 이유 |
|------|------|
| `backend/data/questions/*.json` (7개) | 동적 생성으로 대체 |
| `backend/app/prompts/nightly_study.py` | 새 프롬프트로 교체 |
| `backend/app/services/nightly_study.py` | 에이전트 노드로 교체 |
| `backend/app/routers/nightly_study.py` | 새 라우터로 교체 |
| `frontend/src/hooks/useNightlyStudy.ts` | `useLearningAgent`로 교체 |
| `frontend/src/components/nightly-study/topic-selector.tsx` | 자유 입력으로 대체 |

## 14. 재사용 대상

| 대상 | 용도 |
|------|------|
| `profile_agent.py` / `embeddings.py` | RAG 로드/저장 |
| `call_llm_json()` | LLM 호출 |
| `createSSEFromPost()` | 프론트 SSE 파서 |
| `useSpeechRecognition` / `useTextToSpeech` / `useAudioRecorder` | 음성 훅 |
| `ActivityLog` / `ActivityItem` / `DailyProgress` | 활동 기록 |
| 에이전트 면접 nodes.py 패턴 | 상태 불변성, pending_events 큐 |

## 15. 음성 인터페이스

- 기존 nightly-study와 동일한 음성 전용 UX
- AI 발화: Edge TTS (`ko-KR-HyunsuNeural`)
- 사용자 입력: Web Speech API (실시간) + 선택적 Whisper (최종 전사)
- 침묵 자동 제출, 비활성 자동 종료 로직 유지
