# Project: VoicePrep (보이스프렙)

## 구조
- `frontend/` — Next.js 프론트엔드 + NextAuth 인증만
- `backend/` — FastAPI 백엔드 (API, 서비스, 프롬프트, AI 로직 전부)
- `db/` — DB 초기화 스크립트
- `docker-compose.yml` — 로컬 Docker (nginx + frontend + backend). 개발 및 Cloudflare Tunnel 배포 공용. DB는 Supabase 호스팅
- `nginx/` — nginx 리버스 프록시 (`/api/auth` → frontend, `/api/*` → backend, 나머지 → frontend)

## 개발 규칙
- 개발 환경은 `docker compose up -d`로 띄움 (nginx:81 + frontend:3000 + backend:8000). DB는 Supabase 호스팅.
- 접속: `http://localhost:81` (nginx 경유). frontend/backend는 외부 포트 노출 없이 Docker 내부 네트워크만 사용.
- 로컬 직접 실행 시: `cd frontend && PORT=3001 npm run dev` / `cd backend && uvicorn app.main:app --reload --port 8000`
- prisma 명령 실행 시 `cd frontend && set -a && source .env && set +a` 후 실행.
- `node.exe` 프로세스를 함부로 죽이지 말 것 (dev 서버가 꺼짐).

## 코드 규칙
- placeholder/example 값 만들지 말 것. 실제 값이 없으면 비워두거나 물어볼 것.
- 불필요한 파일 생성 금지. 기존 파일 수정 우선.
- 데드코드, 미사용 import 남기지 말 것.
- **API 로직은 backend/에 작성**. frontend/src/app/api/에는 auth만 존재.
- 크레딧 차감은 반드시 AI 호출 성공 **후** 수행. 선차감 금지 (실패 시 환불 누락 방지).
- 무료 체험 차감은 `WHERE free_trial_used = False` 조건부 UPDATE로 원자적 처리 (동시 요청 방어).
- DB 리소스 조회 시 반드시 `user_id` 소유권 검증 포함 (JobPosting, Resume 등).
- 에러 응답에 내부 예외 메시지 노출 금지 — 고정 문자열 사용.
- HTTPException detail은 `{"error": "메시지"}` 딕셔너리 형태로 통일 (프론트에서 `data.error`로 읽음).
- 무료 체험 마킹은 `credit.py`의 `mark_free_trial_used()` 헬퍼 사용 (중복 구현 금지).
- `eslint-disable` 대신 `useRef`로 stable function reference 유지.
- 파일 업로드 UI는 `document.createElement('input')` 대신 hidden `<input ref={...}>` 사용.
- 삭제 등 위험 액션은 `window.confirm` 대신 shadcn `AlertDialog` 사용.

## 기술 스택

### 프론트엔드 (`frontend/`)
- Next.js 15 (App Router) — UI + NextAuth 인증
- TanStack Query (클라이언트 상태)
- shadcn/ui (UI 컴포넌트)
- NextAuth v5 + Google OAuth (인증)
  - Google 로그인 → PrismaAdapter가 User/Account 자동 생성
  - 미들웨어에서 세션 쿠키 체크 (`__Secure-authjs.session-token`)
  - `allowDangerousEmailAccountLinking` 사용 금지 (계정 탈취 벡터)
- Prisma — NextAuth PrismaAdapter용으로만 사용 (`frontend/src/lib/prisma.ts`, `frontend/src/lib/auth.ts`)

### 백엔드 (`backend/`)
- FastAPI (Python)
- SQLAlchemy / Prisma 호환 PostgreSQL (Supabase)
- NextAuth JWE 토큰 복호화: `joserfc` + HKDF (Python 네이티브, Node.js 서브프로세스 불필요)
- OpenAI API — 모든 LLM 호출 통합 (기본 `gpt-4o-mini`). `backend/.env`의 `AGENT_MODEL`로 런타임 교체 가능 (예: `gpt-4.1-mini`, `gpt-4.1-nano`). 공용 클라이언트: `backend/app/lib/llm_client.py` (call_llm / call_llm_json / call_llm_stream)
- **LangGraph** — 에이전트 오케스트레이션 (면접, 저널, 학습 — 상태 머신)
- **pgvector** — RAG (프로필 + 저널 임베딩, OpenAI text-embedding-3-small)
- Edge TTS (`msedge-tts`) — 음성: `ko-KR-HyunsuNeural`
- Tavily (선택적 — 심층 기업 분석용 웹 검색)
- Whisper API (선택적 — 음성인식, 없으면 Web Speech API만 사용)

