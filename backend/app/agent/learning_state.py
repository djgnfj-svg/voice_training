from typing import TypedDict


class LearningState(TypedDict, total=False):
    session_id: str
    user_id: str
    topic: str
    user_profile: dict
    conversation_history: list[dict]
    current_phase: str  # "explain" | "check" | "deepen" | "apply" | "wrap_up"
    llm_call_count: int
    credit_activated: bool
    is_free_session: bool
    pending_events: list[dict]

    # 에이전트 루프
    profile_context: list[dict]   # 프로필 RAG 검색 결과
    journal_context: list[dict]   # 저널 RAG 크로스 검색 결과
    strategy: str                  # planner 결정 전략
    loop_count: int                # 현재 루프 횟수 (최대 4)
    actions_taken: list[str]       # 수행한 행동 목록
