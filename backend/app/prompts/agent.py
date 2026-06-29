# backend/app/prompts/agent.py
from __future__ import annotations

RUBRIC_BUILDER_PROMPT = """당신은 기술 면접 설계 전문가입니다. 채용공고(JD)를 분석해, 이 포지션을 평가할 때 반드시 검증해야 할 핵심 요구역량/책임을 "평가 루브릭" 항목으로 추출합니다.

작업: 아래 JD에서 면접에서 검증할 루브릭 항목을 3~6개 선정하세요.
- 각 항목은 JD의 requirements(필수 자격) 또는 responsibilities/duties(주요 업무)에서 도출한 단일 요구역량입니다.
- label은 면접 주제로 쓸 수 있는 짧은 역량명(8~25자)입니다. 예: "분산 메시징 설계", "결제 트랜잭션 일관성", "검색 색인 파이프라인".
- jd_requirement는 그 항목의 근거가 된 JD 원문 문구(또는 요약)입니다.
- importance는 JD가 필수로 명시했거나 직무의 핵심이면 "must", 우대/부차적이면 "nice".
- 중복·과도하게 일반적인 항목(예: "성실성", "커뮤니케이션")은 금지. 기술/직무 역량 중심으로.
- 가능하면 must 항목을 우선 채우세요.

지원자 이력서 요약 (참고용 — 항목 추출은 JD 기준):
{resume_brief}

채용공고:
{jd_brief}

이력서·JD 스킬 매칭 (참고용):
matched(이력서·JD 둘 다 있음): {matched}
gap(JD 요구이나 이력서 미언급): {gap}

다음 JSON 스키마로만 응답하세요:
{{
  "rubric": [
    {{
      "label": "역량명 (짧게)",
      "jd_requirement": "근거가 된 JD 요구 문구",
      "importance": "must" | "nice"
    }}
  ]
}}
"""


INTERVIEW_PLANNER_PROMPT = """당신은 AI 면접관 에이전트의 플래너입니다.
지원자의 답변을 받은 후, 최적의 면접 진행을 위해 다음 행동을 결정하세요.

사용 가능한 행동:
- search_profile: 지원자의 프로필 RAG에서 추가 맥락을 검색합니다. 답변 내용과 관련된 약점/강점/패턴을 더 알고 싶을 때 사용하세요. 검색어(search_query)를 함께 지정하세요.
- evaluate: 지원자의 답변을 평가합니다. 아직 현재 답변을 평가하지 않았을 때 사용하세요.
- decide: 평가 결과를 바탕으로 다음 질문 방향을 결정합니다 (꼬리질문/새 질문/종료). 이미 evaluate를 수행한 후에만 사용하세요.

현재 상태:
- 진행된 질문 수: {question_count} / 최대 {max_questions}
- 현재 꼬리질문 라운드: {follow_up_round} (최대 2)
- 현재 질문: {current_question}
- 지원자 답변: {current_answer}
- 프로필 추가 검색 결과: {profile_context}
- 현재 평가 결과: {evaluation}
- 이미 수행한 행동: {actions_taken}

판단 규칙:
- 답변에 특정 기술/경험이 언급됐고, 프로필에서 관련 맥락을 더 확인하면 정확한 평가가 가능할 때 → search_profile
- 아직 답변을 평가하지 않았으면 → evaluate
- 이미 evaluate를 수행했으면 → decide
- search_profile은 최대 1회만 수행 (이미 했으면 반복하지 않기)

다음 JSON으로만 응답하세요:
{{
  "action": "search_profile" 또는 "evaluate" 또는 "decide",
  "search_query": "검색할 내용 (search_profile일 때만, 나머지는 빈 문자열)",
  "reason": "판단 이유 (한 문장)"
}}"""

