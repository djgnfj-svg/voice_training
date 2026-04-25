from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.lib.llm_client import call_llm_json, MODELS
from app.lib.transcript_correct import correct_transcript
from app.models.interview import InterviewSession, InterviewAnswer
from app.prompts.evaluation import (
    TECHNICAL_EVALUATION_PROMPT,
    DEEP_TECHNICAL_EVALUATION_PROMPT,
    BEHAVIORAL_EVALUATION_PROMPT,
    FOLLOWUP_EVALUATION_PROMPT,
)

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
    """
    Call transcript correction + Claude evaluation.
    Returns evaluation dict with scores, feedback, modelAnswer, followUpQuestion, etc.
    Does NOT save to DB.
    """
    # Correct transcript
    correction = await correct_transcript(answer_transcript, question_text)
    corrected_text = correction["corrected_text"]
    was_changed = correction["was_changed"]

    # Select prompt template
    if previous_context:
        prompt_template = FOLLOWUP_EVALUATION_PROMPT
    elif deep_mode:
        prompt_template = DEEP_TECHNICAL_EVALUATION_PROMPT
    elif interview_type == "BEHAVIORAL":
        prompt_template = BEHAVIORAL_EVALUATION_PROMPT
    else:
        prompt_template = TECHNICAL_EVALUATION_PROMPT

    prompt = prompt_template.replace("{question}", question_text).replace(
        "{answer}", corrected_text
    )

    # Inject previous context for follow-up evaluation
    if previous_context:
        context_lines = [
            f"원래 질문: {previous_context['originalQuestion']}",
            f"원래 답변: {previous_context['originalAnswer']}",
        ]
        for fh in previous_context.get("followUpHistory", []):
            context_lines.append(f"꼬리질문: {fh['question']}")
            context_lines.append(f"답변: {fh['answer']}")
        prompt = prompt.replace("{previousContext}", "\n".join(context_lines))

    # Inject related key points for deep mode (non-followup)
    if deep_mode and not previous_context:
        if related_key_points and len(related_key_points) > 0:
            key_points_str = "\n".join(f"- {kp}" for kp in related_key_points)
        else:
            key_points_str = "(참고 핵심 포인트 없음)"
        prompt = prompt.replace("{relatedKeyPoints}", key_points_str)

    # Call Claude
    try:
        raw = await call_llm_json(
            prompt,
            model=MODELS["EVALUATION"],
            temperature=0.3,
        )
        evaluation: dict[str, Any] = raw if isinstance(raw, dict) else {"error": "unexpected format"}
    except (json.JSONDecodeError, ValueError) as e:
        logger.error("Failed to parse evaluation response: %s", e)
        raise ValueError("Failed to evaluate answer") from e

    if was_changed:
        evaluation["correctedTranscript"] = corrected_text

    return evaluation


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
    """
    Fetch session, call evaluate_stateless, save evaluation to InterviewAnswer record.
    """
    # Fetch session with answers
    result = await db.execute(
        select(InterviewSession)
        .options(selectinload(InterviewSession.answers))
        .where(InterviewSession.id == session_id, InterviewSession.user_id == user_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise ValueError("Session not found")

    # Find existing answer
    existing_answer = next(
        (a for a in session.answers if a.question_index == question_index), None
    )
    if not existing_answer:
        raise ValueError(
            f"Answer not found for session {session_id}, questionIndex {question_index}"
        )

    question_text = existing_answer.question_text

    evaluation = await evaluate_stateless(
        question_text=question_text,
        answer_transcript=answer_transcript,
        interview_type=session.type,
        deep_mode=deep_mode,
        related_key_points=related_key_points,
    )

    # Update answer record
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
