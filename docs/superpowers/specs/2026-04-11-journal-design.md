# 하루의 정리 — 설계 스펙

## 개요

사이드바 "하루의 정리" 메뉴로 진입하는 음성 기반 일기/상담 기능. 사용자가 하루를 말로 정리하면 멀티에이전트가 대화를 이끌고, 백그라운드에서 핵심 정보를 RAG에 저장한다. 대화 흐름에 따라 정리 에이전트 ↔ 상담 에이전트가 자연스럽게 전환된다.

## 핵심 결정 사항

- **진입점**: 사이드바 메뉴 "하루의 정리"
- **음성 필수**: VoicePrep 컨셉 — 말하면서 하루를 정리
- **대화 모드**: 하나의 대화에서 일기/상담이 자유롭게 섞임, 라우터가 자동 분기
- **RAG 범위**: 일상 전체 (감정, 사건, 커리어, 인간관계 등)
- **RAG 분리**: 면접용 프로필 RAG와 완전 분리 (별도 테이블)
- **세션**: 사용자 명시적 종료 + 2분 무응답 타임아웃. 이어하기 지원
- **과금**: 일정 메시지까지 무료, 초과 시 메시지당 코인 차감
- **히스토리**: 과거 대화는 AI 요약만 열람 가능
- **톤**: 정리 모드에서는 가벼운 톤, 상담 깊어지면 진지한 톤

---

## 1. LangGraph 상태 머신 & 에이전트 구성

### State

```python
class JournalState(TypedDict):
    session_id: str
    user_id: str
    messages: list[Message]        # 전체 대화 히스토리
    mode: Literal["journal", "counseling"]  # 현재 모드
    extracted_count: int           # 이번 세션 추출된 항목 수
    message_count: int             # 과금용 메시지 카운트
    pending_events: list           # SSE 이벤트 큐
    session_summary: str | None    # 종료 시 생성
```

### 노드 & 흐름

```
[시작] → router → journal_agent ↔ counseling_agent
                         ↘          ↙
                      extractor (병렬)
                            ↓
                    [종료 트리거] → summarizer → [끝]
```

1. **router** — 사용자 메시지의 의도를 분류. 규칙 기반 우선 (키워드/감정어 매칭), 애매하면 가벼운 LLM 분류. 현재 mode와 함께 고려해서 불필요한 전환 방지.
2. **journal_agent** — 하루 돌아보기. 가벼운 톤, "오늘 뭐했어?", "그거 어땠어?" 식으로 이끌어감.
3. **counseling_agent** — 고민/감정 깊이 탐색. 진지한 톤, 공감 + 구조화된 질문.
4. **extractor** — 매 턴 병렬 실행. 대화에서 저장할 정보 판별 → RAG 저장. 대화 응답에는 영향 없음.
5. **summarizer** — 세션 종료 시 하루 요약 생성 + RAG에 `daily_summary` 카테고리로 저장.

### 종료 조건

- 사용자 명시적 종료 ("끝", "마무리" 등)
- 2분 이상 무응답 → 프론트에서 타이머로 감지 → 종료 API 호출
- 종료 시 summarizer 실행 → 요약 반환

---

## 2. RAG 데이터 모델 & 저장 전략

### 테이블: `journal_embeddings`

기존 `user_profile_embeddings`와 완전 분리. 구조는 유사하되 카테고리가 다름.

```sql
journal_embeddings:
  id: UUID (PK)
  user_id: UUID (FK → User)
  category: VARCHAR        -- 아래 카테고리 참조
  content: TEXT            -- 추출된 정보 원문
  embedding: VECTOR(1536)  -- OpenAI text-embedding-3-small
  metadata: JSONB          -- 날짜, 감정 강도, 관련 세션 등
  created_at: TIMESTAMP
  updated_at: TIMESTAMP
```

### 카테고리 체계

| 카테고리 | 설명 | 예시 |
|---------|------|------|
| `emotion` | 감정 상태 | "직장 상사 때문에 스트레스" |
| `event` | 일상 사건 | "팀 회식에서 발표함" |
| `growth` | 성장/배움 | "Docker 네트워크 이해하게 됨" |
| `concern` | 고민/걱정 | "이직할지 고민 중" |
| `relationship` | 인간관계 | "동료 A와 갈등 해소" |
| `goal` | 목표/계획 | "다음 달까지 포트폴리오 완성" |
| `daily_summary` | 하루 요약 | summarizer가 생성한 세션 요약 |

### 저장 전략

- **유사도 0.85 이상** → 기존 임베딩 업데이트 (중복 방지)
- **미만** → 신규 삽입
- **metadata에 날짜 필수** — 이어하기 시 "오늘 추출된 것" 필터링에 사용
- **extractor는 매 턴 실행**하되, 저장할 게 없으면 스킵

### 이어하기 시 컨텍스트 복원

1. 오늘 날짜의 `journal_embeddings` 조회 (이미 추출된 인사이트)
2. 마지막 세션의 최근 5개 메시지
3. 세션 요약 (`daily_summary` 카테고리)

이 3가지를 시스템 프롬프트에 주입해서 맥락 유지.

---

## 3. DB 모델

### JournalSession

