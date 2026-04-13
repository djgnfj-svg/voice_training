# TODO

## UX 개선 (면접 연습)

### 면접 중 침묵 허용 늘리기 (답변 서두름 완화)
- **현황 (2026-04-13 테스트 피드백)**: 면접 진행 중 답변 시간이 너무 짧게 강제되거나 침묵 감지가 과민해서 **"급해서 연습이 안 됨"**.
- **목표**: 사용자가 여유 있게 생각하고 답변할 수 있게 침묵/대기 정책을 완화.
- **조사 필요**:
  - `hooks/useSpeechAnalytics.ts` — `silenceSec` / `silenceRatio` 임계치가 UI에서 어떻게 압박으로 작용하는지
  - `hooks/useAudioRecorder.ts` — 자동 종료 타이머 존재 여부
  - 프론트엔드 UI에서 "답변 대기" 관련 카운트다운/시각적 압박 요소
  - SSE 타임아웃 / 백엔드 세션 유효시간
- **후보 변경**:
  - 자동 종료 타이머 있으면 느슨하게 (예: 무음 10s → 30s) or 완전 제거
  - "다음 질문으로" 버튼을 명시적으로 유저가 누르게
  - 실시간 필러워드/속도 피드백은 유지하되 시각적 카운트다운은 제거

### 평가 시스템 정상 작동 검증 (점수/역량별/개선점 의심)
- **현황 (2026-04-13 테스트 피드백)**: 면접 리포트가
  - **총점 70점 고정**으로 보임 (하드코딩 혹은 평가 경로 미작동 의심)
  - **역량별 평균점수 이상** (계산 버그 or 집계 누락)
  - **개선점(improvements) 항목 비어있음** (누락 or LLM 응답 파싱 실패)
- **조사 필요 (우선순위 높음 — 회귀 가능성)**:
  - `backend/app/agent/evaluator_agent.py` — `evaluate_answer`, `generate_report` 실제 LLM 호출 결과가 DB에 어떻게 저장되는지
  - `backend/app/prompts/evaluation.py` — 각 카테고리별 rubric 프롬프트와 반환 스키마
  - 리포트 생성 시 각 답변 `overall_score`를 평균 내는 로직 (agent_interview.py end 핸들러 근처)
  - AgentInterviewSession.overall_score 실제 값 + reportData JSONB 샘플 덤프
  - 프론트 `agent-interview` 리포트 컴포넌트 — 표시 로직에서 실 데이터 vs 기본값 확인
- **실증 체크**:
  - DB에서 최근 완료된 agent_interview_sessions 1건 reportData / overall_score 직접 출력
  - 각 answer 메시지의 evaluation JSONB 분포 확인
- **가능성 높은 원인**:
  - evaluator LLM 응답이 JSON 파싱 실패 → 코드에서 fallback 70 하드코딩?
  - 평균 계산 시 0건 나누기 or wrong key
  - 개선점 필드명 mismatch (`improvements` vs `improvement` vs `improvementPoints`)

### 꼬리질문 중복/애매함 개선
- **현황 (2026-04-13 테스트 피드백)**: 꼬리질문이 **너무 자주 나오고 + 비슷한 주제 반복 + 질문 자체가 애매**("~같은 거 물어봐" 식 두루뭉술한 표현).
- **관련 코드**: `backend/app/agent/interviewer_agent.py` `generate_followup` + `backend/app/prompts/agent.py` `INTERVIEWER_FOLLOWUP_PROMPT` + `backend/app/agent/nodes.py` `decide_next` 분기 조건.
- **조사 필요**:
  - `decide_next` 에서 follow_up 선택 조건 (depth < 80 기준이 너무 느슨한지)
  - `FOLLOWUP_EVALUATION_PROMPT` depth 점수 분포 실측
  - 꼬리질문 생성 프롬프트에 "이전 질문들과 주제 겹치지 마라" 제약 부재
- **후보 변경**:
  - 꼬리질문 최대 횟수를 현재 2 → 1로 줄이기 (or 연속 follow_up 허용 안 함)
  - `generate_followup` 프롬프트에 직전 질문들 나열 + "주제·형식 중복 금지" 명시
  - 모호한 질문 방지 — `"구체적으로 설명해주세요"` 같은 두루뭉술 표현을 프롬프트 규칙으로 차단, **하나의 구체 사실/결정을 찍어서 묻도록** 강제
  - depth 임계치 상향 (예: 80 → 70) — 어지간하면 next_question으로 넘어가게

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
