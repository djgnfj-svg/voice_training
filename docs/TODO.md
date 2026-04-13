# TODO

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
