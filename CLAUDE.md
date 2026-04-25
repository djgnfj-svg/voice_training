# Project: VoicePrep (보이스프렙)

## 구조
- `frontend/` — Next.js 프론트엔드 + NextAuth 인증만
- `backend/` — FastAPI 백엔드 (API, 서비스, 프롬프트, AI 로직 전부)
- `tts/` — OpenAI TTS 래퍼 서비스 (FastAPI + gpt-4o-mini-tts)
- `db/` — DB 초기화 + 마이그레이션 (`db/init/`, `db/migrations/`)
- `docker-compose.yml` — **Dev 전용** (프로젝트명 `voice_training`, 포트 81). nginx + frontend(`next dev`) + backend(`--reload` + volume mount) + tts
- `docker-compose.prod.yml` — **Prod 전용** (프로젝트명 `voiceprep-prod`, 포트 82). nginx + frontend(production 빌드) + backend(volume mount 없이 빌드된 이미지) + tts
- Dev/Prod 완전 격리: 컨테이너 이름, 네트워크, 볼륨 모두 분리. 공유되는 건 Supabase DB + OpenAI 쿼터 + 루트 `.env`뿐. DB는 Supabase 호스팅
- `nginx/` — nginx 리버스 프록시 (`/api/auth` → frontend, `/api/*` → backend, 나머지 → frontend)

## 개발 규칙
- Dev 기동: `docker compose up -d` (nginx:81 + frontend[dev] + backend[reload+mount] + tts).
- Prod 기동: `docker compose -f docker-compose.prod.yml up -d` (nginx:82 + frontend[prod build] + backend[baked image] + tts).
- Dev/Prod 동시 기동 가능 (프로젝트/네트워크/볼륨 격리). 내릴 때도 각 파일에 `-f` 명시하여 `down`.
- 접속: **dev = `http://localhost:81`**, **prod = `http://localhost:82`**. frontend/backend/tts는 외부 포트 노출 없이 Docker 내부 네트워크만 사용.
- Cloudflare Tunnel은 `~/.cloudflared/config.yml` 에서 `jachana.com` → `http://localhost:82` (prod)로 라우팅. dev는 로컬 확인용.
- **환경변수는 루트 `.env` 단일 소스** (`.env.example` 참고). docker-compose가 dev/prod 모두 루트 `.env`를 읽고 frontend 빌드 args + backend env_file로 주입. `frontend/.env`/`backend/.env`는 사용하지 않음 (로컬 직접 실행 때만 별도 셋업).
- 프로덕션 빌드는 `NEXT_PUBLIC_*` 환경변수를 빌드 타임에 번들에 인라인. 변경 시 prod 프론트 **rebuild 필수**.
- 로컬 직접 실행 시: `cd frontend && PORT=3001 npm run dev` / `cd backend && uvicorn app.main:app --reload --port 8000`
- prisma 명령 실행 시 `cd frontend && set -a && source ../.env && set +a` 후 실행.
- `node.exe` 프로세스를 함부로 죽이지 말 것 (dev 서버가 꺼짐).
- Dev 프론트 수정: `docker compose build frontend && docker compose up -d frontend`. Prod 프론트 수정: `docker compose -f docker-compose.prod.yml build frontend && docker compose -f docker-compose.prod.yml up -d frontend`.
- **Dev 백엔드**는 `./backend` 볼륨 마운트 + `--reload`라 코드 수정 시 자동 반영 (rebuild 불필요). **Prod 백엔드**는 baked image라 배포 시 매번 rebuild: `docker compose -f docker-compose.prod.yml build backend && docker compose -f docker-compose.prod.yml up -d backend`.
- NEXT_PUBLIC_* 변경 시 Dev: `docker compose up -d --force-recreate frontend`. Prod는 빌드 타임 인라인이라 **rebuild 필수**.
- 인증 필요 페이지는 `src/app/(authenticated)/layout.tsx` 의 `export const dynamic = 'force-dynamic'`로 프로덕션 빌드 시 prerender 회피.

