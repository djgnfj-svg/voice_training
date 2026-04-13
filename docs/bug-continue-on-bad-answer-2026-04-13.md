# 버그 #2 — 개떡같은 답변에도 면접이 이어지는 문제

**발견일**: 2026-04-13
**세션 실측**: `agent_interview_sessions.id = f04d1416`

## 증상

실질적 내용이 2~3단어 수준의 무의미/반복 답변인데도 평가 실행 + 꼬리질문 생성 + 면접 계속.

실측 (message_index=1):
- 원문 길이 209자 (반복 포함)
- 정규화/중복 제거 후 의미 토큰: "제일 어려웠던 프로젝트는 이게 왜 이렇게" 수준 (10 토큰 미만)
- evaluator가 실행되어 scores={clarity:30, accuracy:50, practicality:40, depth:20, completeness:30}, overallScore=36 출력
- decide_next가 꼬리질문 생성 ("Selenium을 사용하여... 결정적 이유는?") — 답변에 Selenium 얘기 사실상 없음

## 근본 원인

### 프론트
- `agent-interview-panel.tsx` `handleSubmit`: `normalizeTranscript(transcript)` 결과가 **빈 문자열만 아니면** 무조건 제출. 실질적 의미 검증 없음.
- 현재 가드: `if (!transcript) return;` — 공백 1글자여도 통과

### 백엔드
- `routers/agent_interview.py` `AnswerRequest.answer: str = Field(min_length=1, max_length=10000)` — 1자 이상이기만 하면 통과
- submit_answer에서 별도 의미 검증 없음
- evaluator_agent.evaluate_answer는 들어온 text로 그냥 LLM 호출

### 평가
- LLM이 반복 텍스트에서도 키워드("셀레니움", "타오바오")만 보고 accuracy/practicality를 후하게 채점

## 수정

### A. 프론트 handleSubmit에 "의미 있는 답변" 가드
정규화 후 아래 조건이면 제출 차단 + 인라인 안내:
- 정규화 후 글자 수 < 10
- 고유 토큰(공백 split 후 dedup) 수 < 3
- 정규화 결과가 필러워드만으로 구성

대신 "건너뛰기" 버튼은 그대로 열어두어 사용자가 명시적으로 skip 가능.

### B. 백엔드 submit_answer에도 동일 가드 (server-side defense)
프론트 우회/탈취 방어. 동일 조건 위배 시 400 응답 `{"error":"답변이 너무 짧습니다..."}`.

### C. evaluator 프롬프트 보강 (#3 수정과 맞물림)
반복 단어 나열/무의미 텍스트에는 모든 카테고리 20 이하로 평가하도록 규칙 추가.

## 영향 범위
- `frontend/src/components/agent-interview/agent-interview-panel.tsx`
- `backend/app/routers/agent_interview.py` (submit_answer)
- `backend/app/prompts/agent.py` (EVALUATOR_PROMPT — #3과 공동)
- 프론트 정규화 로직 개선(#1)과 합쳐지면 자연스럽게 필터링 효과 상승

## 검증
- 로컬 dev에서 짧은 답변("아 음") 시도 → 안내 뜨는지
- 반복 덩어리 붙여 넣어도 정규화 후 짧으면 차단되는지
