# backend/app/agent/learning_planner.py
from __future__ import annotations

import json
import logging

from app.lib.llm_client import call_llm_json
from app.config import settings
from app.prompts.learning_agent import LEARNING_PLANNER_PROMPT

logger = logging.getLogger(__name__)

VALID_ACTIONS = {"search_profile", "search_journal", "assess", "teach"}
VALID_STRATEGIES = {"explain", "deepen", "simplify", "connect", "challenge", "next_topic"}


async def plan_next_action(
    user_message: str,
    topic: str,
    phase: str,
    recent_messages: list[dict],
    profile_context: list[dict],
    journal_context: list[dict],
    assessment: dict | None,
    actions_taken: list[str],
) -> dict:
    """Decide the next action for the learning agent loop.

    Returns: {"action": str, "strategy": str, "search_query": str, "reason": str}
    """
    recent_text = ""
    for m in recent_messages[-6:]:
        role_label = "사용자" if m.get("role") == "user" else "튜터"
        recent_text += f"{role_label}: {m.get('content', '')}\n"

    profile_text = ""
    if profile_context:
        for item in profile_context[:5]:
            profile_text += f"- [{item.get('category', '')}] {item.get('content', '')}\n"
    profile_text = profile_text or "(아직 검색하지 않음)"

    journal_text = ""
    if journal_context:
        for item in journal_context[:5]:
            journal_text += f"- [{item.get('category', '')}] {item.get('content', '')}\n"
    journal_text = journal_text or "(아직 검색하지 않음)"

    assessment_text = json.dumps(assessment, ensure_ascii=False) if assessment else "(아직 평가하지 않음)"
    actions_text = ", ".join(actions_taken) if actions_taken else "(없음)"

    prompt = LEARNING_PLANNER_PROMPT.format(
        topic=topic or "미정",
        phase=phase or "greeting",
        profile_context=profile_text,
        journal_context=journal_text,
        assessment=assessment_text,
        recent_messages=recent_text or "(대화 시작)",
        user_message=user_message,
        actions_taken=actions_text,
    )

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.2)
    except Exception:
        logger.exception("Learning planner LLM call failed, defaulting to teach")
        return {
            "action": "teach",
            "strategy": "explain",
            "search_query": "",
            "reason": "플래너 호출 실패, 기본 교육 응답",
        }

    action = result.get("action", "teach")
    if action not in VALID_ACTIONS:
        action = "teach"

    strategy = result.get("strategy", "explain")
    if strategy not in VALID_STRATEGIES:
        strategy = "explain"

    return {
        "action": action,
        "strategy": strategy,
        "search_query": result.get("search_query", ""),
        "reason": result.get("reason", ""),
    }