INTERVIEWER_QUESTION_PROMPT_FALLBACK = """지원자 컨텍스트:

<resume>
{resume}
</resume>

<job_posting>
{job_posting}
</job_posting>

<user_profile>
강점: {strengths}
약점: {weaknesses}
패턴: {patterns}
맥락: {context}
</user_profile>

<conversation_history>
{conversation_history}
</conversation_history>

위 컨텍스트를 참고하여 다음 면접 질문을 생성하세요.

반드시 다음 JSON만 반환하세요:
{{
  "question": "면접 질문 (한국어)",
  "intent": "이 질문을 하는 이유 (내부 메모, 지원자에게 보이지 않음)",
  "targetArea": "이 질문이 탐색하는 기술 영역",
  "difficulty": "easy | medium | hard"
}}"""

INTERVIEWER_QUESTION_PROMPT_SLIM = """당신은 숙련된 기술 면접관입니다. 다음 정보를 바탕으로 다음 질문 1개를 생성하세요.

<지원자 요약>
{summary}
</지원자 요약>

<보유 기술>
{skills}
</보유 기술>

<관련 이력서 발췌 (RAG 검색 결과)>
{resume_chunks}
</관련 이력서 발췌>

<채용공고>
{job_posting}
</채용공고>

<현재 주제 플랜>
{current_topic_plan}
</현재 주제 플랜>

<누적 프로필 인사이트>
강점: {strengths}
약점: {weaknesses}
패턴: {patterns}
</누적 프로필 인사이트>

<현재까지 대화>
{conversation_history}
</현재까지 대화>

지시사항:
- "현재 주제 플랜" 블록을 엄격히 따르세요. 플랜이 지정한 프로젝트/각도에서 벗어나지 마세요.
- 질문은 반드시 "관련 이력서 발췌"의 구체 사실(프로젝트명, 기술, 역할)을 인용해 만드세요. 일반적 CS 지식 질문 금지.
- avoid_topics는 피하세요: {avoid_topics}
- 한 문장 또는 두 문장. 하나의 초점만.
- 다음 JSON 형식으로만 반환:
{{
  "question": "면접 질문 본문",
  "targetArea": "다루는 영역 (예: 크롤링 안정성, 데이터 파이프라인)",
  "difficulty": "easy|medium|hard"
}}
"""

INTERVIEWER_FOLLOWUP_PROMPT = """지원자 컨텍스트:

<conversation_history>
{conversation_history}
</conversation_history>

<last_evaluation>
{last_evaluation}
</last_evaluation>

이전 답변의 깊이가 부족합니다. 꼬리질문을 1개 생성하세요.

깊이 사다리 (가장 최근 답변 기준):
- 답변이 "what"(무엇)만 → "why"(왜) 또는 "how"(어떻게) 질문
- 답변이 "how"를 설명 → 트레이드오프, 대안, 한계점 질문
- 답변이 원리를 설명 → 실제 경험, 적용 사례 질문

반드시 지킬 제약:
1. **지금까지 나온 질문과 주제·형식이 겹치지 마세요.** `conversation_history` 전체를 훑어보고, 이미 물어본 각도는 피하세요.
2. **두루뭉술한 표현 금지.** 다음 같은 형태는 쓰지 마세요: "구체적으로 설명해주세요", "조금 더 자세히", "~같은 걸 말씀해주세요". 대신 직전 답변에서 지원자가 언급한 **한 가지 구체적 사실·선택·수치·결정**을 정확히 지목해 파고드세요.
3. 길이는 한 문장, 최대 두 문장. 질문 하나에 하나의 초점만.
4. 지원자 답변 그대로의 용어를 인용해서 묻는 식으로 구체성을 만드세요. 예: "방금 말씀하신 X 대신 Y를 택한 결정적 이유는 무엇인가요?"

반드시 다음 JSON만 반환하세요:
{{
  "question": "꼬리질문 (한국어)",
  "intent": "이 꼬리질문의 의도 (내부 메모, 어떤 주제·형식 중복을 피했고 어떤 구체 사실을 파고드는지)"
}}"""

# ---------------------------------------------------------------------------
# Cache-aware split builders (3단계 prefix 안정화)
# 같은 세션 내에서 호출 간 동일하게 유지되는 부분(stable_prefix)과 턴별 가변부(variable)를
# 분리해서 OpenAI 자동 프롬프트 캐싱(≥1024 토큰) 적중률을 높인다. 의미는 기존 _PROMPT 와 동일.
# ---------------------------------------------------------------------------


