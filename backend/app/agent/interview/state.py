# backend/app/agent/state.py
from __future__ import annotations

from typing import Literal, TypedDict


class RubricItem(TypedDict):
    """JD에서 추출한 단일 평가 루브릭 항목.

    - has_evidence: 이력서(스킬/RAG)에 이 요구를 뒷받침하는 근거가 있는지.
      True → 근거 연결 질문, False → gap 질문(면접에서 1개까지만 출제).
    - evidence_refs: 매칭된 이력서 스킬/근거 표시용.
    - query: 이력서 RAG 검색용 쿼리(label + 핵심 키워드 결합).
    """

    id: str
    label: str
    jd_requirement: str
    importance: Literal["must", "nice"]
    has_evidence: bool
    evidence_refs: list[str]
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

    # JD 루브릭 커버리지 (단일 루프)
    rubric_plan: list[RubricItem]
    coverage: list[dict]
    current_rubric_idx: int
    current_item_depth: int
