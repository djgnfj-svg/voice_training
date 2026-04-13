# TODO

## ✅ 2026-04-13 작업 완료 (feat/resume-rag)

### 평가 시스템 70점 고정 버그 — 수정됨
- `backend/app/prompts/agent.py` EVALUATOR_PROMPT: 각 역량 0~100 독립 채점 명시, 점수 구간 힌트, overallScore 필드 제거 (서버가 계산)
- `backend/app/agent/evaluator_agent.py`: `_normalize_evaluation` 후처리 — scores clamp(0~100) + overallScore = Σ(score_i × weight_i) 강제
- 커밋: `fix(eval): 70점 고정 버그 — 0~100 척도 강제 + 가중평균 후처리`

### 리포트 누락 / in_progress 잔존 — 수정됨
- `nodes.decide_next`: LLM이 `follow_up_round < 2` 제약을 무시해 꼬리질문 4라운드까지 쌓이고 세션이 영원히 in_progress에 머물던 현상. 한계치를 코드가 강제 (question_count >= max면 end)
- `router.end_interview`: 지금까지 status=completed만 찍고 update_profile/generate_report를 호출하지 않아 수동 종료 세션은 reportData=NULL로 남음. 대화 히스토리 복원 후 리포트 생성까지 수행
- 커밋: `fix(agent-interview): 리포트 누락 2건 — follow_up 한계 강제 + /end 리포트 생성`

### 면접 중 침묵 허용 완화 — 수정됨
- `components/agent-interview/agent-interview-panel.tsx`: `SILENCE_TIMEOUT_MS` 3s → 30s
- 커밋: `fix(agent-interview): 침묵 자동 제출 3s → 30s 완화`

### 꼬리질문 중복/애매함 — 수정됨
- `MAX_FOLLOW_UP_ROUND` 2 → 1 (main당 최대 1회)
- `INTERVIEWER_DECIDE_PROMPT`: 판정 순서 명확화, depth 임계치 80 → 70
- `INTERVIEWER_FOLLOWUP_PROMPT`: 주제/형식 중복 금지 명시, "구체적으로 설명해주세요" 류 두루뭉술 표현 차단, 직전 답변의 구체 사실·결정·수치를 지목해 파고들도록 강제
- 커밋: `fix(agent-interview): 꼬리질문 중복/애매함 개선`

### 리그레션 재측정 필요 (다음 사용자 테스트 시)
- 답변별 scores 분포가 실제로 벌어졌는지 (Q마다 다른 점수 나오는지)
- overallScore가 70 고정에서 벗어났는지
- improvements/recommendations 필드가 채워진 completed 세션이 남는지
- 꼬리질문 1회로 줄인 뒤 체감 (너무 짧으면 다시 2로 조정 검토)

---

## 레거시 정리 (한 번에 일괄 작업)

### 배경
- AI 코치 면접(`AgentInterviewSession`)이 유일한 면접 흐름으로 정착. 레거시 일반/심화 면접 UI는 이미 제거됨
- 하지만 프론트 페이지·백엔드 라우터·DB 테이블은 남아있어 history 병합·analytics 분기 등 유지보수 부담

### 제거 대상
**프론트**
- `frontend/src/app/(authenticated)/interview/session/[id]/page.tsx` — 레거시 세션 진행 페이지
- `frontend/src/app/(authenticated)/interview/practice/[id]/page.tsx` — 레거시 연습 페이지 (COMPLETED 세션 진입)
- `frontend/src/app/(authenticated)/interview/report/[id]/page.tsx` — 레거시 리포트
- `frontend/src/hooks/usePracticeSession.ts` — practice-evaluate 호출 훅
- `frontend/src/app/(authenticated)/interview/setup/page.tsx` 의 SessionCard href 분기 단순화 (지금은 ai-coach 외에 legacy COMPLETED/IN_PROGRESS 분기 있음)
- `authenticated-content.tsx` `isFullscreenSession`에서 `/interview/session/` 제거 가능성 (경로 자체가 사라지면)

**백엔드**
- `backend/app/routers/interview.py` — `/api/interview/setup`, `/api/interview/practice-evaluate`, `/api/interview/audio` 등 레거시 엔드포인트
- `backend/app/services/report.py` — 레거시 세션 리포트 (share if any)
- `backend/app/services/evaluation.py` — 레거시 평가 프롬프트 사용처
- `backend/app/prompts/evaluation.py` — `TECHNICAL/BEHAVIORAL/MIXED + FOLLOWUP` 프롬프트 (AgentInterview는 `prompts/agent.py` 사용)
- `backend/app/models/interview.py` 의 `InterviewSession`, `InterviewAnswer` (JobPosting은 AgentInterviewSession이 공유하므로 **유지**)
- `backend/app/services/analytics.py` 의 legacy 분기 (병합 로직 단순화)

**DB**
- `interview_sessions`, `interview_answers` 테이블 drop
- 단, 기존 유저 과거 기록 보존 원하면 읽기 전용 archival 옵션 (별도 논의)

### 확인 필요 (제거 전 grep)
- `usePracticeSession` / `practice-evaluate` / `InterviewSession` / `InterviewAnswer` 호출처
- 모범답안 학습(`ActivityLog`, `AnswerAssistSession`)이 레거시와 공유하는 코드 여부
- `InterviewAnswer.audioUrl`(녹음 파일) Docker `audio-storage` volume 정책 — 파일 정리 스크립트 필요할 수도

### 작업 순서 제안
1. 코드 grep으로 참조 전수 조사 (별도 문서에 정리)
2. 프론트 페이지 + 훅 제거
3. 백엔드 라우터 + 서비스 + 프롬프트 제거
4. `analytics.get_session_history` 단순화 (agent만 반환)
5. 유저 알림/데이터 이관 정책 합의 후 DB 마이그레이션 (테이블 drop)
6. `authenticated-content.tsx` / `sidebar.tsx` 조건 정리

### 리스크
- 기존 유저의 과거 기록이 사라짐 → 사전 공지 + export 기능 고려
- JobPosting 테이블은 레거시·AI 코치 양쪽에서 참조 → 삭제 금지
- `audio-storage` volume에 남는 orphan 파일 청소

---

## 기능 추가 (향후)

### 채용공고 등록 시 자동 기업 심층 정보 수집

- **현황**: 채용공고 등록 → LLM이 `rawText` 파싱 + 기본 기업 분석(`company_analysis`). Tavily 웹 검색 기반 "심층 분석"은 이전 버튼 방식으로 존재했으나 **제거됨** (별도 버튼/API 삭제, 2026-04-13).
- **목표**: 채용공고 등록 플로우에 **회사 검색 + 심층 정보 수집**을 자동 통합.
  - Tavily 또는 다른 검색 API 사용
  - 면접 후기 / 기출 트렌드 / 최근 뉴스 / 제품 / 문화 정보 수집 후 구조화
  - `company_analysis` 자체를 심층 수준으로 격상 (지금의 `deepResearch` 서브필드 방식이 아니라 통합)
- **관련 (제거된) 코드 참고**: git history `before 2026-04-13` — `do_deep_research` / `_search_company_info` / `deep_company_research` / `DEEP_COMPANY_ANALYSIS_PROMPT` / `POST /api/job-posting/{id}/research`. 되살릴 때 참고.
- **크레딧**: 유료화 이후에 과금 대상으로 편입 예정. 현재는 무료.
- **Fit Analysis 연동 가능성**: 수집된 `pastQuestionTrends` / `suggestedQuestions`를 `run_fit_analysis` 프롬프트에 함께 주입 → focus_topics가 실제 기출 기반으로 강화.