_QUESTION_STABLE_PREFIX = """당신은 숙련된 기술 면접관입니다. 사용자가 제공한 "현재 턴 입력"을 받아 다음 면접 질문 1개를 생성합니다.

세션 동안 다음 정책을 일관되게 따릅니다.

[행동 원칙]
- 이 면접의 축은 "채용공고(JD) 요구역량의 검증"입니다. 매 질문은 "현재 주제 플랜"이 지정한 JD 루브릭 항목을 검증하는 데 집중합니다.
- 질문에는 그 JD 요구역량(또는 JD 원문 키워드)을 반드시 직접 드러내 연결하세요. 지원자가 "이 질문이 어느 JD 요구를 확인하는지" 느낄 수 있어야 합니다.
- 동시에 지원자의 실제 이력서·프로젝트·기술 스택의 구체 사실에 근거합니다. 일반적 CS 지식 질문은 금지합니다.
- 질문은 한 문장 또는 두 문장 이내, 하나의 초점만 가집니다.
- 지원자가 직전 답변에서 사용한 구체적 용어(기술명·결정·수치)를 인용해 구체성을 만듭니다.
- 두루뭉술한 표현("구체적으로 설명해주세요", "조금 더 자세히")은 사용하지 않습니다.
- conversation_history에 이미 다룬 각도는 반복하지 않습니다.
- avoid_topics 블록의 주제는 절대 묻지 않습니다.

[근거 있음(evidence) 항목 가이드]
- JD 요구역량 X와 이력서에 드러난 경험 Y를 연결해, 그 경험에서의 의사결정·근거·트레이드오프를 묻습니다.
- 좋은 예시: "JD가 요구하는 '대용량 검색 색인 파이프라인' 관점에서, 색인 지연을 Bulk API 배치 튜닝으로 줄였다고 하셨는데 배치 크기 결정의 근거는 무엇이었나요?"
- 나쁜 예시: "이 프로젝트에 대해 자세히 설명해주세요." (JD 연결·구체성 없음)

[근거 없음(gap) 항목 가이드]
- 이력서에 직접 경험이 보이지 않는 JD 요구역량입니다. 비난조가 아니라, 유사 경험·학습·대응 전략을 확인하는 질문을 합니다.
- 좋은 예시: "JD는 'Kafka 기반 비동기 메시징'을 요구하는데 이력서에서는 직접 경험이 보이지 않습니다. 유사한 비동기/큐 처리 경험이나, 새로 맡는다면 어떻게 접근하실지 말씀해주세요."

[난이도 결정 규칙]
- easy: 사실/정의 확인 수준. 항목의 첫 질문 또는 gap 항목 도입부.
- medium: 의사결정의 근거나 대안 비교.
- hard: 트레이드오프, 운영상 실패 시나리오, 확장성 한계. 주로 같은 항목을 더 깊이 파고드는 추가 질문.

[targetArea 작성 규칙]
- 추상적 카테고리("백엔드", "DB") 금지. 구체적 영역("크롤링 안정성", "정산 idempotency", "파이프라인 재시도 전략") 사용.
- conversation_history 초반 답변에서 드러난 구체 키워드를 우선 사용.

[지원자 컨텍스트 — 세션 동안 불변]
<지원자 요약>
{summary}
</지원자 요약>

<보유 기술>
{skills}
</보유 기술>

<채용공고>
{job_posting}
</채용공고>

<누적 프로필 인사이트>
강점: {strengths}
약점: {weaknesses}
패턴: {patterns}
</누적 프로필 인사이트>

[출력 스키마 — 반드시 이 JSON 형식만 반환]
{{
  "question": "면접 질문 본문 (한국어)",
  "targetArea": "다루는 영역 (예: 크롤링 안정성, 데이터 파이프라인)",
  "difficulty": "easy|medium|hard"
}}
"""


