from __future__ import annotations

import json
import logging
from typing import Any

from app.lib.llm_client import call_llm_json
from app.prompts.nightly_study import PLANNER_SYSTEM_PROMPT, PLANNER_USER_TEMPLATE
from app.agent.ns_state import PlannerOutput

logger = logging.getLogger(__name__)


async def run_planner(
    user_utterance: str,
    current_node: dict | None,
    current_mode: str,
    mastery: dict | None,
    recent_messages: list[dict],
    rag_hits: list[dict],
    curriculum_context: dict,
    turn_count: int,
    pending_action: dict | None = None,
) -> PlannerOutput:
    """Call planner LLM with current state. Returns structured action plan."""
    # Use .replace() instead of .format() to avoid crashes when user-supplied
    # strings (user_utterance, recent_messages) contain literal { or }.
    user_prompt = (
        PLANNER_USER_TEMPLATE
        .replace("{current_node_json}", json.dumps(current_node, ensure_ascii=False) if current_node else "null")
        .replace("{current_mode}", current_mode)
        .replace("{mastery_json}", json.dumps(mastery, ensure_ascii=False) if mastery else "null")
        .replace("{rag_hits_json}", json.dumps(rag_hits, ensure_ascii=False))
        .replace("{curriculum_context_json}", json.dumps(curriculum_context, ensure_ascii=False))
        .replace("{turn_count}", str(turn_count))
        .replace("{recent_messages}", _format_recent(recent_messages))
        .replace("{user_utterance}", user_utterance)
        .replace(
            "{pending_action_json}",
            json.dumps(pending_action, ensure_ascii=False) if pending_action else "null",
        )
    )

    # call_llm_json takes prompt as first positional arg; combine system+user
    combined_prompt = f"{PLANNER_SYSTEM_PROMPT}\n\n{user_prompt}"
    result = await call_llm_json(combined_prompt)
    return _validate_planner_output(result)


def _format_recent(messages: list[dict]) -> str:
    lines = []
    for m in messages[-6:]:
        role = "유저" if m["role"] == "user" else "AI"
        lines.append(f"{role}: {m['content']}")
    return "\n".join(lines) if lines else "(대화 없음)"


def _validate_planner_output(raw: Any) -> PlannerOutput:
    """Basic validation with safe defaults."""
    if not isinstance(raw, dict):
        raise ValueError(f"planner did not return dict: {raw}")

    intent = raw.get("intent")
    if intent not in ("answer", "question", "pivot", "meta", "change_goal", "confirm"):
        intent = "meta"

    next_mode = raw.get("next_mode")
    if next_mode not in ("tutoring", "quiz", "socratic", "onboarding"):
        next_mode = "quiz"

    actions = raw.get("actions") or []
    if not isinstance(actions, list):
        actions = []

    gcp_raw = raw.get("goal_change_proposed")
    goal_change_proposed = gcp_raw.strip() if isinstance(gcp_raw, str) and gcp_raw.strip() else None

    gcc_raw = raw.get("goal_change_confirm")
    if gcc_raw is True or gcc_raw is False:
        goal_change_confirm = gcc_raw
    else:
        goal_change_confirm = None

    return {
        "intent": intent,
        "pivot_target": raw.get("pivot_target"),
        "evaluation": raw.get("evaluation") if intent == "answer" else None,
        "next_mode": next_mode,
        "actions": actions[:3],  # max 3 tools per turn
        "should_suggest_end": bool(raw.get("should_suggest_end")),
        "briefing_note": raw.get("briefing_note"),
        "goal_change_proposed": goal_change_proposed,
        "goal_change_confirm": goal_change_confirm,
    }