### 프론트↔백엔드 통신
- **Docker**: nginx가 `/api/auth` → frontend, `/api/*` → backend로 라우팅
- 유일한 Next.js API route: `/api/auth/[...nextauth]`

## 브랜드
- **이름**: 보이스프렙 (VoicePrep)
- **태그라인**: 말하며 준비하는 개발자 면접
- **포지셔닝**: 타이핑이 아니라 실제로 말하며 연습하는 AI 기술 면접 코치

## 주요 플로우
- **면접 연습**: 이력서 선택(필수) → 채용공고 입력(선택) → 면접 모드 선택 → AI 자동 설계 → 마이크 확인 → 면접 시작
  - **마이크 확인**: 면접 시작 클릭 → 마이크 확인 다이얼로그 (권한 요청, 레벨 미터, 장치 선택, 소리 감지) → 확인 후 API 호출
    - 훅: `hooks/useMicrophoneCheck.ts` (getUserMedia + AudioContext + AnalyserNode)
    - UI: `components/interview/mic-check-dialog.tsx` (shadcn Dialog)
- **면접 모드 2종** (셋업에서 카드 선택):
  - **AI 코치 면접**: 에이전트 기반 동적 면접. 프로필 RAG로 사용자 기억, 완전 동적 질문 생성, 꼬리질문 자동
  - **모범답안 학습**: AI가 질문+모범답안 생성 → 음성 연습 → 모범답안 공개
- **AI 코치 면접 (에이전트 시스템)**:
  - 3개 에이전트: 프로필(RAG) + 면접관(질문생성/흐름결정) + 평가(답변평가/리포트)
  - 오케스트레이터: LangGraph 상태 머신 (규칙 기반 분기, LLM 호출 없음)
  - 프로필 RAG: pgvector + OpenAI Embeddings, 강점/약점/패턴/맥락 카테고리
  - 완전 동적 질문: 미리 생성하지 않고 대화 흐름에 따라 1개씩 생성
  - 꼬리질문: depth < 80이면 자동 생성 (최대 2회)
  - SSE 스트림: 프론트에 실시간 질문/평가 전달
  - 세션 종료 시 프로필 자동 업데이트 (인사이트 추출 → RAG 저장)
  - 코드: `backend/app/agent/` (state, nodes, profile_agent, interviewer_agent, evaluator_agent, embeddings)
  - 프롬프트: `backend/app/prompts/agent.py`
  - API: `/api/agent-interview/{start,answer,skip,end,{id}}`, `/api/profile`, `/api/profile/context`
  - UI: `frontend/src/components/agent-interview/`, `frontend/src/app/(authenticated)/agent-interview/`
- **기존 면접 (레거시, 코드 유지)**: 일반/심화 모드는 UI에서 제거됨. 백엔드 API는 그대로 남아있음
- **멀티라운드 꼬리질문** (기존): 메인 답변 → 꼬리질문 최대 2회 연쇄
  - 깊이 사다리: what → why → tradeoffs/alternatives
  - depth < 80이면 followUpQuestion 필수 생성
  - `followUpRound` (0=메인, 1=1차, 2=2차), `followUpEvaluations: AnswerEvaluation[]`
  - API: `/api/interview/practice-evaluate` (stateless, previousContext 전달)
- **답변 녹음 재생**: 음성 답변 녹음 → fire-and-forget 업로드 → 리포트에서 재생 버튼
  - `InterviewAnswer.audioUrl` 필드
  - API: `POST /api/interview/audio` (multipart, 세션 소유권 검증)
- **심층 기업 분석**: 채용공고 분석 후 "심층 분석" 버튼 → 1크레딧 차감 → Tavily 웹 검색 → LLM 구조화
  - API: `POST /api/job-posting/{id}/research` (멱등)
