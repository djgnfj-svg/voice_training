# backend/app/agent/state.py
from __future__ import annotations

from typing import TypedDict


class InterviewState(TypedDict, total=False):
    # 세션 기본 정보
    session_id: str
    user_id: str

    # 입력 컨텍스트
    resume: dict
    job_posting: dict | None

    # 프로필 에이전트가 채움
    user_profile: dict

    # 면접 진행 상태
    current_question: str
    current_answer: str
    question_count: int
    follow_up_round: int
    max_questions: int

    # 평가 에이전트가 채움
    current_evaluation: dict

    # 면접관 에이전트가 채움
    next_action: str  # "follow_up" | "next_question" | "end"

    # 대화 히스토리
    conversation_history: list[dict]

    # 최종 결과
    overall_report: dict | None

    # SSE 이벤트 큐 (노드가 이벤트를 여기에 쌓으면 라우터가 SSE로 전송)
    pending_events: list[dict]
