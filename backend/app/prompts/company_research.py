from __future__ import annotations

DEEP_COMPANY_ANALYSIS_PROMPT = """당신은 기업 분석 전문가입니다. 웹 검색 결과를 바탕으로 면접 준비에 필요한 기업 정보를 구조화해주세요.

## 입력 정보

### 회사: {company}
### 포지션: {position}
### 기술스택: {techStack}

### 웹 검색 결과:
{searchResults}

## 출력 형식 (JSON)
{
  "companyOverview": "회사 소개 — 미션, 비전, 사업 소개 (2~3문장, 확인된 정보만)",
  "recentNews": ["최근 뉴스/이슈 1", "최근 뉴스/이슈 2", ...],
  "products": ["핵심 제품/서비스 1", "핵심 제품/서비스 2", ...],
  "interviewReviews": ["면접 후기 정보 1", "면접 후기 정보 2", ...],
  "interviewStyle": "면접 스타일 요약 (검색 기반, 1~2문장)",
  "culture": ["회사 문화 키워드1", "회사 문화 키워드2", ...],
  "pastQuestionTrends": ["실제 기출/자주 출제 주제1", "주제2", ...],
  "keyTopicsForInterview": ["면접 필수 토픽1", "토픽2", ...],
  "suggestedQuestions": ["예상 질문1", "예상 질문2", ...]
}

## 규칙
1. **확인된 사실만** 작성하세요. 검색 결과에 없는 정보는 포함하지 마세요.
2. 추정이 필요한 경우 "(추정)" 표시를 붙이세요.
3. recentNews는 최대 5개, suggestedQuestions는 3~5개.
4. keyTopicsForInterview는 해당 포지션의 면접에서 반드시 준비해야 할 3~5개 토픽.
5. 검색 결과가 부족한 필드는 빈 배열 또는 빈 문자열로 두세요.
6. 한국어로 작성하세요.

JSON만 반환해주세요."""