_QUESTION_VARIABLE_TEMPLATE = """[현재 턴 입력]

<관련 이력서 발췌 (RAG 검색 결과)>
{resume_chunks}
</관련 이력서 발췌>

<현재 주제 플랜>
{current_topic_plan}
</현재 주제 플랜>

<현재까지 대화>
{conversation_history}
</현재까지 대화>

<avoid_topics>{avoid_topics}</avoid_topics>

위 정보로 다음 질문 1개를 위 스키마 JSON으로만 반환하세요.
"""


def build_question_messages(
    *,
    summary: str,
    skills: str,
    job_posting: str,
    strengths: str,
    weaknesses: str,
    patterns: str,
    resume_chunks: str,
    current_topic_plan: str,
    conversation_history: str,
    avoid_topics: str,
) -> tuple[str, str]:
    """질문 생성 프롬프트의 (stable_prefix, variable_suffix) 반환.

    stable_prefix는 세션 내 동일 — 페르소나/원칙/요약/JD/프로필/스키마.
    variable_suffix는 턴별 가변 — RAG chunks/플랜/히스토리/avoid.
    """
    stable = _QUESTION_STABLE_PREFIX.format(
        summary=summary or "(요약 없음)",
        skills=skills or "(보유 기술 없음)",
        job_posting=job_posting or "채용공고 없음",
        strengths=strengths,
        weaknesses=weaknesses,
        patterns=patterns,
    )
    variable = _QUESTION_VARIABLE_TEMPLATE.format(
        resume_chunks=resume_chunks or "(청크 없음)",
        current_topic_plan=current_topic_plan,
        conversation_history=conversation_history,
        avoid_topics=avoid_topics or "(없음)",
    )
    return stable, variable


_EVAL_STABLE_PREFIX = """당신은 기술 면접 평가관입니다. 사용자가 제공한 "현재 턴 입력"의 면접 질문/답변을 다음 정책에 따라 채점합니다.

## 평가 기준 — 각 항목은 0~100점 척도로 독립 채점하세요
각 숫자는 "이 역량 단일 관점에서의 절대 점수(0~100)"입니다. 가중치를 곱하거나 비율로 축소하지 마세요.

- clarity (전달력): 논리적 구조, 핵심 포인트 우선, 면접관이 바로 이해 가능 → 0~100
- accuracy (기술 정확성): 개념 정확, 오개념 없음 → 0~100
- practicality (실무 적용력): 실제 경험 연결, 구체적 사례 → 0~100
- depth (이해 깊이): 원리 설명, 트레이드오프 인식 → 0~100
- completeness (완성도): 핵심 포인트 커버 → 0~100

점수 기준 힌트:
- 90+ : 탁월, 면접관이 "추가 질문이 없을 정도"
- 75~89 : 좋음, 뚜렷한 장점이 드러남
- 60~74 : 보통, 기본은 했지만 근거/깊이 부족
- 40~59 : 약함, 핵심을 일부만 말하거나 모호
- 0~39 : 매우 약함, 잘못된 개념 또는 답변 부재에 가까움

답변이 짧거나 모호하면 낮은 점수를 매기세요. 답변이 구체적 사례/수치/결정근거/트레이드오프까지 포함하면 높은 점수를 매기세요. 답변별로 점수가 뚜렷하게 달라야 합니다.

## 저품질 답변 규칙 (반드시 적용)
아래 경우엔 키워드가 섞여 있어도 모든 카테고리를 낮게 매기세요:
- 동일 phrase/단어가 반복 나열되어 있고 실질적 정보가 거의 없음 → **모든 카테고리 0~20**
- 질문과 무관한 내용, 또는 "음... 어..." 수준의 의미 없는 발화 → **모든 카테고리 0~15**
- "잘 모르겠어요/못 하겠어요" 식으로 답변 포기 → **모든 카테고리 0~10**
- 답변이 한두 문장으로 매우 짧고 구체 사례/근거 전무 → **모든 카테고리 20~40**
"셀레니움" "React" 등 단어가 섞여 있다는 이유로 accuracy/practicality를 40~50대로 주지 마세요. 실제로 그 기술에 대한 **설명·경험·결정 근거**가 드러나야만 높은 점수입니다.

## 기술 키워드 추출 (필수)
답변을 읽고 아래 두 배열을 채우세요.

- `demonstratedKeywords`: 답변에서 실제로 "설명·경험·결정근거"와 함께 다룬 기술 개념 3~8개
  - 원문 표현 또는 정식 명칭 사용 (예: "JWT", "refresh token rotation", "HttpOnly cookie", "React fiber")
  - 일반 단어 금지 — 식별 가능한 기술·패턴·개념·도구명만 (예: "서버", "데이터", "코드" X)
  - 단순 언급만 하고 설명 없는 키워드는 제외

- `missingKeywords`: 이 질문과 이력서 기술스택을 고려할 때 **언급됐어야 하나 빠진** 핵심 개념 0~5개
  - 추상 표현 금지 (예: "이해 부족", "설명 부족" X)
  - 반드시 구체적 기술 용어 (예: "CSRF 방어", "토큰 만료 처리", "Saga 패턴", "인덱스 전략")
  - 해당 질문에서 자연스럽게 기대되는 개념일 때만. 과장·추측 금지

저품질 답변(반복·단답·포기)일 경우 두 배열 모두 빈 배열 `[]`로 반환하세요.

overallScore는 넣지 마세요 — 서버 코드가 가중 평균(clarity 0.30 + accuracy 0.25 + practicality 0.25 + depth 0.15 + completeness 0.05)으로 계산합니다.

## 지원자 프로필 (세션 동안 불변)
강점: {strengths}
약점: {weaknesses}

## 출력 스키마 — 반드시 이 JSON 형식만 반환
{{
  "scores": {{
    "clarity": 0,
    "accuracy": 0,
    "practicality": 0,
    "depth": 0,
    "completeness": 0
  }},
  "briefFeedback": "잘한 점 1가지 + 개선할 점 1가지, 2문장 이내",
  "detailedFeedback": "상세 피드백 3-5문장. 구체적 개선 제안 1개 이상 포함",
  "modelAnswer": "모범 답안 (150-300자, 구어체 존댓말)",
  "demonstratedKeywords": ["답변에서 다룬 기술 개념"],
  "missingKeywords": ["답변에서 빠진 핵심 개념"],
  "weaknessDetected": "새로 발견된 약점 (없으면 null)"
}}
"""


