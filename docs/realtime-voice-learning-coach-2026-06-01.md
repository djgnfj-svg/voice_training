# 설계: 실시간 양방향 음성 CS 튜터 (Realtime Voice Learning Coach)

- **날짜**: 2026-06-01
- **상태**: 설계 확정 대기 (사용자 리뷰 중)
- **대상 기능**: CS 학습 어시스트(Learning Coach)의 음성 레이어
- **건드리지 않는 것**: 면접(에이전트/레거시), 학습 브레인 로직(툴 7개), DB 스키마(최소 추가만)

## 1. 배경 / 동기

블루개러지(JYP 자회사) Full Stack 포지션 지원을 위한 포트폴리오 고도화. 회사 제품의 본질은
**"모바일 + AI 생성 음성/영상 스트리밍 기반 실시간 통화"**이고, JD 자격요건에
**"실시간 통신(WebSocket/WebRTC) 연동 경험"**이 명시돼 있다.

VoicePrep은 AI 추론 파이프라인(LangGraph + pgvector RAG + 평가) · FastAPI REST · TypeScript 프론트 ·
AI 음성(TTS/STT)을 이미 갖췄으나, **실시간 양방향 통신이 0건**이다. 이 한 곳이 정확히 회사 제품의
핵심이자 JD가 콕 집은 갭이다.

면접(턴제 Q&A + 엄격한 평가 파이프라인)보다 **CS 학습 튜터**가 양방향 음성 통화에 더 자연스럽다
(이미 "음성 전용 + 모바일 전용"). 따라서 면접은 그대로 두고 Learning Coach를 실시간 음성 통화로 전환한다.

## 2. 현행 분석 (코드 기준)

### 백엔드 (턴제 SSE)
- `backend/app/routers/learning_coach.py`
  - `POST /api/learning-coach/{session_id}/turn` — `TurnBody{userUtterance: str}` 텍스트 입력, `EventSourceResponse`로 `phase`/`text`/`meta`/`end` 스트리밍.
- `backend/app/agent/learning_coach/graph.py`
  - 브레인은 **이미 OpenAI function-calling 툴 7개**로 구현됨 (`_default_tools_schema()`, `graph.py:151`):
    `init_profile`, `update_learning_profile`, `plan_next_session`,
    `select_or_create_curriculum_node`, `retrieve_learning_memory`, `update_mastery`, `summarize_session`.
  - 툴 구현체는 `_make_tools(db, session_id, user_id)` (`graph.py:249`)가 DB에 직접 실행.
  - LangGraph 루프: `load_context → agent(LLM+tools) → tools → agent → … → persist`.
  - **`stream_agent_turn`의 "스트리밍"은 사실상 가짜** (`graph.py:842`): `thinking` 페이즈 1회 →
    `run_agent_turn` 전체 블로킹 → `final_text`를 통째로 1회 방출 → `meta` → `end`.
  - 영속: `_persist_graph_turn` (`graph.py:625`)이 `learning_messages`에 user/assistant 메시지 + tool_log 기록,
    `learning_sessions.turn_count`/`graph_state` 갱신.

### 프론트 (반이중 워키토키)
- `frontend/src/components/learning-coach/session-view.tsx`
  - AI 메시지 추가 → `useTextToSpeech`(persona `tutor`)로 TTS 재생 → 끝나면 `tryStartMic`으로 STT 시작.
  - **AI 발화 중 마이크 OFF** (`isAiSpeaking && isListening → stopListening`) → **barge-in 불가**.
  - **3초 침묵 타이머**(`SILENCE_MS=3000`) 후 자동 전송.
  - `useLearningCoachStream`(`frontend/src/hooks/useLearningCoachStream.ts`)이 fetch+ReadableStream으로 SSE 파싱.
- 입력은 `useSpeechRecognition`(Web Speech), 출력은 `useTextToSpeech`(TTS 서비스). 둘 다 턴 단위 블로킹.

### 결론
지연 = `3초 침묵 + 전체 STT + 블로킹 LLM 툴루프 + 전체 텍스트 TTS`. 끊기 불가. 실제 스트리밍 아님.
**브레인이 이미 서버사이드 function-calling 툴**이라는 점이 실시간 전환을 결정적으로 쉽게 만든다.

## 3. 목표 / 비목표

