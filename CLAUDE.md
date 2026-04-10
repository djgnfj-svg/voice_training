# Project: VoicePrep (보이스프렙)

## 구조
- `frontend/` — Next.js 프론트엔드 + NextAuth 인증만
- `backend/` — FastAPI 백엔드 (API, 서비스, 프롬프트, AI 로직 전부)
- `db/` — DB 초기화 스크립트
- `docker-compose.yml` — 로컬 개발용 (nginx + frontend + backend). 인프라(PostgreSQL)는 Supabase 사용
- `docker-compose.prod.yml` — 프로덕션 (EC2)
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
- Anthropic Claude API — ANALYSIS / EVALUATION / QUESTION_GEN: claude-haiku-4-5
- **LangGraph** — 에이전트 면접 오케스트레이션 (상태 머신)
- **pgvector** — 사용자 프로필 RAG (OpenAI text-embedding-3-small)
- Edge TTS (`msedge-tts`) — 음성: `ko-KR-HyunsuNeural`
- Tavily (선택적 — 심층 기업 분석용 웹 검색)
- Whisper API (선택적 — 음성인식, 없으면 Web Speech API만 사용)

### 프론트↔백엔드 통신
- **Docker (dev/prod)**: nginx가 `/api/auth` → frontend, `/api/*` → backend로 라우팅
- **Vercel 배포**: Next.js rewrite (`next.config.ts`)가 `/api/*` (auth 제외) → FastAPI(`BACKEND_URL`)로 프록시
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
  - **AI 코치 모드**: 에이전트 기반 동적 면접. 프로필 RAG로 사용자 기억, 완전 동적 질문 생성, 꼬리질문 자동
  - **모범답안 학습 모드**: AI가 질문+모범답안 생성 → 음성 연습 → 모범답안 공개
- **AI 코치 면접 (에이전트 시스템)**:
  - 3개 에이전트: 프로필(RAG) + 면접관(질문생성/흐름결정) + 평가(답변평가/리포트)
  - 오케스트레이터: LangGraph 상태 머신 (규칙 기반 분기, LLM 호출 없음)
  - 프로필 RAG: pgvector + OpenAI Embeddings, 강점/약점/패턴/맥락 카테고리
  - 완전 동적 질문: 미리 생성하지 않고 대화 흐름에 따라 1개씩 생성
  - 꼬리질문: depth < 80이면 자동 생성 (최대 2회)
  - SSE 스트림: 프론트에 실시간 질문/평가 전달
  - 세션 종료 시 프로필 자동 업데이트 (인사이트 추출 → RAG 저장)
  - 코드: `backend/app/agent/` (state, nodes, graph, profile_agent, interviewer_agent, evaluator_agent, embeddings)
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
- **사이드바**: `components/layout/sidebar.tsx` — 대시보드, 면접 시작, 모범답안, 이력서 관리, 크레딧, 면접 기록
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
- **Toss Payments 연동**:
  - 상품: `frontend/src/lib/payment-products.ts` — 50/150/300 코인 (3,000/8,000/14,000원)
  - 플로우: 상품 선택 → `POST /api/payments/orders` (주문 생성) → Toss SDK 결제창 → `POST /api/payments/confirm` (서버 확인 + 크레딧 부여)
  - 멱등성: `orderId`를 Toss `Idempotency-Key`로 전달
  - Toss 응답 검증: `totalAmount`/`orderId` 이중 교차 검증. FAILED 주문 복구 시에도 orderId 교차 검증

## 멀티 종목 학습 시스템
- **Subject** — 학습 종목 (시스템 7개 + 커스텀). 시스템: CS기초, JavaScript, React, Next.js, TypeScript심화, DB심화, DevOps
- **Topic** — 종목 내 세부 개념 (난이도, keyPoints). 커스텀 종목 생성 시 AI가 자동 추출
- **UserKnowledge** — 사용자별 토픽별 숙련도 (0-100, SM-2 간소화 간격 반복)
- **LearningSession** — 학습 세션 (mode: practice/review/quiz, 크레딧 10코인)
- **LearningItem** — 세션 내 개별 문제 + 평가 결과
- **DailyProgress** — 일별 학습 요약 (세션수, 문제수, 정답수, 학습시간, 스트릭)
- **API**: `/api/subjects`, `/api/learning/{setup,evaluate,complete}`, `/api/knowledge`, `/api/progress/{daily,streak}`
- **UI**: `/learn` (종목 그리드), `/learn/[id]` (종목 대시보드), `/learn/[id]/session` (음성 학습), `/progress` (현황)

