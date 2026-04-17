# 코드 리뷰 수정 내역 — 2026-04-17

4개 전문 리뷰 에이전트(backend/frontend/infra/api-contract)가 찾은 이슈를 심각도 순으로 수정한 기록.

각 항목은 **What(무엇을) / How(어떻게) / Why(왜)** 구조로 정리.

## 검증

- 백엔드: `docker compose exec backend python -c "from app.main import app; ..."` → `import OK`
- 프론트: `docker compose exec frontend npm run type-check` → 통과(에러 0)
- UI 브라우저 검증은 수동 — 배포 후 면접 시작/답변 제출/종료 플로우, 저널 모드 전환, 쿠폰 redeem을 점검 필요.

---

## Critical

### C1. AI 코치 면접 SSE `action` 이벤트 리스너 추가 ✅

- **What**: `frontend/src/hooks/useAgentInterview.ts` `attachListeners`에 `source.addEventListener("action", ...)` 추가.
- **How**: 백엔드가 보내는 `{action: "end"|"scan_ask"|"dive_ask"|"build_dive_plan", questionCount, maxQuestions}` 페이로드에서 `questionCount`/`maxQuestions`를 state에 반영. `action === "end"`일 때는 `generating_report`로 phase를 전환해 UI가 `complete` 이벤트를 기다리는 상태로 들어가도록 함.
- **Why**: 백엔드 `agent_interview.py:484-491`(answer), `690-739`(skip) 핸들러는 매 응답 후 `event: action`으로 다음 흐름 신호(다음 질문인지, 종료인지)와 진척도를 보낸다. 프론트가 이 이벤트를 구독하지 않아 `questionCount` 갱신이 누락되고, 질문 3/3 같은 진척 표시가 어긋날 수 있으며, 종료 직전 `end` 시그널을 놓쳐 사용자가 `complete`가 도착하기 전 상태를 알 수 없었다.

---

### C2. `question` SSE 이벤트에 `followUpRound` 필드 추가 ✅

- **What**: `backend/app/agent/nodes.py` `scan_ask`, `dive_ask`가 emit하는 `question` 이벤트 data에 `followUpRound` 필드 추가.
- **How**:
  - Scan(훑기): 주제당 1질문이므로 항상 `followUpRound: 0`.
  - Dive: `current_dive_depth` 시점값을 `followUpRound`로 실어 보냄(0=메인 딥다이브, 1=1차 dig_deeper, 2=2차). `new_depth`는 증가 후 값이라 쓰면 1 차이만큼 밀려서 `depth`를 그대로 사용.
- **Why**: 프론트 `useAgentInterview.ts:78`이 `(data.followUpRound ?? 0) > 0`으로 질문 role(`agent_question` vs `agent_followup`)을 판정한다. 필드가 없어서 모든 dive 질문까지 `agent_question`으로 찍혔고, 리포트/히스토리에서 꼬리질문 체인을 구분할 수 없었다. Scan+Dive 구조에서 dive의 depth가 사실상 followUpRound와 동치이므로 별도 계산 없이 매핑 가능.

---

### C3. dev `docker-compose.yml`에 `name` 필드 명시 ✅

- **What**: `docker-compose.yml` 최상단에 `name: voice_training` 추가.
- **How**: prod compose(`docker-compose.prod.yml`)의 `name: voiceprep-prod`와 대칭이 되도록 dev compose도 프로젝트명을 고정.
- **Why**: `name` 필드가 없으면 Docker Compose는 워킹 디렉토리명을 프로젝트명으로 쓴다. 디렉토리 경로가 `voice_training`이면 볼륨은 `voice_training_audio-storage`로 생성되지만, 누군가 클론 경로를 바꾸면 새 볼륨이 만들어지고 기존 오디오 녹음 파일에 접근 불가. 실수/환경 차이로 인한 데이터 유실 방지.

---

### C4. `.env.example` 필수/선택 키 정리 ✅

- **What**:
  - `backend/.env.example`, `backend/.env.production.example`: 미사용 `ANTHROPIC_API_KEY`, `TOSS_SECRET_KEY`, `NEXT_PUBLIC_TOSS_CLIENT_KEY` 삭제. `OPENAI_API_KEY`를 필수 섹션으로 승격. 선택 섹션에 `AGENT_MODEL` 추가.
  - `frontend/.env.example`: `NEXTAUTH_URL`(dev 기본값 `http://localhost:81`), `NEXT_PUBLIC_ADMIN_EMAILS` 추가.
- **How**: 파일 최상단에 `# Required`, 하단에 `# Optional` 섹션으로 분리. 실제 사용 여부를 코드 grep으로 확인해 데드 키 제거.
- **Why**: 실제 코드에는 Anthropic 의존이 전혀 없는데(모든 LLM 호출은 `openai` SDK 경유) `.env.example`에는 ANTHROPIC이 먼저 보이고 OPENAI는 Optional 섹션으로 내려가 있어, 신규 셋업 시 잘못된 키를 채우고 OpenAI 키는 빠뜨리기 쉬웠다. frontend는 `NEXTAUTH_URL`이 빠져 프로덕션 OAuth 리다이렉트 루프 가능. 토스 관련 키는 결제 기능 미구현 상태라 제거.