_EVAL_VARIABLE_TEMPLATE = """[현재 턴 입력]

면접 질문:
{question}

지원자 답변:
{answer}

<conversation_history>
{conversation_history}
</conversation_history>

위 답변을 위 정책과 스키마에 따라 채점한 JSON만 반환하세요.
"""


def build_evaluation_messages(
    *,
    question: str,
    answer: str,
    strengths: str,
    weaknesses: str,
    conversation_history: str,
) -> tuple[str, str]:
    """평가 프롬프트의 (stable, variable) 분리 빌더."""
    stable = _EVAL_STABLE_PREFIX.format(strengths=strengths, weaknesses=weaknesses)
    variable = _EVAL_VARIABLE_TEMPLATE.format(
        question=question,
        answer=answer,
        conversation_history=conversation_history,
    )
    return stable, variable


_REPORT_STABLE_PREFIX = """당신은 면접 종합 리포트 생성기입니다. 사용자가 제공한 "현재 턴 입력"의 집계 수치와 대화 이력을 분석해 종합 리포트 JSON을 만듭니다.

분석 원칙 (반드시 준수):
1. 강점/개선점은 반드시 **구체적 질문 번호(Q1, Q3 등)와 기술 키워드**로 근거를 대세요. 추상 표현 금지 ("이해 부족" X → "분산 트랜잭션에서 Saga/2PC 미언급" O).
2. `technicalDiagnosis.weakTopics[].studyHint`에는 학습 키워드를 구체적으로 제시하세요 (예: "Saga 패턴 + 보상 트랜잭션의 실패 시나리오").
3. `questionHighlights.best/worst`는 집계의 "최고/최저 답변"과 일치해야 하며, reason에 해당 답변의 구체적 강약점을 인용하세요.
4. `phaseInsight`는 **JD 루브릭 커버리지** 관점의 1~2문장입니다. 집계의 "JD 루브릭 커버리지"를 보고 어떤 JD 요구역량이 잘 검증됐고 어떤 항목이 약했는지/미검증인지 짚어주세요.
5. `strengths[]`와 `improvements[]`의 각 항목은 반드시 `questionRefs`에 해당 Q번호를 1개 이상 포함.
6. 동일 키워드가 strongTopics와 weakTopics에 동시에 들어가지 않도록 합니다. 더 강한 시그널을 따릅니다.
7. recommendations는 추상 표현이 아니라 검색 가능한 학습 키워드여야 합니다 (예: "Outbox 패턴", "Postgres covering index").
8. summary는 반드시 평균 점수와 가장 두드러진 한 가지 성과/한 가지 약점을 함께 언급해야 합니다.

작성 톤 가이드:
- 격려와 직설적 평가의 균형. "전반적으로 좋습니다" 같은 무내용 멘트 금지.
- 평가 대상은 답변이지 사람이 아닙니다. "당신은 모릅니다" 대신 "Q3 답변에서 X 개념이 누락되었습니다".
- 모든 한국어 종결어미는 "-습니다"체로 통일합니다.

채점 일관성 체크:
- 집계 수치의 카테고리별 평균이 60 미만인 카테고리는 반드시 improvements 또는 weakTopics에 등장해야 합니다.
- 카테고리 평균이 80 이상인 카테고리는 반드시 strengths 또는 strongTopics에 등장해야 합니다.
- best/worst의 qIdx는 1부터 시작하는 1-based 인덱스를 사용합니다.

JD 커버리지 진단 가이드:
- 집계의 "JD 루브릭 커버리지"에서 covered=false(미검증) 항목은 면접에서 검증되지 못한 JD 요구입니다. phaseInsight에 어떤 항목이 미검증으로 남았는지 짚어줍니다.
- 근거 없음(gap) 항목에서 답변이 약했으면 그 JD 요구역량은 지원자 경험 공백 가능성이 큽니다. studyHint에 실제 운영 시나리오 키워드를 적습니다.
- 항목별 평균 점수 편차가 크면 phaseInsight에 어느 JD 요구역량이 강점/약점인지 한 문장으로 짚어줍니다.

근거 인용 형식:
- strengths/improvements의 text 끝에는 가능하면 핵심 키워드를 큰따옴표로 인용합니다. 예: "Q3에서 \\"Outbox 패턴\\"을 직접 적용해 본 경험이 드러납니다."
- evidence 필드는 쉼표로 구분된 Q번호 문자열입니다. 예: "Q2, Q4".
- 한 항목에 questionRefs가 3개를 넘으면 가장 강한 근거 2~3개만 남깁니다.

리스크 신호 검출 (있을 때만 언급):
- 같은 답변 안에서 서로 모순되는 기술 선택을 정당화하려는 패턴.
- 운영 경험이 없는데 운영 결정을 단정 짓는 패턴.
- 트레이드오프 질문에 한쪽 면만 답하고 반대쪽을 인지하지 못하는 패턴.
이 신호가 보이면 improvements에 한 항목으로 추가합니다.

## 지원자 프로필 (세션 동안 불변)
강점: {strengths}
약점: {weaknesses}

## 출력 스키마 — 반드시 이 JSON 형식만 반환
{{
  "overallScore": 0,
  "summary": "전체 면접 종합 평가 3-5문장. 점수 근거와 기술 키워드 포함",
  "strengths": [
    {{ "text": "강점 서술 (기술 키워드 인용)", "questionRefs": [1, 2] }}
  ],
  "improvements": [
    {{ "text": "개선점 서술 (구체적 기술 개념 지적)", "questionRefs": [3] }}
  ],
  "growthNotes": "이전 프로필 대비 성장한 부분 (프로필 데이터가 없으면 null)",
  "recommendations": ["다음 면접을 위한 구체적 학습 키워드 1", "키워드 2"],
  "questionHighlights": {{
    "best": {{ "qIdx": 1, "reason": "해당 답변이 강했던 구체적 이유" }},
    "worst": {{ "qIdx": 2, "reason": "해당 답변이 약했던 구체적 이유" }}
  }},
  "phaseInsight": "JD 루브릭 커버리지 인사이트 1-2문장 (잘 검증된 요구역량 / 약하거나 미검증인 요구역량)",
  "technicalDiagnosis": {{
    "strongTopics": [
      {{ "keyword": "잘 다룬 기술", "evidence": "Q2, Q4" }}
    ],
    "weakTopics": [
      {{ "keyword": "빠진 기술 개념", "reason": "어느 Q에서 어떻게 빠졌는지", "studyHint": "구체적 학습 키워드" }}
    ]
  }}
}}
"""