## 코드 규칙
- placeholder/example 값 만들지 말 것. 실제 값이 없으면 비워두거나 물어볼 것.
- 불필요한 파일 생성 금지. 기존 파일 수정 우선.
- 데드코드, 미사용 import 남기지 말 것.
- **API 로직은 backend/에 작성**. frontend/src/app/api/에는 auth만 존재.
- DB 리소스 조회 시 반드시 `user_id` 소유권 검증 포함 (JobPosting, Resume 등).
- 에러 응답에 내부 예외 메시지 노출 금지 — 고정 문자열 사용.
- HTTPException detail은 `{"error": "메시지"}` 딕셔너리 형태로 통일 (프론트에서 `data.error`로 읽음).
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
- Prisma — NextAuth PrismaAdapter 전용 (`frontend/src/lib/prisma.ts`, `frontend/src/lib/auth.ts`). 에이전트/학습 테이블은 SQLAlchemy + raw SQL 마이그레이션으로 관리

### 백엔드 (`backend/`)
- FastAPI (Python)
- SQLAlchemy / PostgreSQL (Supabase 호스팅)
- NextAuth JWE 토큰 복호화: `joserfc` + HKDF (Python 네이티브, Node.js 서브프로세스 불필요)
- OpenAI API — 모든 LLM 호출 통합 (기본 `gpt-4o-mini`). `AGENT_MODEL` 환경변수로 런타임 교체 가능. 공용 클라이언트: `backend/app/lib/llm_client.py` (call_llm / call_llm_json / call_llm_stream)
- 에이전트 오케스트레이션 — **LangGraph 기반 그래프** (`backend/app/agent/interview/graph.py`, `backend/app/agent/learning_coach/graph.py`). `tracing.py`로 노드 단위 트레이싱
- **pgvector** — Postgres 확장 기반 RAG (프로필 + 이력서 임베딩, OpenAI text-embedding-3-small). raw SQL로 코사인 유사도 검색
- TTS — **OpenAI `gpt-4o-mini-tts`** (voice `sage`, speed 2.0x, 페르소나: default/interviewer/tutor). 별도 `tts` Docker 서비스가 래핑. 실패 시 edge-tts로 자동 폴백
- Whisper API (선택적 — 음성인식, 없으면 Web Speech API만 사용)