---

## High

### H5. `HTTPException` detail 딕셔너리 통일 ✅

- **What**: `interview.py`, `interview_audio.py`, `model_answer.py`, `speech.py`, `job_posting.py`, `answer_assist.py`, `admin.py`에서 plain string detail을 `{"error": "메시지"}` 형태로 통일. 영문 메시지("Resume not found" 등)는 동시에 한국어로 번역.
- **How**: `HTTPException(status, "plain text")` → `HTTPException(status, {"error": "한국어 메시지"})` 일괄 교체. `answer_assist.py`/`admin.py`에 있던 unicode escape(`\uc774\ub825...`) 형태도 풀어서 직접 한국어 문자열로 정리.
- **Why**: CLAUDE.md 규칙: "HTTPException detail은 `{"error": "메시지"}` 딕셔너리 형태로 통일 (프론트에서 `data.error`로 읽음)". 규칙 위반 시 프론트에서 `data.error === undefined`가 되어 "알 수 없는 오류" 같은 일반 메시지로 fallback되거나, 토스트가 빈 문자열로 뜸. 사용자가 실제 실패 원인을 알 수 없어 지원 비용 증가. 영문/unicode escape 혼재도 유지보수 시 가독성이 떨어져 함께 정리.
- **남은 이슈**: `interview.py:316-320`의 `ValueError`/`Exception` 핸들링 분기는 유지하되 detail 포맷만 교체. 근본적으로 `evaluate_answer` 서비스가 더 구조화된 에러를 raise하도록 리팩터하는 건 별도 과제.

---

### H6. `middleware.ts` matcher에 보호 경로 추가 ✅

- **What**: `frontend/src/middleware.ts`의 matcher에 `/agent-interview/:path*`, `/journal/:path*`, `/nightly-study/:path*` 추가.
- **How**: 기존 matcher 배열에 세 경로 삽입. 세션 토큰 쿠키(`__Secure-authjs.session-token`/`authjs.session-token`)가 없으면 `/login?callbackUrl=...`으로 리다이렉트.
- **Why**: 세 기능은 모두 인증 필수인데 matcher에 빠져 있어 미로그인 사용자가 페이지 쉘을 볼 수 있었다. 실제 데이터 호출은 백엔드에서 세션 쿠키로 차단되지만, 클라이언트 사이드 세션 체크만 의존하면 순간적인 UI 노출(깜빡임)이 있어 UX가 어색하고 권한 누수로 오인될 수 있음.

---

## Medium

### M8. 프론트 TTS 호출에 persona 파라미터 전달 ✅

- **What**: `useTextToSpeech.ts`에 persona 타입/옵션을 추가하고, 각 호출부에서 컨텍스트별 persona 전달.
- **How**:
  - 훅: `UseTextToSpeechOptions.persona` (훅 수명 동안 기본값) + `TTSSpeakOptions.persona` (개별 speak 호출 시 override).
  - 호출부:
    - `components/agent-interview/agent-interview-panel.tsx` → `interviewer`
    - `hooks/useInterviewSession.ts`, `hooks/usePracticeSession.ts` (기존 면접/모범답안) → `interviewer`
    - `app/(authenticated)/nightly-study/session/page.tsx` → `tutor`
    - `components/journal/journal-panel.tsx` → 메시지별 `mode`에 따라 `journal_friend`/`journal_counselor` 동적 분기
  - API payload: `{text}` → `{text, persona}` (persona가 있을 때만 포함).
- **Why**: 백엔드 `/api/tts`와 TTS 서비스는 페르소나 5종을 `gpt-4o-mini-tts` instructions로 변환해 톤을 차별화한다(CLAUDE.md 기술 스택 섹션). 프론트가 persona 파라미터 없이 호출해 와서 모든 화면이 default 톤으로만 재생됐다. 저널은 일기/상담 모드 전환이 듀얼의 핵심 UX인데 음성 톤이 동일했던 점이 가장 아쉬웠음.

---

### M9. `practice-evaluate` 크레딧 부족 에러 메시지 한국어화 ✅

- **What**: `backend/app/routers/interview.py`의 pre-check, post-call 두 곳과 `model_answer.py`의 post-call 한 곳에서 `"error": "INSUFFICIENT_CREDITS"`를 `"error": "크레딧이 부족합니다"`로 변경. `code: "INSUFFICIENT_CREDITS"` 필드는 유지.
- **How**: agent_interview 쪽과 동일한 포맷(`{"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"}`)으로 맞춤.
- **Why**: 프론트는 `data.error`를 사용자 대상 메시지로 표시하고, `data.code === "INSUFFICIENT_CREDITS"`로 분기해 전용 다이얼로그를 띄운다. `error`에 코드 문자열을 넣으면 분기는 동작하지만 fallback 토스트에서 `INSUFFICIENT_CREDITS`가 그대로 노출되는 경로가 생김. 라우터 간 일관성과 UX 측면에서 통일.

