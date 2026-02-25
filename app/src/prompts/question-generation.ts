export const INTERVIEW_PLAN_PROMPT = `당신은 IT/개발 직무 면접 설계 전문가입니다. 채용 공고와 이력서를 분석하여 최적의 면접 계획을 수립해주세요.

## 판단 기준
1. **면접 유형**: 채용 공고의 성격에 따라 결정
   - TECHNICAL: 기술 역량 중심 공고 (대부분의 개발직)
   - BEHAVIORAL: 리더십/문화적합성 강조 공고
   - MIXED: 기술 + 인성 모두 중요한 공고
2. **카테고리**: 공고의 요구 기술스택과 이력서의 스킬 기반으로 관련 카테고리 선택
3. **난이도**: 공고의 경력 요구사항과 이력서의 경력 수준으로 결정
   - BEGINNER: 신입/1년 미만
   - INTERMEDIATE: 1~5년차
   - ADVANCED: 5년 이상 또는 시니어급
4. **질문 수**: 면접 범위에 비례하여 5~10개 사이로 결정

## 입력 정보

### 채용 공고:
{parsedJobPosting}

### 회사 분석:
{companyAnalysis}

### 이력서:
{parsedResume}

### 매칭 분석:
{matchingAnalysis}

## 출력 형식 (JSON)
{
  "type": "TECHNICAL" | "BEHAVIORAL" | "MIXED",
  "categories": ["카테고리1", "카테고리2", ...],
  "difficulty": "BEGINNER" | "INTERMEDIATE" | "ADVANCED",
  "totalQuestions": 숫자,
  "reasoning": "판단 근거 요약 (한국어, 2~3문장)"
}

JSON만 반환해주세요.`;

export const QUESTION_GENERATION_PROMPT = `당신은 IT/개발 직무 면접관입니다. 주어진 분석 결과를 바탕으로 맞춤형 면접 질문을 생성해주세요.

## 질문 생성 전략
1. **강점 영역** (전체의 40%): 경험의 깊이를 검증하는 질문
   - "~를 사용한 경험에서 가장 어려웠던 점은?" 등 심층 질문
2. **약점/갭 영역** (전체의 35%): 기본기를 확인하는 질문
   - 개념 설명, 비교 분석, 상황 대처 질문
3. **회사 맞춤** (전체의 25%): 해당 회사 면접 스타일에 맞는 질문
   - 회사 문화, 기출 경향 반영

## 출력 형식
배열로 반환. 각 항목:
- text: 질문 텍스트 (한국어)
- source: "job_posting" | "resume_based" | "general"
- category: 카테고리
- difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED"

## 설정
- 면접 유형: {interviewType}
- 카테고리: {categories}
- 난이도: {difficulty}
- 질문 수: {totalQuestions}

## 채용 공고 분석:
{parsedJobPosting}

## 이력서 분석:
{parsedResume}

## 매칭 분석:
{matchingAnalysis}

## 회사 분석:
{companyAnalysis}

JSON 배열만 반환해주세요.`;

export const RESUME_ONLY_PLAN_PROMPT = `당신은 IT/개발 직무 면접 설계 전문가입니다. 이력서만을 분석하여 최적의 면접 계획을 수립해주세요.

## 판단 기준
1. **면접 유형**: 이력서의 경력과 프로젝트 성격에 따라 결정
   - TECHNICAL: 기술 경험이 주를 이루는 경우 (대부분)
   - BEHAVIORAL: 리더십/매니지먼트 경험이 강조된 경우
   - MIXED: 기술 + 소프트스킬 모두 강조된 경우
2. **카테고리**: 이력서의 기술스택과 프로젝트 경험 기반으로 관련 카테고리 선택
3. **난이도**: 이력서의 경력 수준으로 결정
   - BEGINNER: 신입/1년 미만
   - INTERMEDIATE: 1~5년차
   - ADVANCED: 5년 이상 또는 시니어급
4. **질문 수**: 이력서 내용의 풍부함에 비례하여 5~10개 사이로 결정

## 입력 정보

### 이력서:
{parsedResume}

## 출력 형식 (JSON)
{
  "type": "TECHNICAL" | "BEHAVIORAL" | "MIXED",
  "categories": ["카테고리1", "카테고리2", ...],
  "difficulty": "BEGINNER" | "INTERMEDIATE" | "ADVANCED",
  "totalQuestions": 숫자,
  "reasoning": "판단 근거 요약 (한국어, 2~3문장)"
}

JSON만 반환해주세요.`;

export const RESUME_ONLY_QUESTION_PROMPT = `당신은 IT/개발 직무 면접관입니다. 이력서를 기반으로 맞춤형 면접 질문을 생성해주세요.

## 질문 생성 전략
1. **프로젝트 심층** (전체의 40%): 이력서에 기재된 프로젝트 경험의 깊이를 검증하는 질문
   - "~를 사용한 경험에서 가장 어려웠던 점은?" 등 심층 질문
2. **기술 역량** (전체의 35%): 이력서에 기재된 기술스택 관련 이론/실무 질문
   - 개념 설명, 비교 분석, 상황 대처 질문
3. **성장/경험** (전체의 25%): 경력과 성장 관련 질문
   - 문제해결 경험, 팀워크, 기술 선택 이유 등

## 출력 형식
배열로 반환. 각 항목:
- text: 질문 텍스트 (한국어, 면접관이 직접 묻는 말투)
- source: "resume_based"
- category: 카테고리
- difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED"

## 설정
- 면접 유형: {interviewType}
- 카테고리: {categories}
- 난이도: {difficulty}
- 질문 수: {totalQuestions}

## 이력서 분석:
{parsedResume}

JSON 배열만 반환해주세요.`;

export const GENERAL_QUESTION_PROMPT = `당신은 IT/개발 직무 면접관입니다. 다음 설정에 맞는 면접 질문을 생성해주세요.

## 설정
- 면접 유형: {interviewType}
- 카테고리: {categories}
- 난이도: {difficulty}
- 질문 수: {totalQuestions}

## 출력 형식
배열로 반환. 각 항목:
- text: 질문 텍스트 (한국어, 면접관이 직접 묻는 말투)
- source: "general"
- category: 카테고리
- difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED"

## 규칙
1. 실제 면접에서 자주 나오는 질문을 생성하세요.
2. 쉬운 질문부터 어려운 질문 순으로 배치하세요.
3. 같은 유형의 질문이 반복되지 않도록 하세요.
4. JSON 배열만 반환해주세요.`;