### TTS 서비스 (`tts/`)
- FastAPI + OpenAI TTS SDK, 포트 8080 (Docker 내부만)
- 엔드포인트: `POST /synthesize {text, voice?, persona?, speed?, model?}` → audio/mpeg
- 페르소나는 `gpt-4o-mini-tts`의 `instructions` 파라미터로 톤 지시 (같은 보이스도 다르게 들림)
- 속도: gpt-4o-mini-tts는 `speed` 파라미터를 거의 무시 → instructions에 "very fast" 힌트로 보완. 실제 속도 빠르게 원하면 `tts-1` 모델 사용 (페르소나는 무시됨)

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
  - 모듈 (`backend/app/agent/interview/`):
    - `graph.py` — LangGraph 오케스트레이션 (전체 그래프 정의)
    - `state.py` — 그래프 상태
    - `plan_builder.py` — Scan/Dive 플랜 빌더 (순수 코드)
    - `questioner.py` — 질문 생성 (LLM)
    - `evaluation.py` — 답변 평가 (LLM + 정규화/가드)
    - `profile_memory.py` — 프로필 RAG (pgvector)
    - `resume_memory.py` — 이력서 RAG (pgvector, chunk_type별)
    - `fit_analysis.py` — JD↔이력서 적합도 분석
    - `report_metrics.py` — 리포트 집계
  - 프로필 RAG: pgvector + OpenAI Embeddings, 강점/약점/패턴/맥락 카테고리
  - **이력서 RAG**: `resume_embeddings` 테이블 (chunk_type: summary/project/experience/education). 이력서 저장 시 BackgroundTask로 자동 청킹+임베딩. 매 질문 직전 scan/dive 플랜의 project_ref+techStack 쿼리로 top-3 retrieve
  - **Scan+Dive 2페이즈**: 실제 면접관처럼 훑기→딥다이브 구조.
    - **Phase 1 (Scan)**: `build_scan_plan` 순수 코드가 이력서 프로젝트 3개 선정. JD 있음 → 매칭 상위 2 + 비매칭 1. JD 없음 → projects[0..2] 순서. projects 부족시 experience로 보충
    - **Phase 2 (Dive)**: `build_dive_plan`이 훑기 답변의 depth 점수로 약점(최저) + 강점(최고) 2주제 선정. JD 매칭 프로젝트 내에서만 선별. 주제당 1~3질문 적응형 (depth<70이면 계속 파기, depth>=3이면 next_topic 강제)
    - 총 질문 수 가변 (projects 수에 따라 3~9). 프론트에 `max_questions` SSE event로 전달
    - SSE `question` event에 `phase: "scan"|"dive"`, `phaseLabel` 포함
    - 세션 영속화: `agent_interview_sessions`에 `phase`, `scan_plan`, `dive_plan`, `scan_evaluations` JSONB + `current_scan_idx`/`current_dive_idx`/`current_dive_depth` 정수 3컬럼
  - **Fit Analysis**: 면접 시작 시 1회 산출 → `agent_interview_sessions.fit_analysis` JSONB 영속화. **skill_match(코드) + avoid_topics**만 반환. 플래너가 skill_match로 scan 선정
  - **프롬프트 분기**: `INTERVIEWER_QUESTION_PROMPT_SLIM` (임베딩 있을 때) / `_FALLBACK` (없을 때). `backend/app/prompts/agent.py`
  - SSE 스트림: `phase` 값 `loading_profile → profile_loaded → fit_analyzing → fit_analyzed → scan_plan_ready → generating_question → question → evaluating → dive_plan_ready → ...`
  - 세션 종료 시 프로필 자동 업데이트 (인사이트 추출 → RAG 저장)
  - API: `/api/agent-interview/{start,answer,skip,end,{id}}`, `/api/profile`, `/api/profile/context`
  - UI: `frontend/src/components/agent-interview/`, `frontend/src/app/(authenticated)/agent-interview/`
  - **평가 파이프라인**:
    - EVALUATOR_PROMPT: 각 역량 0~100 독립 채점 + 저품질 답변 규칙(반복/무관/포기/단답에 카테고리별 0~40 cap 명시)
    - `evaluation._normalize_evaluation(evaluation, answer)`: scores 0~100 clamp + `_quality_cap(answer)` 후처리(char_ratio/token unique_ratio 기반) + **overallScore = Σ(score_i × weight_i) 서버 강제 계산** (LLM 출력 무시)
    - 가중치: clarity 30%, accuracy 25%, practicality 25%, depth 15%, completeness 5%
  - **답변 가드**: 프론트 `lib/transcript.ts`의 `hasMeaningfulContent` + 인라인 경고 UI, 백엔드 `_is_meaningful_answer`로 400 반환. `SILENCE_TIMEOUT_MS = 30000`
  - **모바일 중복 입력 방어**: `useSpeechRecognition.appendWithOverlap`으로 prev 끝과 새 final overlap 제거. `transcript.ts`의 `collapseImmediateRepeats`/`collapseRepeatedPhrases`
  - **/end 핸들러**: 수동 종료도 프로필 업데이트 + 리포트 생성 후 reportData 저장. 프론트 `endAgentInterview`는 `AbortSignal.timeout(30000)`
  - **히스토리 통합**: `services/analytics.get_session_history`가 InterviewSession + AgentInterviewSession 병합. agent는 `type: 'ai-coach'`. `SessionCard`가 `isAgent` 분기로 `/agent-interview/session/{id}` 라우팅
  - **레이아웃**: `authenticated-content.isFullscreenSession`에 `/agent-interview/session/` 포함 (면접 중 Header 숨김)
- **기존 면접 (레거시)**: 일반/심화 모드. 백엔드 API 유지
- **멀티라운드 꼬리질문**: 메인 답변 → 꼬리질문 최대 2회 연쇄
  - 깊이 사다리: what → why → tradeoffs/alternatives
  - depth < 80이면 followUpQuestion 필수 생성
  - API: `/api/interview/practice-evaluate` (stateless)
