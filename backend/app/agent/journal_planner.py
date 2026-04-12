# backend/app/agent/journal_planner.py
from __future__ import annotations

import logging

from app.lib.llm_client import call_llm_json
from app.config import settings
from app.prompts.journal import PLANNER_PROMPT

logger = logging.getLogger(__name__)

VALID_ACTIONS = {"search_past", "classify_mode", "respond"}
VALID_STRATEGIES = {"deepen", "new_topic", "recall_past", "empathize"}


async def plan_next_action(
    user_message: str,
    mode: str,
    recent_messages: list[dict],
    today_context: list[dict],
    past_context: list[dict],
    actions_taken: list[str],
) -> dict:
    """Decide the next action for the journal agent loop.

    Returns: {"action": str, "strategy": str, "search_query": str, "reason": str}
    """
    recent_text = ""
    for m in recent_messages[-6:]:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        recent_text += f"{role_label}: {m.get('content', '')}\n"

    today_text = ""
    if today_context:
        for item in today_context[:5]:
            today_text += f"- [{item['category']}] {item['content']}\n"
    today_text = today_text or "(없음)"

    past_text = ""
    if past_context:
        for item in past_context[:5]:
            past_text += f"- [{item['category']}] {item['content']}\n"
    past_text = past_text or "(아직 검색하지 않음)"

    actions_text = ", ".join(actions_taken) if actions_taken else "(없음)"

    prompt = PLANNER_PROMPT.format(
        mode=mode,
        today_context=today_text,
        past_context=past_text,
        recent_messages=recent_text or "(대화 시작)",
        user_message=user_message,
        actions_taken=actions_text,
    )

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.2)
    except Exception:
        logger.exception("Planner LLM call failed, defaulting to respond")
        return {
            "action": "respond",
            "strategy": "empathize",
            "search_query": "",
            "reason": "플래너 호출 실패, 기본 응답",
        }

    action = result.get("action", "respond")
    if action not in VALID_ACTIONS:
        action = "respond"

    strategy = result.get("strategy", "deepen")
    if strategy not in VALID_STRATEGIES:
        strategy = "deepen"

    return {
        "action": action,
        "strategy": strategy,
        "search_query": result.get("search_query", ""),
        "reason": result.get("reason", ""),
    }
