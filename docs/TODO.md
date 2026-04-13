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