---

### M11. 쿠폰 redeem 동시성 안전화 ✅

- **What**: `backend/app/services/coupon.py` `redeem_coupon`에서 `CouponUsage` 중복 체크를 `SELECT → INSERT`에서 `INSERT ... ON CONFLICT DO NOTHING` + rowcount 검사로 교체.
- **How**:
  - `sqlalchemy.dialects.postgresql.insert as pg_insert` 도입.
  - `pg_insert(CouponUsage).values(...).on_conflict_do_nothing(constraint="coupon_usages_couponId_userId_key")`로 단일 쿼리 원자 처리.
  - `rowcount == 0`이면 `ALREADY_USED` 에러 raise.
  - 기존 `usage = CouponUsage(...)` + `db.add(usage)` 블록은 제거(INSERT가 이미 수행됨).
- **Why**: 기존 구조는 SELECT로 중복 여부 확인 후 별도 INSERT를 실행하는데, 동일 유저가 동시 요청을 보내면 두 요청이 모두 SELECT를 통과할 수 있다. 이후 INSERT 단계에서 유니크 제약이 잡히지만 `IntegrityError`가 500으로 노출되고, 최악의 경우 `usedCount`가 두 번 증가할 위험이 있었다. ON CONFLICT 패턴은 원자적이며 race 자체를 제거.
- **주의**: constraint 이름은 Prisma가 생성한 `coupon_usages_couponId_userId_key`(camelCase 원본). 향후 Prisma 스키마가 마이그레이션되면 이 이름도 함께 관리해야 함.

---

### M13. CI 프론트 빌드에 `NEXT_PUBLIC_*` 주입 ✅

- **What**: `.github/workflows/ci.yml` frontend build step의 env에 `NEXT_PUBLIC_ADMIN_EMAILS=''`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST`, `BACKEND_URL` 추가. 미사용 `ANTHROPIC_API_KEY` 삭제.
- **How**: 실제 값이 없어도 빈 문자열이라도 명시해 빌드가 동일 경로를 타도록. Google OAuth client id는 기존 dummy 값 유지.
- **Why**: 프로덕션 빌드는 루트 `.env`에서 Docker build args로 `NEXT_PUBLIC_*`를 받아 번들에 인라인하지만 CI는 이를 생략하고 있었다. 결과적으로 `NEXT_PUBLIC_*` 사용 코드가 잘못 들어가도 CI에서 빌드가 통과해 버린다. 실제 배포 경로와 최대한 같아야 CI가 안전망 역할을 함.

---

### M14. `tts/Dockerfile` 슬림화 + non-root ✅

- **What**: TTS 서비스 Dockerfile에서 `apt-get install git git-lfs libsndfile1` 블록 전체 삭제, non-root user(`tts` uid=1000) 추가. 사용하지 않는 `HF_HOME`, `XDG_CACHE_HOME` 환경 변수도 제거.
- **How**: `requirements.txt`에는 `fastapi/uvicorn/pydantic/openai`만 있어 시스템 패키지가 필요 없음을 확인한 뒤 제거. `RUN useradd -m -u 1000 tts && chown -R tts:tts /app` + `USER tts` 추가.
- **Why**: TTS 서비스는 OpenAI SDK만 사용하므로 git/음성 라이브러리가 전혀 필요 없다. 불필요한 패키지는 이미지 크기, 공격 표면, CVE 스캔 결과를 모두 악화. non-root 원칙도 backend/frontend와 통일해 권한 탈출 리스크를 줄임. `HF_HOME`/`XDG_CACHE_HOME`은 과거 로컬 TTS 모델 캐시용이었는데 OpenAI TTS로 전환하며 이미 사문화됐음.

---

## 검토 결과 — 수정 보류 항목

- **[H7] 학습 세션 크레딧 pre-check UX**: 사용자 경험 개선이지만 현재 로직이 돈 손실은 발생시키지 않음. 학습 에이전트 흐름 전체 재설계와 묶어 별도 티켓으로 처리.
- **[M10] `CreditTransaction.balance=0` 하드코딩**: 무료 체험 시 실제 잔액을 기록하도록 바꾸려면 `credit.py`의 여러 경로를 손대야 하고, 과거 데이터와의 일관성 고려 필요. 별도로 다룸.
- **[M12] eslint-disable → useRef**: 다수 컴포넌트 리팩터링으로 이번 수정 범위를 넘어 커밋 분리. 후속 작업 예정.
