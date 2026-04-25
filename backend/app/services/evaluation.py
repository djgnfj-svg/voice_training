"""답변 평가 서비스 — LangGraph 파이프라인 위임 + DB 저장."""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.agent.evaluation_pipeline import run_evaluation_graph
from app.models.interview import InterviewAnswer, InterviewSession

logger = logging.getLogger(__name__)


async def evaluate_stateless(
    *,
    question_text: str,
    answer_transcript: str,
    interview_type: str,
    deep_mode: bool = False,
    related_key_points: list[str] | None = None,
    previous_context: dict | None = None,
) -> dict[str, Any]:
    """transcript 보정 → 평가 (DB 저장 안 함)."""
    return await run_evaluation_graph(
        question_text=question_text,
        answer_transcript=answer_transcript,
        interview_type=interview_type,
        deep_mode=deep_mode,
        related_key_points=related_key_points,
        previous_context=previous_context,
    )


async def evaluate_answer(
    db: AsyncSession,
    *,
    session_id: str,
    question_index: int,
    answer_transcript: str,
    user_id: str,
    response_time_sec: int | None = None,
    deep_mode: bool = False,
    related_key_points: list[str] | None = None,
) -> dict[str, Any]:
    result = await db.execute(
        select(InterviewSession)
        .options(selectinload(InterviewSession.answers))
        .where(InterviewSession.id == session_id, InterviewSession.user_id == user_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise ValueError("Session not found")

    existing_answer = next(
        (a for a in session.answers if a.question_index == question_index), None
    )
    if not existing_answer:
        raise ValueError(
            f"Answer not found for session {session_id}, questionIndex {question_index}"
        )

    evaluation = await evaluate_stateless(
        question_text=existing_answer.question_text,
        answer_transcript=answer_transcript,
        interview_type=session.type,
        deep_mode=deep_mode,
        related_key_points=related_key_points,
    )

    corrected = evaluation.get("correctedTranscript")
    await db.execute(
        update(InterviewAnswer)
        .where(
            InterviewAnswer.session_id == session_id,
            InterviewAnswer.question_index == question_index,
        )
        .values(
            answer_transcript=corrected or answer_transcript,
            scores=evaluation.get("scores"),
            overall_score=evaluation.get("overallScore"),
            brief_feedback=evaluation.get("briefFeedback"),
            detailed_feedback=evaluation.get("detailedFeedback"),
            model_answer=evaluation.get("modelAnswer"),
            follow_up_question=evaluation.get("followUpQuestion"),
            response_time_sec=response_time_sec,
        )
    )
    await db.commit()
    return evaluation