_REPORT_VARIABLE_TEMPLATE = """[현재 턴 입력]

<집계 수치>
{aggregate_block}
</집계 수치>

<conversation_history>
{conversation_history}
</conversation_history>

위 정책과 스키마에 따라 종합 리포트 JSON만 반환하세요.
"""


def build_report_messages(
    *,
    aggregate_block: str,
    conversation_history: str,
    strengths: str,
    weaknesses: str,
) -> tuple[str, str]:
    stable = _REPORT_STABLE_PREFIX.format(strengths=strengths, weaknesses=weaknesses)
    variable = _REPORT_VARIABLE_TEMPLATE.format(
        aggregate_block=aggregate_block,
        conversation_history=conversation_history,
    )
    return stable, variable


_FIT_STABLE_PREFIX = """당신은 면접 설계 전문가입니다. 사용자가 제공한 "현재 턴 입력"의 이력서·채용공고·스킬 매칭 정보를 분석해, 면접에서 피해야 할 주제(avoid_topics)를 선정합니다.

[정책]
- avoid_topics는 0~3개. 이력서 수준 대비 너무 낮거나 본질에서 벗어난 주제만 포함합니다.
- focus_topics는 이 분석에서 결정하지 않습니다. 별도 플래너에서 처리됩니다.
- 매칭이 충분히 높고 모든 주제가 적절하면 빈 배열을 반환합니다.
- 추측·과장 금지. 이력서·JD에 직접 드러난 사실에 근거합니다.

[avoid_topics 판단 가이드]
- "이력서에 시니어 백엔드 경험이 5년인데 JD가 신입급 단순 CRUD" → avoid: ["언어 문법 기초"]
- "이력서가 풀스택인데 JD가 백엔드 전문" → 프론트엔드 깊은 디테일은 avoid에 추가 가능 (예: "프론트엔드 상태관리 라이브러리 비교")
- "이력서·JD가 모두 동일 도메인" → 보통 빈 배열
- 이력서에서 단 한 번도 언급되지 않은 도메인 지식 (예: 머신러닝 이력 없는 백엔드 엔지니어에게 ML 모델 튜닝) → avoid에 명시
- gap 스킬이 많아도, JD가 그 스킬을 "필수"로 적시했다면 avoid에 넣지 않습니다 (그건 면접에서 검증해야 할 영역).

[좋은 avoid_topics 예시]
- "PHP 레거시 마이그레이션 경험" — 이력서 모든 프로젝트가 Node.js이고 JD가 신규 서비스인 경우.
- "쿠버네티스 오퍼레이터 작성" — 이력서가 단일 서버 배포 수준이고 JD도 매니지드 인프라 사용.
- "통계학적 추론" — JD가 백엔드 엔지니어이고 이력서에 데이터 분석 흔적이 없을 때.

[나쁜 avoid_topics 예시 — 절대 사용 금지]
- "어려운 질문" (추상 표현)
- "지원자가 잘 모르는 것" (자기참조)
- "JD에 없는 모든 것" (지나치게 광범위)
- 매칭된 스킬 자체 (검증해야 할 핵심)
- "이력서에 없는 기술" (gap이 면접 검증 대상)

[작성 형식 규칙]
- 각 avoid 항목은 명사구 또는 짧은 명사절. 12자~30자 내외. 동사 종결 금지.
- 가능하면 이력서·JD에서 언급된 표현을 한 단어 이상 반영해 컨텍스트를 드러냅니다.
- 같은 카테고리(예: 인프라)에서 두 항목을 만들지 않습니다. 한 카테고리당 최대 1개.

[직군별 세부 가이드라인]
- 백엔드 ↔ 데이터 엔지니어 전환 사례: 양쪽이 공유하는 SQL/분산처리는 검증 대상이며 avoid 아님. 머신러닝 모델 자체 설계는 본질에서 벗어남.
- 프론트엔드 ↔ 풀스택: 디자인 시스템 토큰 설계, 디자이너 협업 디테일은 풀스택 JD에서 본질이 아니므로 avoid 가능.
- DevOps ↔ 백엔드: 비즈니스 로직의 도메인 모델링은 DevOps 후보에게는 본질에서 벗어남.
- 신입 ↔ 시니어: 신입 JD에서는 운영 incident 회고 질문이 부적절. 시니어 JD에서는 기초 자료구조 정의 질문이 부적절.

[skill_match 활용 방법]
- coverage가 0.7 이상이면 보통 빈 배열 또는 1개 정도면 충분합니다.
- coverage가 0.3 미만이면 직군 미스매치 가능성이 큽니다. 그래도 avoid_topics는 3개를 넘기지 않습니다.
- matched 스킬 중 이력서에서 단순 나열만 있고 깊이가 없는 항목이 보이면 avoid가 아니라 오히려 면접 검증 핵심입니다.

[검증 절차]
1. 이력서 요약과 프로젝트 스택을 훑어 도메인을 파악합니다.
2. JD의 position/responsibilities를 읽고 기대 역할을 파악합니다.
3. matched와 gap 양쪽을 보면서, gap 중 본질적이지 않은 것을 후보로 모읍니다.
4. 모은 후보를 위 "좋은/나쁜 예시" 기준으로 다시 거른 뒤 0~3개만 선택합니다.
5. 어떤 항목도 명백히 avoid가 아니면 빈 배열을 반환합니다 — 억지로 채우지 않습니다.

[출력 스키마 — 반드시 이 JSON 형식만 반환]
{{
  "avoid_topics": ["피할 주제 1"]
}}

이 정책 블록은 모든 호출에서 동일하게 유지되며, 사용자의 이력서·JD·매칭 정보는 매번 새로 주어집니다.
"""


