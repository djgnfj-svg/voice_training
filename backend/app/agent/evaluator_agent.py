# backend/app/agent/evaluator_agent.py
from __future__ import annotations

import json
import logging

from app.config import settings
from app.lib.llm_client import call_llm_json
from app.prompts.agent import EVALUATOR_PROMPT, REPORT_PROMPT

logger = logging.getLogger(__name__)

SCORE_WEIGHTS: dict[str, float] = {
    "clarity": 0.30,
    "accuracy": 0.25,
    "practicality": 0.25,
    "depth": 0.15,
    "completeness": 0.05,
}


def _clamp_score(value) -> int:
    """Clamp a raw LLM score into 0~100 int. Non-numeric → 0."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0
    if n < 0:
        return 0
    if n > 100:
        return 100
    return int(round(n))


def _normalize_evaluation(evaluation: dict) -> dict:
    """LLM 출력 후처리: scores 0~100 clamp + overallScore를 가중 평균으로 강제 계산."""
    raw_scores = evaluation.get("scores") or {}
    scores: dict[str, int] = {}
    for key in SCORE_WEIGHTS:
        scores[key] = _clamp_score(raw_scores.get(key))

    overall = sum(scores[k] * w for k, w in SCORE_WEIGHTS.items())
    evaluation["scores"] = scores
    evaluation["overallScore"] = int(round(overall))
    return evaluation


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

    evaluation = await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )

    return _normalize_evaluation(evaluation)


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
