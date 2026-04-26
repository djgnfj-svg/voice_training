"""Runner — assembles SUT prompt and calls OpenAI directly.

Bypasses the graph's DB integration on purpose. The system prompt template
matches what `build_learning_graph.load_context` injects (see
`backend/app/agent/learning_coach/graph.py:576`), so prompt/model regressions
are still detected.
"""
from __future__ import annotations

import json
from typing import Any

from app.config import settings
from app.lib.llm_client import call_llm
from app.prompts.learning_coach import AGENTIC_SYSTEM_PROMPT
from tests.eval.learning_coach.schema import Fixture


def _fixture_to_context(fixture: Fixture) -> dict[str, Any]:
    return {
        "goal_title": fixture.goal,
        "subject": fixture.subject,
        "target_node": {"title": fixture.current_topic},
        "weak_nodes": [{"title": fixture.current_topic, "proficiency": fixture.proficiency}],
        "recent_summaries": [],
        "profile": {"current_goal": fixture.goal},
    }


def build_messages(fixture: Fixture) -> list[dict[str, str]]:
    context = _fixture_to_context(fixture)
    system = AGENTIC_SYSTEM_PROMPT + "\n\nContext JSON:\n" + json.dumps(context, ensure_ascii=False)
    msgs: list[dict[str, str]] = [{"role": "system", "content": system}]
    for m in fixture.recent_messages:
        msgs.append({"role": m.role, "content": m.content})
    msgs.append({"role": "user", "content": fixture.user_message})
    return msgs


async def _call_sut_llm(messages: list[dict[str, str]]) -> str:
    parts = []
    for m in messages:
        parts.append(f"[{m['role'].upper()}]\n{m['content']}")
    prompt = "\n\n".join(parts)
    return await call_llm(prompt, model=settings.AGENT_MODEL, temperature=0.4)


async def run_case(fixture: Fixture) -> str:
    msgs = build_messages(fixture)
    return await _call_sut_llm(msgs)
