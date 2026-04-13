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


def _quality_cap(answer: str) -> int | None:
    """답변의 실질적 품질 기반으로 점수 상한을 반환. None이면 상한 없음(정상 답변).

    프롬프트가 저품질 규칙을 무시하는 경우의 안전장치. 반복/단어 부족 케이스에서 발동.
    """
    if not answer:
        return 0
    stripped = answer.strip()
    if len(stripped) < 10:
        return 15  # 매우 짧음
    tokens = [t for t in stripped.split() if t]
    unique_tokens = {t for t in tokens}

    # 문자 단위 고유 비율: 모바일 중복 입력으로 "제일제일제일" 붙은 케이스 대응
    no_space = "".join(ch for ch in stripped if not ch.isspace())
    if len(no_space) >= 20:
        unique_chars = set(no_space)
        char_ratio = len(unique_chars) / len(no_space)
        if char_ratio < 0.25:
            return 20

    # 토큰 단위 고유 비율
    if tokens and len(unique_tokens) / len(tokens) < 0.35:
        return 25
    if len(unique_tokens) < 5:
        return 30
    return None


def _normalize_evaluation(evaluation: dict, answer: str = "") -> dict:
    """LLM 출력 후처리: scores 0~100 clamp + 저품질 답변 cap + overallScore 가중 평균 강제."""
    raw_scores = evaluation.get("scores") or {}
    scores: dict[str, int] = {}
    for key in SCORE_WEIGHTS:
        scores[key] = _clamp_score(raw_scores.get(key))

    cap = _quality_cap(answer)
    if cap is not None:
        for key in scores:
            if scores[key] > cap:
                scores[key] = cap
        logger.info("Applied quality cap=%d to scores (answer_len=%d)", cap, len(answer or ""))

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

    return _normalize_evaluation(evaluation, answer)


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
