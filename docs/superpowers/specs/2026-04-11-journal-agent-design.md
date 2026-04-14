# 하루의 정리 — 에이전트화 설계

## 목표

현재 `route_and_respond → extract` 고정 파이프라인을 **planner 루프 기반 에이전트**로 전환.
에이전트가 매 턴마다 다음 행동을 스스로 결정하고, 필요하면 도구(RAG 검색, 모드 전환)를 선택적으로 호출한 뒤 다시 판단하는 루프 구조.

## 핵심 기능

- **A. 대화 주도 전략**: LLM이 매 턴 사용자 답변을 평가하고 전략(deepen/new_topic/recall_past/empathize) 결정
- **B. 과거 맥락 능동 참조**: 최근 30일 RAG 검색으로 "지난번에 ~했다고 했는데" 식 대화

## 아키텍처: Planner 루프

```
사용자 메시지 → plan ─┬→ search_past (RAG 30일 검색) → plan
                      ├→ classify_mode (모드 전환) → plan
                      └→ respond (응답 생성) → extract → 끝
```

- plan이 라우터 허브 역할
- 행동 실행 후 결과가 plan으로 돌아옴
- 충분한 정보가 모이면 respond 선택 → 루프 종료
- 최대 3회 행동 후 강제 respond (무한 루프 방지)

## Planner 행동(actions)

| action | 언제 | 결과 |
|--------|------|------|
| `search_past` | 과거 맥락 필요 판단 | RAG 30일 검색 → state.past_context 저장 → plan 재진입 |
| `classify_mode` | 감정 변화 감지, 모드 전환 필요 | journal/counseling 분류 → plan 재진입 |
| `respond` | 충분한 정보 수집 완료 | 전략 기반 응답 생성 → extract → 루프 종료 |

## 전략(strategy) — respond 선택 시

| strategy | 의미 |
|----------|------|
| `deepen` | 사용자가 짧게 답함 → 더 구체적으로 파고들기 |
| `new_topic` | 충분히 이야기함 → 새 주제로 자연스럽게 전환 |
| `recall_past` | 과거 맥락 연결점 발견 → 과거 참조하며 응답 |
| `empathize` | 감정 표현 감지 → 공감 우선 응답 |

## JournalState 확장

기존 필드 유지 + 3개 추가:

```python
past_context: list[dict]   # RAG 30일 검색 결과
strategy: str              # planner 결정 전략
loop_count: int            # 현재 루프 횟수
```

## 노드 구성

| 노드 | 역할 | 파일 | 기존/신규 |
|------|------|------|-----------|
| `plan` | 다음 행동 결정 (LLM) | journal_planner.py | 신규 |
| `search_past` | 30일 RAG 검색 | journal_rag.py | 신규 함수 |
| `classify_mode` | journal/counseling 분류 | journal_router_agent.py | 기존 리팩터 |
| `respond` | 전략 기반 응답 생성 | journal_agent.py, counseling_agent.py | 기존 확장 |
| `extract` | 인사이트 추출 → RAG | journal_extractor.py | 기존 유지 |
| `summarize` | 세션 종료 요약 | journal_summarizer.py | 기존 유지 |

## 오케스트레이션 (journal_nodes.py)

```python
async def agent_loop(state, db):
    MAX_ACTIONS = 3

    while state.get("loop_count", 0) < MAX_ACTIONS:
        state = await plan(state, db)
        action = state["next_action"]

        if action == "search_past":
            state = await search_past(state, db)
        elif action == "classify_mode":
            state = await classify_mode(state, db)
        elif action == "respond":
            state = await respond(state, db)
            break
    else:
        state = await respond(state, db)

    state = await extract(state, db)
    return state
```

## 프롬프트

### PLANNER_PROMPT (신규)

planner에게 제공하는 정보:
- 현재 모드 (journal/counseling)
- 오늘 컨텍스트 (today_context)
- 과거 검색 결과 (past_context, 있으면)
- 최근 대화 (recent_messages)
- 사용자 메시지
- 이미 수행한 행동 목록 (actions_taken)

planner가 반환하는 JSON:
```json
{
  "action": "search_past" | "classify_mode" | "respond",
  "strategy": "deepen" | "new_topic" | "recall_past" | "empathize",
  "search_query": "검색할 내용 (search_past일 때만)",
  "reason": "판단 이유"
}
```

### 기존 프롬프트 확장

JOURNAL_SYSTEM_PROMPT / COUNSELING_SYSTEM_PROMPT에 슬롯 추가:
- `{strategy_instruction}`: 전략별 지시문
- `{past_context}`: 과거 맥락 (있으면)

## 변경 파일

| 파일 | 변경 내용 |
|------|-----------|
| `backend/app/agent/journal_state.py` | 3개 필드 추가 (past_context, strategy, loop_count) |
| `backend/app/agent/journal_planner.py` | 신규 — plan 노드 |
| `backend/app/agent/journal_nodes.py` | route_and_respond → agent_loop + 개별 노드 |
| `backend/app/agent/journal_rag.py` | search_past_context 함수 추가 |
| `backend/app/agent/journal_agent.py` | 전략/과거맥락 인자 추가 |
| `backend/app/agent/counseling_agent.py` | 동일 확장 |
| `backend/app/prompts/journal.py` | PLANNER_PROMPT 추가 + 기존 프롬프트 슬롯 추가 |
| `backend/app/routers/journal.py` | route_and_respond → agent_loop 호출 |

## 변경하지 않는 것

- 프론트엔드 코드 전체 (SSE 이벤트 구조 동일)
- DB 스키마 (journal_sessions, journal_messages, journal_embeddings)
- 과금 로직
- extract / summarize 노드 로직
- eslint-disable 수정은 별도 이슈

## LLM 호출 (메시지당, AGENT_MODEL=haiku)

| 케이스 | 호출 수 |
|--------|---------|
| 일반 대화 | plan(1) + respond(1) + extract(1) = 3회 |
| 과거 참조 | plan(1) + plan(1) + respond(1) + extract(1) = 4회 |
| 최대 (모드전환+검색) | plan(1) + plan(1) + plan(1) + respond(1) + extract(1) = 5회 |
