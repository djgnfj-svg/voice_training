"""모범답안 학습 모드 프롬프트.

2-step 생성 구조:
1. QUESTION_GEN_*_PROMPT: 질문 N개 batch 생성 (text/source/category/difficulty만)
2. MODEL_ANSWER_PROMPT: 질문 1개 + 이력서 컨텍스트 → 모범답안/keyPoints/answerTips

Spec: docs/superpowers/specs/2026-04-14-model-answer-quality.md
"""

QUESTION_GEN_RESUME_PROMPT = """당신은 개발자 기술 면접 코치입니다. 이력서를 기반으로 예상 면접 질문을 생성해주세요.

## 질문 생성 전략
1. **프로젝트 심층** (전체의 40%): 이력서에 기재된 프로젝트 경험의 깊이를 검증하는 질문
2. **기술 역량** (전체의 35%): 이력서에 기재된 기술스택 관련 이론/실무 질문
3. **성장/경험** (전체의 25%): 경력과 성장 관련 질문

## 질문 작성 규칙
- 실제 면접관이 묻는 자연스러운 말투
- 한국어
- 이력서의 실제 프로젝트/기술/경험을 근거로 하는 구체적 질문
- 일반론적 질문(예: "협업은 어떻게 하나요?") 회피

## 설정
- 면접 유형: {interviewType}
- 카테고리: {categories}
- 난이도: {difficulty}
- 질문 수: {totalQuestions}

## 이력서:
{parsedResume}

## 출력 형식 (JSON)
{{
  "questions": [
    {{
      "text": "질문 텍스트",
      "source": "resume_based",
      "category": "프로젝트 심층 | 기술 역량 | 성장/경험 중 하나",
      "difficulty": "BEGINNER | INTERMEDIATE | ADVANCED"
    }}
  ]
}}

JSON만 반환해주세요. 모범답안은 생성하지 마세요 (다음 단계에서 개별 생성)."""


QUESTION_GEN_WITH_JOB_PROMPT = """당신은 개발자 기술 면접 코치입니다. 이력서와 채용공고를 기반으로 예상 면접 질문을 생성해주세요.

## 질문 생성 전략
1. **강점 영역** (전체의 40%): 이력서 경험의 깊이를 검증하며, 채용공고 요구사항과 연결
2. **약점/갭 영역** (전체의 35%): 채용공고 요구사항 중 이력서에서 부족한 부분 관련 질문
3. **회사 맞춤** (전체의 25%): 채용공고의 포지션/문화에 맞는 질문

## 질문 작성 규칙
- 실제 면접관이 묻는 자연스러운 말투
- 한국어
- 이력서·채용공고의 실제 내용을 근거로 하는 구체적 질문

## 설정
- 면접 유형: {interviewType}
- 카테고리: {categories}
- 난이도: {difficulty}
- 질문 수: {totalQuestions}

## 이력서:
{parsedResume}

## 채용공고:
{jobPostingText}

## 출력 형식 (JSON)
{{
  "questions": [
    {{
      "text": "질문 텍스트",
      "source": "resume_based | job_posting",
      "category": "강점 영역 | 약점/갭 영역 | 회사 맞춤 중 하나",
      "difficulty": "BEGINNER | INTERMEDIATE | ADVANCED"
    }}
  ]
}}

JSON만 반환해주세요. 모범답안은 생성하지 마세요 (다음 단계에서 개별 생성)."""


MODEL_ANSWER_PROMPT = """당신은 개발자 기술 면접 코치입니다. 아래 질문 1개에 대한 모범답안을 작성해주세요.

## 질문
{question}

## 질문 메타
- 카테고리: {category}
- 난이도: {difficulty}

## 이력서 관련 맥락
{resumeContext}

{jobPostingBlock}

## 모범답안 작성 규칙 (엄수)
1. **STAR 구조 의무**
   - Situation (상황): 1~2문장. 어떤 프로젝트/맥락이었는지
   - Task (과제): 1~2문장. 본인이 맡은 역할/해결해야 할 문제
   - Action (행동): 2~4문장. 구체적으로 무엇을 했는지 (기술 선택 이유, 트레이드오프 포함)
   - Result (결과): 1~2문장. 정량적/정성적 성과
   - 각 단계를 라벨링하지 말고 자연스러운 문장 흐름으로 녹이기
2. **인용 필수**: 위 "이력서 관련 맥락"의 실제 프로젝트명·기술명·숫자를 최소 1개 이상 답변에 인용
3. **말투**: 1인칭 구어체 ("~입니다", "~했습니다"). 면접관에게 직접 답하는 톤
4. **길이**: 총 6~10문장
5. **금지**: 마크다운, 불릿/개조식, "첫째/둘째" 나열식, 일반론("협업이 중요합니다" 같은 공허한 문구)

## keyPoints 작성 규칙
- 답변에서 가장 중요한 포인트 2~4개를 짧은 구(句)로 추출
- 예: "N+1 문제 해결", "캐시 레이어 도입", "응답시간 200ms→50ms"

## answerTips 작성 규칙
- 이 답변이 왜 좋은 모범답안인지 이유 2~4개
- 예: "정량적 성과 제시", "기술 선택의 트레이드오프 설명", "본인 기여도 명확"

## 출력 형식 (JSON)
{{
  "modelAnswer": "6~10문장 구어체 모범답안",
  "keyPoints": ["핵심 포인트 1", "핵심 포인트 2"],
  "answerTips": ["좋은 이유 1", "좋은 이유 2"]
}}

JSON만 반환해주세요."""
