# backend/app/agent/evaluator_agent.py
from __future__ import annotations

import json
import logging

from app.agent.report_aggregator import aggregate_evaluations, format_aggregate_for_prompt
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


_DEMONSTRATED_MAX = 8
_MISSING_MAX = 5


def _normalize_keywords(raw, limit: int) -> list[str]:
    """문자열만, trim, 빈값 제거, 대소문자 무시 dedupe, 최대 limit개."""
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        stripped = item.strip()
        if not stripped:
            continue
        key = stripped.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(stripped)
        if len(out) >= limit:
            break
    return out


def _normalize_evaluation(evaluation: dict, answer: str = "") -> dict:
    """LLM 출력 후처리: scores 0~100 clamp + 저품질 답변 cap + overallScore 가중 평균 강제.

    기술 키워드(demonstratedKeywords/missingKeywords)도 정규화한다:
    문자열만 남기고 trim+dedupe(대소문자 무시)+size clamp. 저품질 답변(cap 발동)에서는
    키워드를 신뢰할 수 없으므로 빈 배열로 비운다.
    """
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

    # 기술 키워드 정규화
    if cap is not None:
        # 저품질 답변은 키워드 배열도 신뢰할 수 없음 → 비움
        evaluation["demonstratedKeywords"] = []
        evaluation["missingKeywords"] = []
    else:
        evaluation["demonstratedKeywords"] = _normalize_keywords(
            evaluation.get("demonstratedKeywords"), _DEMONSTRATED_MAX
        )
        evaluation["missingKeywords"] = _normalize_keywords(
            evaluation.get("missingKeywords"), _MISSING_MAX
        )

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
    """Generate overall interview report with aggregated metrics injected."""
    aggregate = aggregate_evaluations(conversation_history)
    aggregate_block = format_aggregate_for_prompt(aggregate)

    history_parts = []
    for i, entry in enumerate(conversation_history, start=1):
        history_parts.append(f"[Q{i}] {entry.get('question', '')}")
        if entry.get("answer"):
            history_parts.append(f"A: {entry['answer']}")
        ev = entry.get("evaluation") or {}
        if ev:
            demo = ev.get("demonstratedKeywords") or []
            miss = ev.get("missingKeywords") or []
            extra = []
            if demo:
                extra.append(f"다룸: {', '.join(demo)}")
            if miss:
                extra.append(f"누락: {', '.join(miss)}")
            kw_str = " | ".join(extra)
            history_parts.append(
                f"점수: {ev.get('overallScore', '?')}" + (f" | {kw_str}" if kw_str else "")
            )
        history_parts.append("---")

    prompt = REPORT_PROMPT.format(
        aggregate_block=aggregate_block,
        conversation_history="\n".join(history_parts),
        strengths="\n".join(user_profile.get("strengths", [])) or "데이터 없음",
        weaknesses="\n".join(user_profile.get("weaknesses", [])) or "데이터 없음",
    )

    report = await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )

    # 서버 계산 수치로 overridde (LLM의 산술 오류 방지, 프론트 재계산 불필요)
    report["overallScore"] = aggregate["overallStats"]["avg"]
    report["categoryBreakdown"] = aggregate["categoryBreakdown"]
    report["phaseAnalysis"] = aggregate["phaseAnalysis"]
    report["diveTopicAnalysis"] = aggregate["diveTopicAnalysis"]
    report["keywordStats"] = aggregate["keywordStats"]

    return report