- **모범답안 학습**: 이력서 선택 → AI가 질문+모범답안 생성 → 질문별 음성 답변 연습 → 모범답안 공개
- **대시보드**: 성장 분석(점수 추이 차트 + 카테고리별 성과 차트)이 대시보드에 통합됨.
- **온보딩**: 첫 방문 시(sessionCount=0 && !freeTrialUsed) 웰컴 다이얼로그 3단계 표시
  - `components/onboarding/welcome-dialog.tsx`

## 레이아웃
- **사이드바**: `components/layout/sidebar.tsx` — 대시보드, 면접 연습, 하루의 정리, 오늘의 학습 (4개 단일 항목)
- **면접 연습 페이지**: 탭 구조 — [면접] (셋업 + 면접 기록 인라인) / [이력서 관리]. `/profile` → `/interview/setup?tab=resume`, `/history` → `/interview/setup` 리다이렉트
- **히스토리 인라인**: 하루의 정리, 오늘의 학습, 면접 기록 모두 랜딩 페이지에 5건 미리보기 + 더보기 버튼
- **푸터**: `components/layout/footer.tsx` — 문의 이메일 + 저작권 (인증된 레이아웃 하단)

## 평가 프롬프트 (`backend/app/prompts/evaluation.py`)
- **기술면접**: clarity 30% + accuracy 25% + practicality 25% + depth 15% + completeness 5%
- **심화면접**: clarity 25% + accuracy 20% + practicality 25% + depth 25% + completeness 5%
- **인성면접**: situation 15% + task 15% + action 30% + result 25% + communication 15%
- **꼬리질문 전용**: `FOLLOWUP_EVALUATION_PROMPT` — previousContext 기반 평가

## 크레딧 & 결제 시스템
- **과금 모델**: 크레딧 충전제. 세션 1회 = 10코인, 꼬리질문 1코인 (면접/모범답안 동일)
- **무료 체험**: 신규 유저 1회 무료 (질문 3개 제한). `User.freeTrialUsed` boolean으로 관리
- **Dev 모드**: `ENVIRONMENT=development`면 크레딧 체크 스킵 (backend config)
- **원자적 차감**: `WHERE credit_balance >= cost` 조건부 UPDATE + rowcount 체크. 무료 체험도 `WHERE free_trial_used = False` 원자적 처리
- **차감 시점**: AI 생성 성공 후 차감 (실패 시 미차감). 크레딧 차감 실패 시 세션 삭제 + 에러 반환
- **API**: `GET /api/credits` (잔액), `GET /api/credits/transactions` (내역)
- **쿠폰**: 프로모션 코드로 크레딧 지급
  - API: `POST /api/coupons/redeem`
  - UI: `/credits` 페이지에 쿠폰 입력 카드
- **게이팅 라우트**: `/api/interview/setup`, `/api/model-answer/generate`
- **402 응답**: `{ error: '...', code: 'INSUFFICIENT_CREDITS' }` → UI에서 크레딧 부족 다이얼로그/페이지 표시
- **UI**: `components/credit/credit-badge.tsx` (헤더), `components/credit/insufficient-credits-dialog.tsx`, `/credits` 페이지
- **결제 기능 미구현** (출시 예정): `/credits` 페이지에 상품 표시만 있고, 버튼 클릭 시 **출시 알림 wishlist** 이메일 등록
  - API: `POST /api/payments/wishlist` (로그인 필요)
  - 테이블: `payment_wishlist` (email, userId, productId)
  - 결제 준비되면 해당 이메일로 알림 발송 예정
  - **wishlist 확인**: Supabase SQL Editor에서 아래 쿼리 실행 (관리자 UI/알림 없음 — 수동 확인)
    ```sql
    -- 전체 등록자 (최신순)
    SELECT email, "userId", "productId", "createdAt"
    FROM payment_wishlist
    ORDER BY "createdAt" DESC;

    -- 총 몇 명 (중복 제외 / 전체)
    SELECT COUNT(DISTINCT email) AS unique_emails, COUNT(*) AS total_entries
    FROM payment_wishlist;

    -- 상품별 집계
    SELECT "productId", COUNT(*) AS count
    FROM payment_wishlist GROUP BY "productId" ORDER BY count DESC;
    ```

