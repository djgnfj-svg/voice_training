# backend/app/agent/journal_state.py
from __future__ import annotations

from typing import Literal, TypedDict


class JournalState(TypedDict, total=False):
    # 세션 기본 정보
    session_id: str
    user_id: str

    # 대화 상태
    messages: list[dict]  # 전체 대화 히스토리 [{role, content, mode}]
    mode: Literal["journal", "counseling"]
    user_message: str  # 현재 사용자 입력

    # RAG 컨텍스트 (세션 시작 시 로드)
    journal_context: list[dict]  # 오늘 추출된 인사이트

    # 추출 상태
    extracted_count: int

    # 과금
    message_count: int
    free_messages_used: int

    # AI 응답
    ai_response: str

    # 요약
    session_summary: str | None

    # 에이전트 루프
    past_context: list[dict]  # RAG 30일 검색 결과
    strategy: str  # planner 결정 전략 (deepen/new_topic/recall_past/empathize)
    loop_count: int  # 현재 루프 횟수 (최대 3)
    actions_taken: list[str]  # 수행한 행동 목록

    # SSE 이벤트 큐
    pending_events: list[dict]
