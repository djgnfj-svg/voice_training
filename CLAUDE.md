# Project: AI 면접 코치

## 구조
- 모노리포가 아님. **앱은 `app/` 하나**뿐임.
- `app/` — Next.js 앱 (프론트+백엔드 전부)
- `db/` — DB 초기화 스크립트
- `nginx/` — 리버스 프록시 설정
- `docker-compose.yml` — PostgreSQL + MinIO + nginx

## 개발 규칙
- 인프라(PostgreSQL, Redis, MinIO)는 `docker compose up -d`로 띄움.
- Next.js dev 서버는 `cd app && PORT=3001 npm run dev`로 포트 3001에서 실행. 하나만.
- prisma 명령 실행 시 `cd app && set -a && source .env.local && set +a` 후 실행.
- `node.exe` 프로세스를 함부로 죽이지 말 것 (dev 서버가 꺼짐).

## 코드 규칙
- placeholder/example 값 만들지 말 것. 실제 값이 없으면 비워두거나 물어볼 것.
- 불필요한 파일 생성 금지. 기존 파일 수정 우선.

## 기술 스택
- Next.js 15 (App Router)
- Prisma + PostgreSQL
- MinIO (파일 저장)
- OpenAI API (GPT)
- TanStack Query (클라이언트 상태)
- shadcn/ui (UI 컴포넌트)
- NextAuth (인증, 개발 모드에서는 가짜 세션)
