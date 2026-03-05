# Project: VoicePrep (보이스프렙)

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
  - ANALYSIS / EVALUATION / QUESTION_GEN: claude-haiku-4-5
- Edge TTS (`msedge-tts`, 무료, API 키 불필요)
  - 음성: `ko-KR-HyunsuNeural` (남성, 자연스러운 톤)
  - API: `POST /api/tts` → MP3 반환
  - `next.config.ts`의 `serverExternalPackages`에 등록 필수
- Tavily (`@tavily/core`, 선택적 — 심층 기업 분석용 웹 검색)
  - 래퍼: `app/src/lib/tavily.ts` (싱글톤, `isTavilyAvailable` export)
  - `TAVILY_API_KEY` 없으면 기능 미노출, 기존 동작 영향 없음
- TanStack Query (클라이언트 상태)
- shadcn/ui (UI 컴포넌트)
- NextAuth v5 + Google OAuth (인증)
  - 개발 모드: 가짜 세션 (`dev-user-00000000-0000-0000-0000`)
  - 프로덕션: Google 로그인 → PrismaAdapter가 User/Account 자동 생성
  - 미들웨어에서 세션 쿠키 체크 (`__Secure-authjs.session-token`)

## 브랜드
- **이름**: 보이스프렙 (VoicePrep)
- **태그라인**: 말하며 준비하는 개발자 면접
- **포지셔닝**: 타이핑이 아니라 실제로 말하며 연습하는 AI 기술 면접 코치
- **상수**: `app/src/lib/brand.ts` — BRAND 객체 (name, nameEn, tagline, description)

## 주요 플로우
- **면접 연습**: 이력서 선택(필수) → 채용공고 입력(선택) → 면접 모드 선택 → AI 자동 설계 → 마이크 확인 → 면접 시작
  - **마이크 확인**: 면접 시작 클릭 → 마이크 확인 다이얼로그 (권한 요청, 레벨 미터, 장치 선택, 소리 감지) → 확인 후 API 호출
    - 훅: `hooks/useMicrophoneCheck.ts` (getUserMedia + AudioContext + AnalyserNode)
    - UI: `components/interview/mic-check-dialog.tsx` (shadcn Dialog)
- **면접 모드 2종** (셋업에서 카드 선택):
  - **일반 모드**: 5-10 질문, 전반적 커버리지
  - **심화 모드**: 3-5 질문, 기술 깊이 집중. 질문 뱅크 매칭 → 이력서 프로젝트/기술 직접 언급
    - 질문 뱅크: `app/src/data/questions/*.json` (7개 JSON, 서비스에서 직접 import)
    - 프롬프트: `DEEP_INTERVIEW_PLAN_PROMPT`, `DEEP_INTERVIEW_QUESTION_PROMPT`, `DEEP_TECHNICAL_EVALUATION_PROMPT`
    - `questionSource: 'deep_technical'`로 심화 세션 식별
- **멀티라운드 꼬리질문**: 메인 답변 → 꼬리질문 최대 2회 연쇄
  - 깊이 사다리: what → why → tradeoffs/alternatives
  - depth < 80이면 followUpQuestion 필수 생성
  - `followUpRound` (0=메인, 1=1차, 2=2차), `followUpEvaluations: AnswerEvaluation[]`
  - 프롬프트: `FOLLOWUP_EVALUATION_PROMPT` (previousContext 포함)
  - API: `/api/interview/practice-evaluate` (stateless, previousContext 전달)
- **답변 녹음 재생**: 음성 답변 녹음 → fire-and-forget 업로드 → 리포트에서 재생 버튼
  - `InterviewAnswer.audioUrl` 필드 (Prisma, migration 필요: `add-audio-url`)
  - API: `POST /api/interview/audio` (multipart, 세션 소유권 검증)
  - 저장: `public/audio/{sessionId}/{questionIndex}.webm`
- **심층 기업 분석**: 채용공고 분석 후 "심층 분석" 버튼 → 1크레딧 차감 → Tavily 웹 검색 → LLM 구조화 → 면접 시 company_specific 질문 생성
  - API: `POST /api/job-posting/[id]/research` (멱등 — 이미 분석 완료 시 재과금 없음)
  - 프롬프트: `DEEP_COMPANY_ANALYSIS_PROMPT` (`app/src/prompts/company-research.ts`)
  - 결과: CompanyAnalysis에 deepResearch=true + companyOverview, recentNews, products 등 추가
