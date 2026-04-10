# backend/app/agent/evaluator_agent.py
from __future__ import annotations

import json
import logging

from app.config import settings
from app.lib.anthropic_client import call_llm_json
from app.prompts.agent import EVALUATOR_PROMPT, REPORT_PROMPT

logger = logging.getLogger(__name__)


async def evaluate_answer(
    question: str,
    answer: str,
    user_profile: dict,
    conversation_history: list[dict],
) -> dict:
    """Evaluate a single answer with user profile context."""
    strengths = "\n".join(user_profile.get("strengths", [])) or "데이터 없음"
    weaknesses = "\n".join(user_profile.get("weaknesses", [])) or "데이터 없음"

    history_parts = []
    for entry in conversation_history:
        history_parts.append(f"Q: {entry.get('question', '')}")
        if entry.get("answer"):
            history_parts.append(f"A: {entry['answer']}")
    history_str = "\n".join(history_parts) if history_parts else "첫 질문입니다."

    prompt = EVALUATOR_PROMPT.format(
        question=question,
        answer=answer,
        strengths=strengths,
        weaknesses=weaknesses,
        conversation_history=history_str,
    )

    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )


async def generate_report(
    conversation_history: list[dict],
    user_profile: dict,
) -> dict:
    """Generate overall interview report."""
    history_parts = []
    for entry in conversation_history:
        history_parts.append(f"Q: {entry.get('question', '')}")
        if entry.get("answer"):
            history_parts.append(f"A: {entry['answer']}")
        if entry.get("evaluation"):
            ev = entry["evaluation"]
            history_parts.append(f"점수: {ev.get('overallScore', '?')}, 피드백: {ev.get('briefFeedback', '')}")
        history_parts.append("---")

    prompt = REPORT_PROMPT.format(
        conversation_history="\n".join(history_parts),
        strengths="\n".join(user_profile.get("strengths", [])) or "데이터 없음",
        weaknesses="\n".join(user_profile.get("weaknesses", [])) or "데이터 없음",
    )

    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )
