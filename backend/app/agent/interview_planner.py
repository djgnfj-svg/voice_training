# backend/app/agent/interview_planner.py
from __future__ import annotations

import json
import logging

from app.lib.llm_client import call_llm_json
from app.config import settings
from app.prompts.agent import INTERVIEW_PLANNER_PROMPT

logger = logging.getLogger(__name__)

VALID_ACTIONS = {"search_profile", "evaluate", "decide"}


async def plan_next_action(
    current_question: str,
    current_answer: str,
    question_count: int,
    max_questions: int,
    follow_up_round: int,
    profile_context: list[dict],
    evaluation: dict | None,
    actions_taken: list[str],
) -> dict:
    """Decide the next action for the interview agent loop.

    Returns: {"action": str, "search_query": str, "reason": str}
    """
    profile_text = ""
    if profile_context:
        for item in profile_context[:5]:
            profile_text += f"- [{item.get('category', '')}] {item.get('content', '')}\n"
    profile_text = profile_text or "(아직 검색하지 않음)"

    eval_text = json.dumps(evaluation, ensure_ascii=False) if evaluation else "(아직 평가하지 않음)"
    actions_text = ", ".join(actions_taken) if actions_taken else "(없음)"

    prompt = INTERVIEW_PLANNER_PROMPT.format(
        current_question=current_question,
        current_answer=current_answer,
        question_count=question_count,
        max_questions=max_questions,
        follow_up_round=follow_up_round,
        profile_context=profile_text,
        evaluation=eval_text,
        actions_taken=actions_text,
    )

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.2)
    except Exception:
        logger.exception("Interview planner LLM call failed, defaulting to evaluate")
        return {
            "action": "evaluate",
            "search_query": "",
            "reason": "플래너 호출 실패, 기본 평가 진행",
        }

    action = result.get("action", "evaluate")
    if action not in VALID_ACTIONS:
        action = "evaluate"

    return {
        "action": action,
        "search_query": result.get("search_query", ""),
        "reason": result.get("reason", ""),
    }