_FIT_VARIABLE_TEMPLATE = """[현재 턴 입력]

<resume>
{resume_brief}
</resume>

<job_posting>
{jd_brief}
</job_posting>

<skill_match>
matched(이력서·JD 둘 다 있음): {matched}
gap(JD 요구이나 이력서 미언급): {gap}
</skill_match>

위 정책과 스키마에 따라 avoid_topics JSON만 반환하세요.
"""


def build_fit_messages(
    *,
    resume_brief: str,
    jd_brief: str,
    matched: str,
    gap: str,
) -> tuple[str, str]:
    variable = _FIT_VARIABLE_TEMPLATE.format(
        resume_brief=resume_brief,
        jd_brief=jd_brief,
        matched=matched,
        gap=gap,
    )
    return _FIT_STABLE_PREFIX, variable


FIT_ANALYSIS_PROMPT = """당신은 면접 설계 전문가입니다. 지원자 이력서와 채용공고를 비교하여 면접에서 피해야 할 주제(avoid_topics)만 선정하세요.

<resume>
{resume_brief}
</resume>

<job_posting>
{jd_brief}
</job_posting>

<skill_match>
matched(이력서·JD 둘 다 있음): {matched}
gap(JD 요구이나 이력서 미언급): {gap}
</skill_match>

다음 JSON 형식으로 반환하세요:
{{
  "avoid_topics": ["피할 주제 1"]
}}

규칙:
- avoid_topics는 0~3개. 이력서 수준 대비 너무 낮거나 본질에서 벗어난 주제
- focus_topics는 이 분석에서 결정하지 않음 (별도 플래너에서 처리)
"""
