from __future__ import annotations

JOB_POSTING_ANALYSIS_PROMPT = """당신은 IT/개발 채용 공고 분석 전문가입니다. 주어진 채용 공고 텍스트를 분석하여 구조화된 JSON으로 변환해주세요.

## 분석 항목
- company: 회사명
- position: 포지션/직무명
- requirements: 필수 자격요건 (배열)
- preferred: 우대사항 (배열)
- techStack: 요구 기술스택 (배열)
- duties: 직무 내용/주요 업무 (배열)
- teamInfo: 팀/조직 정보 (문자열, 없으면 빈 문자열)
- culture: 회사 문화/인재상 키워드 (배열)

## 규칙
1. 공고에 명시되지 않은 항목은 빈 배열 또는 빈 문자열로 남겨주세요.
2. 기술스택은 구체적인 기술명으로 분리해주세요 (예: "React, TypeScript" → ["React", "TypeScript"])
3. 한국어로 응답해주세요.
4. JSON만 반환해주세요.

## 채용 공고:
{jobPostingText}"""

COMPANY_ANALYSIS_PROMPT = """당신은 IT 기업 면접 분석 전문가입니다. 주어진 회사명과 포지션 정보를 바탕으로 해당 회사의 면접 특성을 분석해주세요.

## 분석 항목
- interviewStyle: 면접 스타일 설명 (예: "코딩 테스트 중심", "시스템 설계 면접 포함" 등)
- culture: 회사 문화 키워드 (배열)
- pastQuestionTrends: 과거 기출 경향/자주 나오는 주제 (배열)

## 회사: {company}
## 포지션: {position}
## 기술스택: {techStack}

JSON만 반환해주세요."""

JOB_POSTING_IMAGE_EXTRACT_PROMPT = """첨부 이미지에서 채용공고 텍스트만 그대로 추출해줘.

## 규칙
- 회사명, 포지션, 자격요건, 우대사항, 기술스택, 복리후생, 근무지 등 본문 텍스트만 추출
- 네비게이션, 버튼, 광고, 아이콘, 장식 텍스트는 제외
- 원본 줄바꿈과 목록 구조는 최대한 유지
- 추출 결과 외에 어떤 설명/머리말/마크다운 코드블록도 출력하지 마라
- 이미지에 읽을 만한 텍스트가 거의 없으면 빈 문자열만 출력
"""
