# TODO — Learning Coach 하네스 적용

대상: `backend/app/agent/learning_coach/`

추천 순서: **트레이싱 → 테스트 → 평가** (관측 가능해야 디버깅·데이터셋 작성이 쉬움)

---

## 1. 트레이싱 하네스 (Observability) — 우선순위 高

노드/툴 호출 단위로 입출력·지연·에러를 기록·시각화.

- [ ] interview 쪽 `backend/app/agent/interview/tracing.py` 패턴 재사용
- [ ] `learning_coach/graph.py`의 plan / action / srs / goal_swap 노드에 트레이싱 데코레이터 부착
- [ ] LangSmith 또는 Langfuse 연동 (env: `LANGSMITH_API_KEY`)
- [ ] 세션 ID·user ID를 trace metadata로 전달
- [ ] 운영 환경에서 샘플링 비율 조정 가능하도록

**예상 비용**: 1일
**이득**: 프롬프트 튜닝·디버깅 속도. 운영 필수

---

## 2. 테스트 하네스 (Test Harness) — 우선순위 中

결정론적 로직을 단위/통합 테스트로 고정.

- [ ] `spaced_repetition.py` SRS 스케줄링 단위 테스트 확장 (현재 `tests/test_ns_srs.py`)
- [ ] `curriculum_seed.py` 시드 무결성 테스트
- [ ] `learning_memory.py` proficiency 갱신 로직 테스트
- [ ] LangGraph in-memory checkpointer로 graph 노드 전이 테스트
  - 목표 변경 감지 → curriculum swap
  - 세션 종료 → summary 생성
- [ ] pytest fixtures: 가짜 user / Subject / Topic / UserKnowledge

**예상 비용**: 1~2일
**이득**: 리팩터링 안전망

---

## 3. 평가 하네스 (Eval Harness) — 우선순위 低 (가장 가치 큼, 비용도 큼)

LLM 출력 품질을 데이터셋 + 자동 채점으로 측정.

- [ ] 골든 데이터셋 작성: "학습 상태(목표/proficiency/직전 메시지) → 기대 응답 특성"
  - 최소 30~50개 케이스
  - 카테고리: 신규 학습 / 복습 / 목표 변경 / 막힘 상황 / 종료
- [ ] 채점기 구현
  - 룰 기반: 주제 일치, 난이도 적정, 음성용 포맷 위반(코드블록/마크다운) 탐지
  - LLM-judge: 코칭 적절성·꼬리질문 품질
- [ ] CI 또는 로컬 스크립트로 회귀 측정 (`scripts/eval_learning_coach.py`)
- [ ] 프롬프트/모델 변경 시 점수 비교 리포트

**예상 비용**: 3~5일 (데이터셋 작성이 핵심)
**이득**: 프롬프트·모델 회귀 감지. 포트폴리오 가치 매우 큼