- **모범답안 학습**: 이력서 선택 → AI가 질문+모범답안 생성 → 질문별 음성 답변 연습 → 모범답안 공개
  - "내 답변 말해보기": `useSpeechRecognition` 훅 재사용, 실시간 transcript 표시
  - 질문 이동 시 음성 상태 자동 리셋, transcript를 userNotes Map에 저장
- **대시보드**: 성장 분석(점수 추이 차트 + 카테고리별 성과 차트)이 대시보드에 통합됨. 별도 analytics 페이지 없음.
- **온보딩**: 첫 방문 시(sessionCount=0 && !freeTrialUsed) 웰컴 다이얼로그 3단계 표시
  - `components/onboarding/welcome-dialog.tsx`
  - 대시보드 빈 상태: 3단계 가이드 + CTA

## 레이아웃
- **사이드바**: `components/layout/sidebar.tsx` — 대시보드, 면접 시작, 모범답안, 이력서 관리, 크레딧, 면접 기록
- **푸터**: `components/layout/footer.tsx` — 문의 이메일 + 저작권 (인증된 레이아웃 하단)

## 평가 프롬프트 (`prompts/evaluation.ts`)
- **기술면접**: clarity 30% + accuracy 25% + practicality 25% + depth 15% + completeness 5%
- **심화면접**: clarity 25% + accuracy 20% + practicality 25% + depth 25% + completeness 5%
- **인성면접**: situation 15% + task 15% + action 30% + result 25% + communication 15%
- **꼬리질문 전용**: `FOLLOWUP_EVALUATION_PROMPT` — previousContext(원본 Q/A + 꼬리질문 히스토리) 기반 평가

## 크레딧 & 결제 시스템
- **과금 모델**: 크레딧 충전제. 세션 1회 = 10코인, 꼬리질문 1코인 (면접/모범답안 동일)
- **무료 체험**: 신규 유저 1회 무료 (질문 3개 제한). `User.freeTrialUsed` boolean으로 관리
- **Dev 모드**: `NODE_ENV === 'development'`면 크레딧 체크 스킵
- **원자적 차감**: `prisma.$transaction` + `updateMany(where: { creditBalance: { gte: 1 } })` → 동시 요청 방지
- **차감 시점**: AI 생성 성공 후 차감 (실패 시 미차감)
- **서비스**: `app/src/services/credit.service.ts` — getBalance, canStartSession, deductForSession, deductForFeature, refundForSession, grantCredits, getTransactions
- **API**: `GET /api/credits` (잔액), `GET /api/credits/transactions` (내역)
- **쿠폰**: 프로모션 코드로 크레딧 지급
  - 모델: `Coupon` (code, credits, maxUses, usedCount, isActive, expiresAt), `CouponUsage` (couponId+userId unique)
  - 서비스: `app/src/services/coupon.service.ts` — validateCoupon, redeemCoupon (원자적 $transaction)
  - API: `POST /api/coupons/redeem` — zod 검증, 에러 코드: INVALID_COUPON, EXPIRED_COUPON, MAX_USES_REACHED, ALREADY_USED
  - UI: `/credits` 페이지에 쿠폰 입력 카드 (Gift 아이콘, uppercase, Enter 키 지원)
  - `CreditTxType.COUPON` enum 값 추가
- **게이팅 라우트**: `/api/interview/setup`, `/api/model-answer/generate`
- **402 응답**: `{ error: '...', code: 'INSUFFICIENT_CREDITS' }` → UI에서 크레딧 부족 다이얼로그/페이지 표시
- **UI**: `components/credit/credit-badge.tsx` (헤더), `components/credit/insufficient-credits-dialog.tsx`, `/credits` 페이지
- **Toss Payments 연동**:
  - 상품: `app/src/lib/payment-products.ts` — 50/150/300 코인 (3,000/8,000/14,000원)
  - 플로우: 상품 선택 → `POST /api/payments/orders` (주문 생성) → Toss SDK 결제창 → `POST /api/payments/confirm` (서버 확인 + 크레딧 부여)
  - 멱등성: `orderId`를 Toss `Idempotency-Key`로 전달, DONE 상태 주문은 재처리 없이 성공
  - 서비스: `app/src/services/payment.service.ts` — createOrder, confirmPayment, failOrder