## 오늘의 학습 (Nightly Study) 시스템
- **Subject** — 학습 종목 (시스템 7개 + 커스텀, parentId 계층 구조). 시스템: CS기초, JavaScript, React, Next.js, TypeScript심화, DB심화, DevOps
- **Topic** — 종목 내 세부 개념 (난이도, keyPoints, metadata)
- **UserKnowledge** — 사용자별 토픽별 숙련도 (proficiency 0-100, successCount, failureCount, streakCount, nextReviewAt)
- **LearningAgentSession** — 학습 에이전트 세션 (userId, topic, status, llmCallCount, creditDeducted, isFreeSession)
- **LearningAgentMessage** — 학습 대화 메시지 (sessionId, messageIndex, role, content, phase, assessment)
- **DailyProgress** — 일별 학습 요약 (totalSessions, totalQuestions, totalCorrect, totalMinutes, topicsStudied[], subjectsStudied[], streakDay)
- **API**: `/api/nightly-study/{start, {session_id}/respond, {session_id}/end, status, history}`
- **UI**: `/nightly-study`
- 코드: `backend/app/agent/` (learning_nodes, learning_planner, learning_state, tutor_agent)

## 하루의 정리 (Journal) 시스템
- **개요**: AI 대화형 음성 일기. 듀얼 모드(일기/상담) 자동 전환, pgvector RAG로 과거 대화 기억
- **듀얼 모드**:
  - **일기 모드**: 가벼운 반말 대화, 일상 이벤트 기록 ("친구" 페르소나)
  - **상담 모드**: 공감적 존댓말, 깊은 감정 탐색 (키워드 감지 + LLM 분류)
- **과금**: 세션당 10개 무료 메시지, 이후 메시지당 1크레딧
- **에이전트** (`backend/app/agent/`):
  - `journal_state.py` — 상태 머신 (세션, 대화, 모드, RAG 컨텍스트)
  - `journal_nodes.py` — 노드 오케스트레이션 (plan → action → plan, 최대 3루프)
  - `journal_planner.py` — LLM 기반 행동 결정 (search_past/classify_mode/respond)
  - `journal_router_agent.py` — 일기/상담 모드 분류기
  - `journal_extractor.py` — 인사이트 추출 → RAG 저장 (비동기)
  - `journal_summarizer.py` — 세션 요약 + 기분 + 하이라이트 생성
  - `journal_rag.py` — pgvector 코사인 유사도 검색, 30일 윈도우, 유사 항목 upsert (>=0.85)
- **프롬프트**: `backend/app/prompts/journal.py`
- **API**: `/api/journal/{start, {session_id}/message, {session_id}/end, history, {session_id}}`
- **UI**: `/journal` (메인), `/journal/history` (지난 기록)
  - `components/journal/` (journal-panel, journal-message, mode-indicator, session-summary-card, voice-input-bar)
  - `hooks/useJournalSession.ts`, `lib/journal-api.ts`