```
JournalSession:
  id: UUID (PK)
  user_id: UUID (FK → User)
  status: "active" | "completed" | "timeout"
  message_count: INT
  free_messages_used: INT     -- 무료 메시지 소진 수
  credits_charged: INT        -- 차감된 코인 총합
  summary: TEXT | NULL        -- summarizer 생성
  created_at: TIMESTAMP
  updated_at: TIMESTAMP
```

### JournalMessage

```
JournalMessage:
  id: UUID (PK)
  session_id: UUID (FK → JournalSession)
  message_index: INT
  role: "user" | "assistant"
  content: TEXT
  mode: "journal" | "counseling"   -- 해당 메시지 시점의 모드
  created_at: TIMESTAMP
```

---

## 4. API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/journal/start` | 세션 시작. 오늘 active 세션 있으면 이어하기 |
| POST | `/api/journal/message` | 메시지 전송 → SSE 스트림 응답 |
| POST | `/api/journal/end` | 세션 종료 → summarizer 실행 → 요약 반환 |
| GET | `/api/journal/history` | 과거 세션 요약 목록 (날짜별) |
| GET | `/api/journal/{id}` | 특정 세션 요약 상세 |

### SSE 이벤트 타입

- `status` — 모드 전환 알림 ("상담 모드로 전환합니다")
- `response` — AI 응답 텍스트 스트림
- `extracted` — 추출된 정보 알림 (선택적, UI에 표시할지는 프론트 결정)
- `summary` — 세션 종료 시 요약

### 과금 로직

- 세션 시작 시 크레딧 체크 없음 (무료 메시지가 있으니까)
- 메시지마다 `free_messages_used` 체크
- 무료 한도 초과 시 → 메시지당 코인 차감 (기존 원자적 차감 패턴 `WHERE credit_balance >= cost`). 무료 한도 수와 초과 단가는 구현 시 설정값으로 관리 (하드코딩하지 않음)
- 잔액 부족 시 402 응답 + `INSUFFICIENT_CREDITS`

### 이어하기 로직 (`/api/journal/start`)

1. 오늘 날짜 + user_id + status="active" 세션 조회
2. 있으면 → 컨텍스트 복원 (RAG + 최근 5메시지 + 요약) 후 이어하기
3. 없으면 → 새 세션 생성

---

## 5. 프론트엔드 구조

### 라우트

- `/journal` — 메인 페이지 (대화 인터페이스)
- `/journal/history` — 과거 요약 목록

### 사이드바

`components/layout/sidebar.tsx`에 "하루의 정리" 메뉴 추가. 면접 시작과 모범답안 사이 위치.

### 컴포넌트

```
app/(authenticated)/journal/
  page.tsx                     # 메인 페이지
  history/page.tsx             # 요약 히스토리

components/journal/
  journal-panel.tsx            # 대화 패널 (메시지 목록 + 음성 입력)
  journal-message.tsx          # 개별 메시지 (모드별 스타일 차이)
  mode-indicator.tsx           # 현재 모드 표시 (정리/상담)
  session-summary-card.tsx     # 요약 카드 (히스토리용)
  voice-input-bar.tsx          # 하단 음성 입력 바 (녹음 버튼 + 파형)
```

### 음성 입력 플로우

기존 면접의 음성 파이프라인 재활용:
1. 하단 마이크 버튼 클릭 → 녹음 시작 (`useAudioRecorder`)
2. 실시간 Web Speech API로 텍스트 표시
3. 녹음 중지 → Whisper 전사 (있으면) → `/api/journal/message`로 전송
4. SSE로 AI 응답 스트림 수신
5. AI 응답은 Edge TTS로 음성 재생 (`ko-KR-HyunsuNeural`)

### 2분 타임아웃 처리

프론트에서 마지막 사용자 입력 후 2분 타이머:
1. "오늘은 여기까지 할까요?" 토스트 표시
2. 10초 무응답 → `/api/journal/end` 호출
3. 요약 수신 → 요약 카드로 전환

### hooks

```
hooks/
  useJournalSession.ts    # 세션 시작/이어하기/종료 관리
  useJournalSSE.ts        # SSE 스트림 처리 (createSSEFromPost 재활용)
  useInactivityTimer.ts   # 2분 비활동 타이머
```

---

## 6. 에러 핸들링 & 엣지 케이스

### 에러 처리

| 상황 | 처리 |
|------|------|
| 음성인식 실패 | Web Speech API 폴백 (기존 패턴) |
| 추출 에이전트 실패 | 대화는 계속 진행, 추출만 스킵 |
| 이어하기 시 컨텍스트 로드 실패 | 빈 컨텍스트로 시작, 사용자에게 안내 |
| 크레딧 부족 중간 발생 | 현재 응답까지는 완료 → 다음 메시지에서 402 |
| summarizer 실패 | 세션은 completed 처리, 요약 없이 종료 |

### 엣지 케이스

- **동시 세션 방지** — 같은 유저가 active 세션 2개 가지는 것 방지. start 시 기존 active 있으면 이어하기.
- **자정 넘김** — 세션 시작 날짜 기준으로 세션 귀속. 자정 넘어도 같은 세션 유지, 다음 날 새로 start하면 새 세션.
- **빈 세션 정리** — 메시지 0개인 세션은 요약 생성 안 함, status만 completed.
