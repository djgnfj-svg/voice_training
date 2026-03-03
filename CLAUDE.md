# Project: AI 면접 코치

## 구조
- 모노리포가 아님. **앱은 `app/` 하나**뿐임.
- `app/` — Next.js 앱 (프론트+백엔드 전부)
- `db/` — DB 초기화 스크립트
- `docker-compose.yml` — PostgreSQL, Redis (인프라만, 앱 서비스 없음, Redis는 로컬 전용)

## 개발 규칙
- 인프라(PostgreSQL, Redis)는 `docker compose up -d`로 띄움. Redis는 선택적 — 없으면 캐시 무시하고 동작.
- Next.js dev 서버는 `cd app && PORT=3001 npm run dev`로 포트 3001에서 실행. 하나만.
- prisma 명령 실행 시 `cd app && set -a && source .env && set +a` 후 실행.
- `node.exe` 프로세스를 함부로 죽이지 말 것 (dev 서버가 꺼짐).

## 코드 규칙
- placeholder/example 값 만들지 말 것. 실제 값이 없으면 비워두거나 물어볼 것.
- 불필요한 파일 생성 금지. 기존 파일 수정 우선.
- 데드코드, 미사용 import 남기지 말 것.

## 기술 스택
- Next.js 15 (App Router)
- Prisma + PostgreSQL (Supabase)
- Anthropic Claude API (`@anthropic-ai/sdk`, 래퍼: `app/src/lib/openai.ts`)
  - `openai` — OpenAI 호환 래퍼 (기존 서비스용)
  - `anthropic` — SDK 직접 export (스트리밍용)
  - ANALYSIS: claude-haiku-4-5
  - EVALUATION / QUESTION_GEN: claude-sonnet-4-6
- Edge TTS (`msedge-tts`, 무료, API 키 불필요)
  - 음성: `ko-KR-InJoonNeural` (남성)
  - API: `POST /api/tts` → MP3 반환
  - `next.config.ts`의 `serverExternalPackages`에 등록 필수
- TanStack Query (클라이언트 상태)
- shadcn/ui (UI 컴포넌트)
- NextAuth v5 + Google OAuth (인증)
  - 개발 모드: 가짜 세션 (`dev-user-00000000-0000-0000-0000`)
  - 프로덕션: Google 로그인 → PrismaAdapter가 User/Account 자동 생성
  - 미들웨어에서 세션 쿠키 체크 (`__Secure-authjs.session-token`)

## 주요 플로우
- **면접 연습**: 이력서 선택(필수) → 채용공고 입력(선택) → AI 자동 설계 → 면접 시작
- **심화 면접**: Setup에서 심화 모드 토글 ON → 질문 뱅크 매칭 → 이력서 프로젝트/기술 직접 언급하는 3~5개 심화 질문 → 꼬리질문 필수 생성
  - 질문 뱅크: `app/src/data/questions/*.json` (8개 JSON, 서비스에서 직접 import)
  - 프롬프트: `DEEP_INTERVIEW_PLAN_PROMPT`, `DEEP_INTERVIEW_QUESTION_PROMPT`, `DEEP_TECHNICAL_EVALUATION_PROMPT`
  - `questionSource: 'deep_technical'`로 심화 세션 식별
- **꼬리질문**: feedback에서 followUpQuestion 표시 → "꼬리질문 답변하기" → TTS → 음성인식 → `/api/interview/practice-evaluate` (stateless) → 피드백 → 다음 질문

## 크레딧 & 결제 시스템
- **과금 모델**: 크레딧 충전제. 세션 1회 = 1크레딧 (면접/모범답안 동일)
- **무료 체험**: 신규 유저 1회 무료 (질문 3개 제한). `User.freeTrialUsed` boolean으로 관리
- **Dev 모드**: `NODE_ENV === 'development'`면 크레딧 체크 스킵
- **원자적 차감**: `prisma.$transaction` + `updateMany(where: { creditBalance: { gte: 1 } })` → 동시 요청 방지
- **차감 시점**: AI 생성 성공 후 차감 (실패 시 미차감)
- **서비스**: `app/src/services/credit.service.ts` — getBalance, canStartSession, deductForSession, deductForFeature, refundForSession, grantCredits, getTransactions
- **API**: `GET /api/credits` (잔액), `GET /api/credits/transactions` (내역)
- **게이팅 라우트**: `/api/interview/setup`, `/api/model-answer/generate`
- **402 응답**: `{ error: '...', code: 'INSUFFICIENT_CREDITS' }` → UI에서 크레딧 부족 다이얼로그/페이지 표시
- **UI**: `components/credit/credit-badge.tsx` (헤더), `components/credit/insufficient-credits-dialog.tsx`, `/credits` 페이지
- **Toss Payments 연동**:
  - 상품: `app/src/lib/payment-products.ts` — 5/15/30 크레딧 (3,000/8,000/14,000원)
  - 플로우: 상품 선택 → `POST /api/payments/orders` (주문 생성) → Toss SDK 결제창 → `POST /api/payments/confirm` (서버 확인 + 크레딧 부여)
  - 멱등성: `orderId`를 Toss `Idempotency-Key`로 전달, DONE 상태 주문은 재처리 없이 성공
  - 서비스: `app/src/services/payment.service.ts` — createOrder, confirmPayment, failOrder

## DB 모델 (핵심)
- `User` — 계정 (Google OAuth, hashedPassword 없음, creditBalance, freeTrialUsed)
- `Account` — OAuth 계정 (PrismaAdapter 관리)
- `Resume` — 복수 이력서 (userId, name, parsedData, fileUrl은 optional)
- `JobPosting` — 채용공고
- `InterviewSession` — 면접 세션 (resumeId 필수, jobPostingId 선택, creditDeducted)
- `InterviewAnswer` — 답변/평가
- `CreditTransaction` — 크레딧 거래 내역 (amount, balance, type: CreditTxType, referenceId)
- `PaymentOrder` — Toss 결제 주문 (orderId, paymentKey, amount, credits, status: PENDING/DONE/FAILED)

## 배포
- Vercel, 리전: `icn1` (인천/서울) — `vercel.json`
- `output: 'standalone'` 사용하지 않음 (Vercel에서 불필요)
- Redis 없음 — `lib/redis.ts`가 연결 실패 시 graceful 무시 (캐시만 스킵)

## 음성 처리
- **transcript 정규화**: `lib/transcript.ts` — 필러워드/더듬기 제거 (클라이언트, 전 훅에서 사용)
- **AI 교정**: `lib/transcript-server.ts` — 서버 측 transcript 교정 (`correctedTranscript`)
- **음성인식**: `maxAlternatives=3` + confidence 기반 최적 대안 선택

## 환경 변수
- `app/.env` — DB, Anthropic API 키, NextAuth, Google OAuth, Toss 등
- Vercel 필수: `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `ANTHROPIC_API_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_TRUST_HOST=true`, `NEXT_PUBLIC_TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`