## DB 모델 (핵심)
- `User` — 계정 (Google OAuth + 이메일/비밀번호 로그인, creditBalance, freeTrialUsed)
- `Account` — OAuth 계정 (PrismaAdapter 관리)
- `Resume` — 복수 이력서 (userId, name, parsedData, fileUrl은 optional). `GET /api/resume?detail=true`로 parsedData 포함 조회
- `JobPosting` — 채용공고
- `InterviewSession` — 면접 세션 (userId, resumeId 필수, jobPostingId 선택, type, categories[], difficulty, status, creditDeducted, textMode, overallScore, reportData, durationSeconds, totalQuestions)
- `InterviewAnswer` — 답변/평가 (audioUrl: 녹음 파일 경로)
- `CreditTransaction` — 크레딧 거래 내역 (amount, balance, type: CreditTxType, referenceId)
- `PaymentWishlist` — 결제 출시 알림 신청 (email, userId, productId) — 결제 기능 구현 전 관심 유저 수집
- `Coupon` — 쿠폰 (code unique, credits, maxUses, usedCount, isActive, expiresAt)
- `CouponUsage` — 쿠폰 사용 기록 (couponId+userId unique → 중복 사용 방지)
- `Subject` — 학습 종목 (slug unique, isSystem, parentId 계층)
- `Topic` — 종목 내 토픽 (difficulty, keyPoints[])
- `UserKnowledge` — 사용자별 토픽별 학습 기억 (proficiency, successCount, failureCount, streakCount, nextReviewAt)
- `LearningAgentSession` — 학습 에이전트 세션 (userId, topic, status, llmCallCount, creditDeducted)
- `LearningAgentMessage` — 학습 대화 메시지 (sessionId, messageIndex, role, content, phase, assessment)
- `DailyProgress` — 일별 진도 (userId+date unique)
- `AgentInterviewSession` — 에이전트 면접 세션 (resumeId, jobPostingId, maxQuestions, status, reportData)
- `AgentInterviewMessage` — 에이전트 면접 메시지 (sessionId, messageIndex, role, content, evaluation JSON)
- `UserProfileEmbedding` — 사용자 프로필 벡터 (userId, category, content, embedding VECTOR(1536), metadata)
- `JournalSession` — 저널 세션 (userId, status, messageCount, freeMessagesUsed, creditsCharged, summary)
- `JournalMessage` — 저널 대화 메시지 (sessionId, messageIndex, role, content, mode: journal/counseling)
- `journal_embeddings` — 저널 RAG 벡터 (userId, category, content, embedding VECTOR(1536), metadata). 카테고리: emotion/event/growth/concern/relationship/goal
- `ActivityLog` + `ActivityItem` — 활동 추적 로그
- `AnswerAssistSession` + `AnswerAssistItem` — AI 답변 도우미 세션
- `QuestionBank` — 문제은행 (category, subcategory, difficulty, questionText, keyPoints)

## 배포
- **방식**: 로컬 PC + Cloudflare Tunnel (PC 전원 켜져 있을 때만 서비스)
- **도메인**: `jachana.com` (Cloudflare 관리)
- **배포 설정**: `docker compose up -d` → `cloudflared tunnel run`
- **터널 config**: `~/.cloudflared/config.yml` — `jachana.com` → `http://localhost:81`
- **CI**: `.github/workflows/ci.yml` — PR/push 시 프론트엔드 lint/typecheck/build + 백엔드 import smoke test
- **nginx**: `/api/auth` rate limit 5r/s, `/api/` rate limit 10r/s
- **음성 파일**: Docker named volume (`audio-storage`)
- **Supabase keep-alive**: `.github/workflows/keep-alive.yml` (5일마다 ping)

## 음성 처리
- **transcript 정규화**: `frontend/src/lib/transcript.ts` — 필러워드/더듬기/부분반복 제거 + `countFillerWords()` (필러워드 카운트, 클라이언트용)
- **AI 교정**: `backend/app/lib/transcript_server.py` — 서버 측 transcript 교정
- **음성인식 (하이브리드)**:
  - 실시간 표시: Web Speech API (`maxAlternatives=3` + confidence 기반 최적 대안 선택)
  - 최종 전사: Whisper API (선택적) — 답변 제출 시 녹음 데이터를 Whisper로 전사, 실패 시 Web Speech API 폴백
  - 클라이언트 래퍼: `frontend/src/lib/whisper-client.ts`
  - 녹음 훅: `frontend/src/hooks/useAudioRecorder.ts` (MediaRecorder API)
  - API: `POST /api/transcribe` (FastAPI, 오디오 확장자 화이트리스트 검증: webm/wav/mp3/ogg/mp4/m4a)
- **실시간 발화 분석**: `hooks/useSpeechAnalytics.ts` — 답변 중 실시간 비언어적 피드백
  - `SpeechMetrics`: wpm (음절/분), fillerCount, silenceSec, silenceRatio, elapsedSec

## 환경 변수
- `frontend/.env` — DB, NextAuth (`NEXTAUTH_URL=https://jachana.com`, `AUTH_TRUST_HOST=true`), Google OAuth, BACKEND_URL
- `backend/.env` — DB, OpenAI API 키(필수, LLM 전체+임베딩+Whisper), Tavily(선택)
- Frontend 필수: `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_TRUST_HOST=true`, `BACKEND_URL`
- Backend 필수: `DATABASE_URL`, `NEXTAUTH_SECRET`, `OPENAI_API_KEY`
- Backend 선택: `ENVIRONMENT`, `TAVILY_API_KEY`, `AGENT_MODEL` (기본 `gpt-4o-mini`), `ADMIN_EMAILS`
