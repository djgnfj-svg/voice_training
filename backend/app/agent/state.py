# backend/app/agent/state.py
from __future__ import annotations

from typing import Literal, TypedDict


class ScanItem(TypedDict):
    project_ref: str
    query: str
    reason: Literal["jd_match", "jd_unmatched", "project_order"]


class DiveTopic(TypedDict):
    topic: str
    project_ref: str
    angle: Literal["weakness", "strength"]
    scan_question_idx: int
    query: str


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
    max_questions: int

    # 평가 에이전트가 채움
    current_evaluation: dict

    # 면접관 에이전트가 채움
    next_action: str

    # 대화 히스토리
    conversation_history: list[dict]

    # 최종 결과
    overall_report: dict | None

    # 에이전트 루프
    profile_context: list[dict]
    loop_count: int
    actions_taken: list[str]

    # SSE 이벤트 큐
    pending_events: list[dict]

    # Fit Analysis (skill_match + avoid_topics만)
    fit_analysis: dict | None

    # 이력서 RAG
    resume_id: str | None
    has_resume_embeddings: bool
    current_resume_chunks: list[dict]

    # Scan + Dive 페이즈 (신규)
    phase: Literal["scan", "dive", "done"]
    scan_plan: list[ScanItem]
    dive_plan: list[DiveTopic]
    scan_evaluations: list[dict]
    current_scan_idx: int
    current_dive_idx: int
    current_dive_depth: int