## DB 모델 (핵심)
- `User` — 계정 (Google OAuth, hashedPassword 없음, creditBalance, freeTrialUsed)
- `Account` — OAuth 계정 (PrismaAdapter 관리)
- `Resume` — 복수 이력서 (userId, name, parsedData, fileUrl은 optional)
- `JobPosting` — 채용공고
- `InterviewSession` — 면접 세션 (resumeId 필수, jobPostingId 선택, creditDeducted)
- `InterviewAnswer` — 답변/평가 (audioUrl: 녹음 파일 경로)
- `CreditTransaction` — 크레딧 거래 내역 (amount, balance, type: CreditTxType, referenceId)
- `PaymentOrder` — Toss 결제 주문 (orderId, paymentKey, amount, credits, status: PENDING/DONE/FAILED)
- `Coupon` — 쿠폰 (code unique, credits, maxUses, usedCount, isActive, expiresAt)
- `CouponUsage` — 쿠폰 사용 기록 (couponId+userId unique → 중복 사용 방지)

## 배포
- Vercel, 리전: `icn1` (인천/서울) — `vercel.json`
- `output: 'standalone'` 사용하지 않음 (Vercel에서 불필요)
- Redis 없음 — `lib/redis.ts`가 연결 실패 시 graceful 무시 (캐시만 스킵)

## 음성 처리
- **transcript 정규화**: `lib/transcript.ts` — 필러워드/더듬기/부분반복 제거 + `countFillerWords()` (필러워드 카운트)
- **AI 교정**: `lib/transcript-server.ts` — 서버 측 transcript 교정 (`correctedTranscript`), 질문 맥락 전달로 기술용어 교정 정확도 향상
- **음성인식 (하이브리드)**:
  - 실시간 표시: Web Speech API (`maxAlternatives=3` + confidence 기반 최적 대안 선택)
  - 최종 전사: Whisper API (선택적, `OPENAI_API_KEY` 필요) — 답변 제출 시 녹음 데이터를 Whisper로 전사, 실패 시 Web Speech API 폴백
  - 래퍼: `app/src/lib/whisper.ts` (싱글톤, `isWhisperAvailable` export)
  - 녹음 훅: `app/src/hooks/useAudioRecorder.ts` (MediaRecorder API)
  - API: `POST /api/transcribe` — multipart/form-data (audio 파일), 인증 필수
- **실시간 발화 분석**: `hooks/useSpeechAnalytics.ts` — 답변 중 실시간 비언어적 피드백
  - `SpeechMetrics`: wpm (음절/분), fillerCount, silenceSec, silenceRatio, elapsedSec
  - 말 속도: 한국어 글자 수 ≈ 음절 수 / 경과 시간 → WPM. 느림 <200 / 적정 200-350 / 빠름 >350
  - 필러워드: `countFillerWords()`로 원본 transcript에서 실시간 카운트
  - 침묵 감지: transcript 변화 없는 구간 2초 이상 = 침묵, 500ms interval로 누적
  - 세션 페이지: listening 단계에 3열 지표 패널 (말 속도/침묵/필러워드) + feedback에 한 줄 요약
  - `useInterviewSession`에서 start/stop/reset/feed 연동, `AnswerWithEval.speechMetrics`에 저장
  - 리포트: `report.service.ts`에서 실제 transcript 기반 fillerWordCount, WPM 기반 speechRate 계산
  - `SpeechAnalysis` 타입: `averageWpm?`, `totalSilenceSec?`, `averageSilenceRatio?` 추가

## 환경 변수
- `app/.env` — DB, Anthropic API 키, NextAuth, Google OAuth, Toss 등
- Vercel 필수: `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `ANTHROPIC_API_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_TRUST_HOST=true`, `NEXT_PUBLIC_TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`
- Vercel 선택: `TAVILY_API_KEY` (심층 기업 분석, 없으면 버튼 미노출), `OPENAI_API_KEY` (Whisper 음성인식, 없으면 Web Speech API만 사용)
