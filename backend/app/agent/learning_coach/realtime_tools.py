"""Realtime tool adaptation + dispatch for the Learning Coach voice relay.

The Learning Coach "brain" is already a set of 7 server-side function-calling
tools (see ``graph.py``). This module is a thin, stable bridge that lets the
OpenAI Realtime API reuse those exact tools without touching graph internals:

- ``adapt_tools_for_realtime`` converts the Chat Completions tool schema
  (``_default_tools_schema()``) into the flat Realtime ``session.update`` tool
  format.
- ``dispatch_tool_call`` runs a Realtime ``function_call`` against the bound
  tool implementations from ``_make_tools(db, session_id, user_id)`` and returns
  the JSON-string result that gets sent back as a ``function_call_output``.

Nothing here mutates graph.py — it only consumes its stable interfaces.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.learning_coach.graph import _default_tools_schema, _make_tools

logger = logging.getLogger(__name__)


def adapt_tools_for_realtime() -> list[dict[str, Any]]:
    """Convert Chat-Completions tool schema to the Realtime tool format.

    Chat Completions nests under ``{"type": "function", "function": {...}}``.
    The Realtime API expects a flat ``{"type": "function", "name", "description",
    "parameters"}`` object per tool.
    """
    realtime_tools: list[dict[str, Any]] = []
    for entry in _default_tools_schema():
        fn = entry.get("function") or {}
        realtime_tools.append(
            {
                "type": "function",
                "name": fn.get("name"),
                "description": fn.get("description"),
                "parameters": fn.get("parameters"),
            }
        )
    return realtime_tools


async def dispatch_tool_call(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    name: str,
    arguments: str | dict[str, Any] | None,
) -> str:
    """Execute one Realtime function_call against the bound brain tools.

    Returns a JSON string suitable for a ``function_call_output`` item. Tool
    failures are caught and returned as a structured error so the relay can keep
    the conversation alive (matching the graph's failure-handling policy).
    """
    if isinstance(arguments, str):
        try:
            args = json.loads(arguments) if arguments.strip() else {}
        except json.JSONDecodeError:
            args = {}
    elif isinstance(arguments, dict):
        args = arguments
    else:
        args = {}

    tools = {t.name: t for t in _make_tools(db, session_id, user_id)}
    tool = tools.get(name)
    if tool is None:
        logger.warning("realtime: unknown tool requested: %s", name)
        return json.dumps({"error": "unknown_tool", "name": name}, ensure_ascii=False)

    try:
        result = await tool.ainvoke(args)
    except Exception:
        logger.exception("realtime: tool '%s' failed", name)
        return json.dumps({"error": "tool_failed", "name": name}, ensure_ascii=False)

    # LangChain tools return strings (our tools already json-encode their result).
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False, default=str)