## DB 모델 (핵심)
- `User` — 계정 (Google OAuth + 이메일/비밀번호 로그인, creditBalance, freeTrialUsed)
- `Account` — OAuth 계정 (PrismaAdapter 관리)
- `Resume` — 복수 이력서 (userId, name, parsedData, fileUrl은 optional). `GET /api/resume?detail=true`로 parsedData 포함 조회
- `JobPosting` — 채용공고
- `InterviewSession` — 면접 세션 (resumeId 필수, jobPostingId 선택, creditDeducted, textMode)
- `InterviewAnswer` — 답변/평가 (audioUrl: 녹음 파일 경로)
- `CreditTransaction` — 크레딧 거래 내역 (amount, balance, type: CreditTxType, referenceId)
- `PaymentOrder` — Toss 결제 주문 (orderId, paymentKey, amount, credits, status: PENDING/DONE/FAILED)
- `Coupon` — 쿠폰 (code unique, credits, maxUses, usedCount, isActive, expiresAt)
- `CouponUsage` — 쿠폰 사용 기록 (couponId+userId unique → 중복 사용 방지)
- `Subject` — 학습 종목 (slug unique, isSystem, parentId 계층)
- `Topic` — 종목 내 토픽 (difficulty, keyPoints[])
- `UserKnowledge` — 사용자별 토픽별 학습 기억 (proficiency, streak, nextReviewAt)
- `LearningSession` — 학습 세션 (subjectId, mode, correctCount)
- `LearningItem` — 학습 문제 (topicId, evaluation JSON, isCorrect)
- `DailyProgress` — 일별 진도 (userId+date unique)
- `AgentInterviewSession` — 에이전트 면접 세션 (resumeId, jobPostingId, maxQuestions, status, reportData)
- `AgentInterviewMessage` — 에이전트 면접 메시지 (sessionId, messageIndex, role, content, evaluation JSON)
- `UserProfileEmbedding` — 사용자 프로필 벡터 (userId, category, content, embedding VECTOR(1536), metadata)

## 배포
- **프론트엔드**: Vercel, 리전: `icn1` (인천/서울) — `vercel.json`
- **백엔드**: EC2 Docker Compose (`docker-compose.prod.yml`)
- **프로덕션 도메인**: `reseeall.com`
- `BACKEND_URL` 환경변수로 FastAPI 주소 지정
- **CI/CD**: `deploy.yml`은 `ci.yml` 통과 후 배포 (`needs: ci`). CI는 프론트엔드 lint/typecheck/build + 백엔드 import smoke test
- **리소스 제한**: nginx 128M, frontend 512M, backend 1G
- **nginx**: `/api/auth` rate limit 5r/s, `/api/` rate limit 10r/s
- **음성 파일**: Docker named volume (`audio-storage`) → 재배포 시 유지

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
- `frontend/.env` — DB, NextAuth, Google OAuth, Toss, BACKEND_URL
- `backend/.env` — DB, Anthropic API 키, Tavily, OpenAI (Whisper)
- Vercel 필수: `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_TRUST_HOST=true`, `NEXT_PUBLIC_TOSS_CLIENT_KEY`, `BACKEND_URL`
- Backend 필수: `DATABASE_URL`, `NEXTAUTH_SECRET`, `ANTHROPIC_API_KEY`
- Backend 선택: `ENVIRONMENT`, `TAVILY_API_KEY`, `OPENAI_API_KEY` (Whisper), `TOSS_SECRET_KEY`, `ADMIN_EMAILS`