### 목표
- Learning Coach 음성 세션을 **OpenAI Realtime API 기반 full-duplex 음성 통화**로 전환.
- **barge-in**(AI 발화 중 사용자가 끼어들면 즉시 중단), 서버 VAD, 응답 시작 sub-second.
- **기존 브레인 툴 7개를 그대로 재사용** — 커리큘럼/SRS/RAG/mastery 로직 변경 없음.
- **prod(jachana.com) 배포** — 단일 PC + Cloudflare Tunnel 환경에서 동작.
- 공유 OpenAI 쿼터를 보호하는 **비용 가드** 내장.

### 비목표 (YAGNI)
- WebRTC 미디어(브라우저↔OpenAI 직결) — 옵션 phase 2. 이번엔 WebSocket만.
- 영상 스트리밍.
- 면접(에이전트/레거시) 전환 — 손대지 않음.
- 기존 턴제 SSE 경로 삭제 — **유지**(아래 §7).

## 4. 아키텍처 — 안 C1: Realtime API + 서버 릴레이 WebSocket (확정)

```
브라우저 ──(WSS, Cloudflare Tunnel → nginx → backend)──▶ FastAPI WS endpoint ──(WS)──▶ OpenAI Realtime API
  mic PCM16 ───────────────────────────────────────────▶  relay  ──────────────────────▶  (STT + 추론 + TTS)
  speaker  ◀───────────────────────────────────────────  relay  ◀────────────────────── audio delta
                                                            │
                                                            ├─ function_call 인터셉트 → 기존 툴 7개 실행(DB)
                                                            │     _make_tools(db, session_id, user_id)
                                                            │     → function_call_output 을 OpenAI에 회신
                                                            ├─ input/output transcript → learning_messages 영속
                                                            └─ meta(nodeChangedTo/proficiency/…) → 클라 WS로 forward
```

### 왜 C1인가 (결정 근거)
- **브레인이 서버사이드 DB 툴**이므로 릴레이가 function_call을 받아 **그 자리에서** 기존 툴을 실행 (추가 왕복 0).
  WebRTC(C2)였다면 클라→백엔드 tool 포워딩이 매번 필요 → ROI 낮음.
- **모든 트래픽이 백엔드를 경유** → 세션/비용 상한을 서버에서 완전 통제 (단일 PC + 공유 쿼터 prod 필수).
- **WebSocket** → Cloudflare Tunnel 그대로 통과(WS 지원). JD "실시간 통신(WebSocket)" 충족.
- speech-to-speech 단일 모델 → barge-in/저지연 내장, 구현 공수 최소.

## 5. 백엔드 상세 설계

### 5.1 신규 WebSocket 엔드포인트
- `WebSocket /api/learning-coach/{session_id}/realtime` (FastAPI `@router.websocket`).
- **인증**: WS 연결 시 NextAuth 세션 쿠키(JWE)를 기존 `dependencies` 복호화 로직으로 검증
  (REST의 `get_current_user`와 동일 경로 재사용). 쿠키 사용 불가 환경 대비 쿼리 토큰 fallback 검토.
- **소유권 검증**: `learning_sessions WHERE id=:s AND user_id=:u AND status='active'` (REST `/turn`과 동일).

### 5.2 릴레이 (`backend/app/agent/learning_coach/realtime_relay.py`, 신규)
1. 연결 시 `_load_context(db, session_id, user_id)`로 컨텍스트 로드.
2. OpenAI Realtime 세션 오픈 후 `session.update` 전송:
   - `instructions`: `AGENTIC_SYSTEM_PROMPT` + 컨텍스트 JSON (기존 `load_context` 노드와 동일 구성).
   - `tools`: **기존 `_default_tools_schema()` 재사용** (Realtime tools 포맷으로 어댑트).
   - `voice`/`turn_detection`(server VAD)/`input_audio_format`(pcm16) 설정.
3. 두 방향 펌프(asyncio tasks):
   - 클라→OpenAI: 클라가 보낸 오디오 청크를 `input_audio_buffer.append`로 전달.
   - OpenAI→클라: `response.audio.delta`를 클라로 forward, `response.audio_transcript.*` 수집.
4. function_call 처리: `response.function_call_arguments.done` 수신 →
   `_make_tools(...)`에서 이름 매칭해 실행 → 결과를 `conversation.item.create`(function_call_output)로 회신 →
   `response.create`로 이어가기. 동시에 변화(node 변경/proficiency 등)를 `meta` 이벤트로 클라에 forward.
5. 종료/타임아웃 시 transcript를 `learning_messages`에 영속 (기존 `_persist_graph_turn` 로직 재사용/추출).

