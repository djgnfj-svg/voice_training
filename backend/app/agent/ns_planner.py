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
) -> PlannerOutput:
    """Call planner LLM with current state. Returns structured action plan."""
    user_prompt = PLANNER_USER_TEMPLATE.format(
        user_utterance=user_utterance,
        current_node_json=json.dumps(current_node, ensure_ascii=False) if current_node else "null",
        current_mode=current_mode,
        mastery_json=json.dumps(mastery, ensure_ascii=False) if mastery else "null",
        recent_messages=_format_recent(recent_messages),
        rag_hits_json=json.dumps(rag_hits, ensure_ascii=False),
        curriculum_context_json=json.dumps(curriculum_context, ensure_ascii=False),
        turn_count=turn_count,
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
    if intent not in ("answer", "question", "pivot", "meta"):
        intent = "meta"

    next_mode = raw.get("next_mode")
    if next_mode not in ("tutoring", "quiz", "socratic", "onboarding"):
        next_mode = "quiz"

    actions = raw.get("actions") or []
    if not isinstance(actions, list):
        actions = []

    return {
        "intent": intent,
        "pivot_target": raw.get("pivot_target"),
        "evaluation": raw.get("evaluation") if intent == "answer" else None,
        "next_mode": next_mode,
        "actions": actions[:3],  # max 3 tools per turn
        "should_suggest_end": bool(raw.get("should_suggest_end")),
        "briefing_note": raw.get("briefing_note"),
    }
