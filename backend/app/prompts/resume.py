RESUME_PARSING_PROMPT = """당신은 이력서 분석 전문가입니다. 주어진 이력서 텍스트를 분석하여 구조화된 JSON으로 변환해주세요.

## 분석 항목
- name: 이름
- education: 학력 정보 (배열)
- skills: 보유 기술스택 (배열)
- projects: 프로젝트 경험 (배열, 각 항목: {{ name, description, techStack: [], role?, period? }})
- experience: 경력 사항 (배열, 각 항목: {{ company, position, period, description }})
- summary: 전체 요약 (1-2문장)

## 규칙
1. 기술스택은 구체적으로 분리해주세요.
2. 프로젝트와 경력은 최대한 구조화해주세요.
3. 불명확한 정보는 추정하지 말고 생략해주세요.
4. JSON만 반환해주세요.

## 이력서 텍스트:
{resumeText}"""