- **답변 녹음 재생**: 녹음 → fire-and-forget 업로드 → 리포트에서 재생
  - `InterviewAnswer.audioUrl` 필드
  - API: `POST /api/interview/audio` (multipart, 세션 소유권 검증)
- **모범답안 학습**: 이력서 선택 → AI가 질문+모범답안 생성 → 음성 답변 연습 → 모범답안 공개
- **대시보드**: 성장 분석(점수 추이 차트 + 카테고리별 성과 차트) 통합
- **온보딩**: 첫 방문 시 웰컴 다이얼로그 3단계 표시 (`components/onboarding/welcome-dialog.tsx`)

## CS 학습 어시스트 (Learning Coach) 시스템
- **개요**: 목표 기반 agentic 학습 에이전트. SRS 기반 복습. 모바일 전용 UI. 세션 중 목표 변경 감지 + curriculum swap 지원
- **모듈** (`backend/app/agent/learning_coach/`):
  - `graph.py` — LangGraph 그래프 (plan → action 루프, RAG 이어가기 인사, goal swap, SRS)
  - `curriculum_seed.py` — 초기 종목/토픽 시드
  - `learning_memory.py` — 학습 기억 (UserKnowledge proficiency)
  - `spaced_repetition.py` — SRS 스케줄링 (nextReviewAt 계산)
  - `session_summary.py` — 세션 종료 요약
- **프롬프트**: `backend/app/prompts/learning_coach.py`
- **API**: `/api/learning-coach/{start, {session_id}/respond, {session_id}/end, status, history}`
- **UI**: `/learning-coach` (사이드바 라벨 "CS 학습 어시스트")
- **음성 전용**: 코드 블록/마크다운 렌더링 없음. 답변은 음성으로 듣고 검색해서 학습

## 레이아웃
- **사이드바** (`components/layout/sidebar.tsx`): 대시보드, 면접 연습, CS 학습 어시스트 (3개)
- **면접 연습 페이지**: 탭 구조 — [면접] (셋업 + 면접 기록 인라인) / [이력서 관리]. `/profile` → `/interview/setup?tab=resume`, `/history` → `/interview/setup` 리다이렉트
- **푸터** (`components/layout/footer.tsx`): 문의 이메일 + 저작권

## 평가 프롬프트 (`backend/app/prompts/evaluation.py`)
- **기술면접**: clarity 30% + accuracy 25% + practicality 25% + depth 15% + completeness 5%
- **심화면접**: clarity 25% + accuracy 20% + practicality 25% + depth 25% + completeness 5%
- **인성면접**: situation 15% + task 15% + action 30% + result 25% + communication 15%
- **꼬리질문 전용**: `FOLLOWUP_EVALUATION_PROMPT` — previousContext 기반 평가

## DB 모델 (핵심)
- `User` — 계정 (Google OAuth)
- `Account` — OAuth 계정 (PrismaAdapter 관리)
- `Resume` — 복수 이력서 (userId, name, parsedData, fileUrl optional). `GET /api/resume?detail=true`로 parsedData 포함 조회
- `JobPosting` — 채용공고
- `InterviewSession` — 면접 세션 (userId, resumeId 필수, jobPostingId 선택, type, categories[], difficulty, status, textMode, overallScore, reportData, durationSeconds, totalQuestions)
- `InterviewAnswer` — 답변/평가 (audioUrl)
- `AgentInterviewSession` — 에이전트 면접 세션 (resumeId, jobPostingId, maxQuestions, status, reportData, fitAnalysis JSONB, phase/scanPlan/divePlan/scanEvaluations JSONB, currentScanIdx/currentDiveIdx/currentDiveDepth Int)
- `AgentInterviewMessage` — 에이전트 면접 메시지 (sessionId, messageIndex, role, content, evaluation JSON)
- `UserProfileEmbedding` — 사용자 프로필 벡터 (userId, category, content, embedding VECTOR(1536), metadata)
- `resume_embeddings` — 이력서 RAG 벡터 (chunk_type: summary/project/experience/education)
- 학습 시스템 테이블 (SQLAlchemy 관리, raw SQL 마이그레이션): Subject, Topic, UserKnowledge, LearningAgentSession, LearningAgentMessage, DailyProgress
- `ActivityLog` + `ActivityItem` — 활동 추적 로그
- 마이그레이션: `db/migrations/*.sql` (날짜별 + feature별)

