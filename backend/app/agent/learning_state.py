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