### 5.3 비용 가드 (prod)
- **세션 길이 하드 캡**: 10분 → 초과 시 서버가 정중히 마무리 발화 후 WS 종료.
- **일일 음성 분 상한**: 사용자당 30분/일 (KST). 신규 테이블 또는 `learning_sessions` 집계로 누적 추적.
- **idle 타임아웃**: 30초간 오디오 없으면 자동 종료.
- **킬스위치**: `REALTIME_VOICE_ENABLED`(루트 `.env`) — false면 엔드포인트가 즉시 턴제 폴백 안내.
- 모델은 Realtime 전용. 그 외 모든 LLM은 기존 `gpt-4o-mini` 유지.

## 6. 프론트 상세 설계

- 신규 훅 `frontend/src/hooks/useRealtimeVoice.ts`:
  - `getUserMedia` → `AudioContext`/`AudioWorklet`로 마이크 PCM16 캡처 → WS 송신.
  - 수신 오디오 델타 재생(playback queue).
  - **barge-in**: OpenAI `input_audio_buffer.speech_started` 수신 시 로컬 재생 중단.
  - `meta` 이벤트 → 콜백(현재 토픽/종료 제안 등 UI 갱신).
- `session-view.tsx`:
  - realtime 모드 분기 추가. "통화 중" UI(라이브 인디케이터, 끊기 버튼, 음량).
  - **textMode(admin) 및 Realtime 불가 시 기존 턴제 루프로 폴백** — 3초 타이머/워키토키 로직은 폴백 경로로 보존.

## 7. 폴백 / E2E 보존 (중요)

기존 **턴제 SSE 경로(`/turn` + `stream_agent_turn` + `useLearningCoachStream`)는 삭제하지 않는다.**
- `E2E_MOCK_LLM` 테스트: Realtime은 동일 방식 mock 불가 → 턴제 경로로 회귀 검증 지속.
- admin `textMode=1`: 기존대로 `TextAnswerInput` + 턴제.
- Realtime 실패/키 없음/킬스위치 off: graceful degradation → 턴제.
- 프로젝트 기존 폴백 패턴(TTS→edge-tts, Whisper→Web Speech)과 일관.

## 8. 인프라 / 배포

- **nginx**: `/api/learning-coach/*/realtime`에 WS upgrade 헤더(`Upgrade`/`Connection`) + 적절한 read timeout.
- **Cloudflare Tunnel**: WS 기본 지원(config 변경 불필요 예상, 배포 시 검증).
- **prod 백엔드**: baked image → rebuild 필요
  (`docker compose -f docker-compose.prod.yml build backend && up -d backend`, nginx도 함께 restart).
- **`.env`**: `REALTIME_VOICE_ENABLED`, 비용 가드 수치, (필요시) Realtime 모델명 추가. `.env.example` 갱신.

## 9. 측정 지표 (포트폴리오 어필 — voiceprep-feature)

- 응답 시작 지연 p50/p95 (before: 턴제 / after: realtime).
- 턴당 왕복 수 / barge-in 동작 여부(정성).
- 분당 토큰·비용 (가드 효과 포함).
- LoC·신규 모듈 수. before/after 표 자동 생성.

## 10. 위험 / 완화

| 위험 | 완화 |
|------|------|
| Realtime API 비용 급증 | 세션/일일 캡 + idle 타임아웃 + 킬스위치 |
| WS 인증(쿠키) 복잡 | REST 복호화 로직 재사용, 쿼리 토큰 fallback |
| Cloudflare Tunnel WS 이슈 | 배포 전 dev(81)에서 WS 통과 검증, prod 별도 확인 |
| 오디오 포맷/지연 튜닝 | server VAD + pcm16 기본, 실측 후 조정 |
| 단일 PC 대역폭(오디오 경유) | 데모/소수 사용자 전제, 동시성 제한 |

## 11. 확정된 결정 사항

1. 대상: **Learning Coach**(면접 제외).
2. 배포: **실제 prod(jachana.com)까지**.
3. 음성 엔진: **OpenAI Realtime API**.
4. 전송: **WebSocket만(C1)** — WebRTC는 옵션 phase 2.
5. 비용 가드: **세션 10분 + 일 30분/인 + idle 30초 + 킬스위치**.

## 12. 다음 단계

설계 승인 후 구현은 프로젝트 하네스의 **`voiceprep-feature` 스킬**로 진행
(측정 기반 + planner/implementer/measurer + 어필 카피 자동 생성 — CLAUDE.md 규칙).
기존 턴제 경로 보존 → 신규 WS 엔드포인트/릴레이 → 프론트 훅/UI → 비용 가드 → nginx/배포 순.