## 배포
- **방식**: 로컬 PC + Cloudflare Tunnel (PC 로그인 상태에서만 서비스)
- **도메인**: `jachana.com` (Cloudflare 관리)
- **배포 설정**: `docker compose -f docker-compose.prod.yml up -d` → `cloudflared tunnel run` (터널은 prod:82만 바라봄)
- **터널 config**: `~/.cloudflared/config.yml` — `jachana.com` → `http://localhost:82`
- **nginx**: `/api/auth` rate limit 5r/s, `/api/` rate limit 10r/s
- **음성 파일**: Docker named volume — dev/prod 각각 별도 (`voice_training_audio-storage`, `voiceprep-prod_audio-storage`)
- **CI 없음**: 로컬 PC + Cloudflare Tunnel 배포라 GitHub Actions 사용 안 함

### 자동 시작 (로그인 시 자동 기동)
- **Docker Desktop**: `%APPDATA%\Docker\settings-store.json`의 `AutoStart: true`. 모든 컨테이너는 `restart: unless-stopped`. prod 컴포즈 프로젝트는 한 번이라도 `up -d`로 띄운 이력이 있어야 Docker Desktop이 재기동
- **Cloudflared**: Windows Startup 폴더에 VBS 스크립트 — 콘솔창 없이 백그라운드 실행
  - 경로: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\VoicePrep-Cloudflared.vbs`
  - 내용: `WshShell.Run """...\cloudflared.exe"" tunnel run", 0, False`
  - cloudflared 경로가 바뀌면 VBS도 수정
- **동작 순서**: Windows 로그인 → Docker Desktop 기동 → 컨테이너 자동 복구 → VBS가 cloudflared 기동 → `jachana.com` 온라인 (30초~1분)

## 음성 처리
- **transcript 정규화**: `frontend/src/lib/transcript.ts` — 필러워드/더듬기/부분반복 제거 + `countFillerWords()`
- **AI 교정**: `backend/app/lib/transcript_server.py` — 서버 측 transcript 교정
- **음성인식 (하이브리드)**:
  - 실시간 표시: Web Speech API (`maxAlternatives=3` + confidence 기반 최적 대안 선택)
  - 최종 전사: Whisper API (선택적) — 답변 제출 시 녹음 데이터를 Whisper로 전사, 실패 시 Web Speech API 폴백
  - 클라이언트 래퍼: `frontend/src/lib/whisper-client.ts`
  - 녹음 훅: `frontend/src/hooks/useAudioRecorder.ts` (MediaRecorder API)
  - API: `POST /api/transcribe` (오디오 확장자 화이트리스트: webm/wav/mp3/ogg/mp4/m4a)
- **실시간 발화 분석**: `hooks/useSpeechAnalytics.ts` — 답변 중 실시간 비언어적 피드백
  - `SpeechMetrics`: wpm (음절/분), fillerCount, silenceSec, silenceRatio, elapsedSec

## 환경 변수 (루트 `.env` 단일 소스, `.env.example` 참고)
- **공통**: `DATABASE_URL`, `DIRECT_URL`
- **Auth (Frontend)**: `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST=true`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `BACKEND_URL=http://backend:8000`
- **Backend AI**: `OPENAI_API_KEY` (필수, LLM+임베딩+Whisper+TTS 공유), `TAVILY_API_KEY` (선택), `ENVIRONMENT`, `AGENT_MODEL` (기본 `gpt-4o-mini`), `ADMIN_EMAILS`
- **Public (빌드 타임 인라인)**: `NEXT_PUBLIC_ADMIN_EMAILS`, `NEXT_PUBLIC_GA_MEASUREMENT_ID`
- **TTS 오버라이드 (선택)**: `TTS_MODEL`, `TTS_DEFAULT_VOICE`, `TTS_FORMAT`, `TTS_SPEED`
- TTS 서비스는 루트 `.env`의 `OPENAI_API_KEY`를 docker-compose `env_file`로 공유
