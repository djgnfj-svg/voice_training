from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from langsmith import traceable
from langsmith.run_helpers import get_current_run_tree

T = TypeVar("T")

if os.getenv("LANGSMITH_API_KEY") and not os.getenv("LANGSMITH_TRACING"):
    os.environ["LANGSMITH_TRACING"] = "true"


def trace_graph(name: str):
    return traceable(name=name, run_type="chain")


def trace_tool(name: str):
    return traceable(name=name, run_type="tool")


async def traced_graph_call(
    *,
    name: str,
    metadata: dict[str, Any],
    call: Callable[[], Awaitable[T]],
) -> tuple[T, str | None]:
    run_id: str | None = None

    @trace_graph(name)
    async def _run() -> T:
        nonlocal run_id
        run = get_current_run_tree()
        if run is not None and getattr(run, "id", None):
            run_id = str(run.id)
        return await call()

    result = await _run(langsmith_extra={"metadata": metadata})
    return result, run_id
