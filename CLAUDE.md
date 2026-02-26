# Project: AI 면접 코치

## 구조
- 모노리포가 아님. **앱은 `app/` 하나**뿐임.
- `app/` — Next.js 앱 (프론트+백엔드 전부)
- `db/` — DB 초기화 스크립트
- `nginx/` — 리버스 프록시 설정
- `docker-compose.yml` — PostgreSQL, Redis (인프라만, 앱 서비스 없음, Redis는 로컬 전용)

## 개발 규칙
- 인프라(PostgreSQL, Redis)는 `docker compose up -d`로 띄움. Redis는 선택적 — 없으면 캐시 무시하고 동작.
- Next.js dev 서버는 `cd app && PORT=3001 npm run dev`로 포트 3001에서 실행. 하나만.
- prisma 명령 실행 시 `cd app && set -a && source .env.local && set +a` 후 실행.
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
  - `anthropic` — SDK 직접 export (스트리밍용, 컨닝 모드 등)
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
- **컨닝 모드**: 이력서 선택 → (채용공고 텍스트) → 마이크 실시간 감지 → 2초 침묵 시 자동 답변 생성 (DB 저장 없음, stateless)

## DB 모델 (핵심)
- `User` — 계정 (Google OAuth, hashedPassword 없음)
- `Account` — OAuth 계정 (PrismaAdapter 관리)
- `Resume` — 복수 이력서 (userId, name, parsedData, fileUrl은 optional)
- `JobPosting` — 채용공고
- `InterviewSession` — 면접 세션 (resumeId 필수, jobPostingId 선택)
- `InterviewAnswer` — 답변/평가

## 배포
- Vercel, 리전: `icn1` (인천/서울) — `vercel.json`
- `output: 'standalone'` 사용하지 않음 (Vercel에서 불필요)
- Redis 없음 — `lib/redis.ts`가 연결 실패 시 graceful 무시 (캐시만 스킵)

## 환경 변수
- `app/.env.local` — DB, Anthropic API 키, NextAuth, Google OAuth 등
- Vercel 필수: `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `ANTHROPIC_API_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_TRUST_HOST=true`
