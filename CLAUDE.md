# Project: AI 면접 코치

## 구조
- 모노리포가 아님. **앱은 `app/` 하나**뿐임.
- `app/` — Next.js 앱 (프론트+백엔드 전부)
- `db/` — DB 초기화 스크립트
- `nginx/` — 리버스 프록시 설정
- `docker-compose.yml` — PostgreSQL, Redis, MinIO (인프라만, 앱 서비스 없음)

## 개발 규칙
- 인프라(PostgreSQL, Redis, MinIO)는 `docker compose up -d`로 띄움.
- Next.js dev 서버는 `cd app && PORT=3001 npm run dev`로 포트 3001에서 실행. 하나만.
- prisma 명령 실행 시 `cd app && set -a && source .env.local && set +a` 후 실행.
- `node.exe` 프로세스를 함부로 죽이지 말 것 (dev 서버가 꺼짐).

## 코드 규칙
- placeholder/example 값 만들지 말 것. 실제 값이 없으면 비워두거나 물어볼 것.
- 불필요한 파일 생성 금지. 기존 파일 수정 우선.
- 데드코드, 미사용 import 남기지 말 것.

## 기술 스택
- Next.js 15 (App Router)
- Prisma + PostgreSQL
- MinIO (파일 저장)
- Anthropic Claude API (`@anthropic-ai/sdk`, 래퍼: `app/src/lib/openai.ts`)
  - ANALYSIS: claude-haiku-4-5
  - EVALUATION / QUESTION_GEN: claude-sonnet-4-6
- Edge TTS (`msedge-tts`, 무료, API 키 불필요)
  - 음성: `ko-KR-SunHiNeural` (여성) / `ko-KR-InJoonNeural` (남성)
  - API: `POST /api/tts` → MP3 반환
  - `next.config.ts`의 `serverExternalPackages`에 등록 필수
- TanStack Query (클라이언트 상태)
- shadcn/ui (UI 컴포넌트)
- NextAuth (인증, 개발 모드에서는 가짜 세션)

## 주요 플로우
이력서 선택(필수) → 채용공고 입력(선택) → AI 자동 설계 → 면접 시작

## DB 모델 (핵심)
- `User` — 계정 (이력서 필드 없음, resumes 관계로 분리됨)
- `Resume` — 복수 이력서 (userId, name, fileUrl, parsedData)
- `JobPosting` — 채용공고
- `InterviewSession` — 면접 세션 (resumeId 필수, jobPostingId 선택)
- `InterviewAnswer` — 답변/평가

## 환경 변수
- `app/.env.local` — DB, Redis, MinIO, Anthropic API 키, NextAuth 등
- `.env` — docker-compose용 (루트)
