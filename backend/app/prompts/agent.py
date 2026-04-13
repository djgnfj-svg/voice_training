# backend/app/prompts/agent.py
from __future__ import annotations

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

<Fit Analysis>
{fit_analysis}
</Fit Analysis>

<누적 프로필 인사이트>
강점: {strengths}
약점: {weaknesses}
패턴: {patterns}
</누적 프로필 인사이트>

<현재까지 대화>
{conversation_history}
</현재까지 대화>

지시사항:
- 이번 질문은 Fit Analysis의 focus_topic "{current_focus_topic}"을 다루세요. focus_topic이 비어있으면 이력서 발췌의 첫 청크 주제를 다루세요.
- avoid_topics는 피하세요: {avoid_topics}
- 다음 JSON 형식으로만 반환:
{{
  "question": "면접 질문 본문",
  "targetArea": "다루는 영역 (예: 상태관리, 시스템 설계)",
  "difficulty": "easy|medium|hard"
}}
"""

INTERVIEWER_DECIDE_PROMPT = """지원자 컨텍스트:

<conversation_history>
{conversation_history}
</conversation_history>

<last_evaluation>
{last_evaluation}
</last_evaluation>

현재 상태:
- 진행된 질문 수: {question_count} / 최대 {max_questions}
- 현재 꼬리질문 라운드: {follow_up_round} (최대 2)

다음 행동을 결정하세요.

규칙:
- depth 점수 < 80이고 follow_up_round < 2이면 → "follow_up" (꼬리질문으로 깊이 파기)
- 질문 수가 최대에 도달했으면 → "end"
- 그 외 → "next_question" (새 주제로 이동)

반드시 다음 JSON만 반환하세요:
{{
  "action": "follow_up" | "next_question" | "end",
  "reason": "이 결정의 이유 (내부 메모)"
}}"""

INTERVIEWER_FOLLOWUP_PROMPT = """지원자 컨텍스트:

<conversation_history>
{conversation_history}
</conversation_history>

<last_evaluation>
{last_evaluation}
</last_evaluation>

이전 답변의 깊이가 부족합니다. 꼬리질문을 생성하세요.

깊이 사다리:
- 답변이 "what"(무엇)만 → "why"(왜) 또는 "how"(어떻게) 질문
- 답변이 "how"를 설명 → 트레이드오프, 대안, 한계점 질문
- 답변이 원리를 설명 → 실제 경험, 적용 사례 질문

반드시 다음 JSON만 반환하세요:
{{
  "question": "꼬리질문 (한국어)",
  "intent": "이 꼬리질문의 의도 (내부 메모)"
}}"""

EVALUATOR_PROMPT = """면접 질문:
{question}

지원자 답변:
{answer}

<user_profile>
강점: {strengths}
약점: {weaknesses}
</user_profile>

<conversation_history>
{conversation_history}
</conversation_history>

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

overallScore는 넣지 마세요 — 서버 코드가 가중 평균(clarity 0.30 + accuracy 0.25 + practicality 0.25 + depth 0.15 + completeness 0.05)으로 계산합니다.

반드시 다음 JSON만 반환하세요:
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
  "weaknessDetected": "새로 발견된 약점 (없으면 null)"
}}"""

REPORT_PROMPT = """다음 면접 세션의 전체 대화를 분석하여 종합 리포트를 생성하세요.

<conversation_history>
{conversation_history}
</conversation_history>

<user_profile>
강점: {strengths}
약점: {weaknesses}
</user_profile>

반드시 다음 JSON만 반환하세요:
{{
  "overallScore": 0,
  "summary": "전체 면접 종합 평가 (3-5문장)",
  "strengths": ["이번 면접에서 보여준 강점 1", "강점 2"],
  "improvements": ["개선이 필요한 부분 1", "부분 2"],
  "growthNotes": "이전 프로필 대비 성장한 부분 (프로필 데이터가 없으면 null)",
  "recommendations": ["다음 면접을 위한 구체적 추천 1", "추천 2"]
}}"""

FIT_ANALYSIS_PROMPT = """당신은 면접 설계 전문가입니다. 지원자의 이력서와 채용공고를 비교하여, 면접관이 깊이 파볼 만한 주제(focus_topics)와 다루지 말아야 할 주제(avoid_topics)를 추출하세요.

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
  "focus_topics": [
    {{"topic": "주제명", "why": "선택 이유 한 줄", "priority": "high|medium|low"}}
  ],
  "avoid_topics": ["피할 주제 1"]
}}

규칙:
- focus_topics 3~5개. JD의 핵심 요구사항 + 이력서 강점 영역을 우선
- gap 영역은 "기초 탐색" 차원에서 1개 이내만 포함
- avoid_topics는 0~3개. 이력서 수준 대비 너무 낮거나 본질에서 벗어난 주제
- 채용공고가 없으면 이력서 기반 강점/관심 영역으로만 작성
"""
