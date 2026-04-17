from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm_json
from app.prompts.nightly_study import SEED_CURRICULUM_PROMPT

logger = logging.getLogger(__name__)


async def generate_and_insert_seed(
    db: AsyncSession,
    goal_id: str,
    goal_title: str,
) -> int:
    """
    Call LLM to generate seed curriculum, insert curriculum_nodes.
    Returns number of nodes inserted.
    """
    prompt = SEED_CURRICULUM_PROMPT.format(goal_title=goal_title)
    # call_llm_json takes prompt as first positional arg (no system param)
    data = await call_llm_json(prompt)

    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, list) or len(nodes) == 0:
        raise RuntimeError(f"seed curriculum returned no nodes: {data}")

    # Insert root nodes first (parent_title=None), then children (parent_title != None)
    title_to_id: dict[str, str] = {}
    roots = [n for n in nodes if not n.get("parent_title")]
    children = [n for n in nodes if n.get("parent_title")]

    for node in roots + children:
        parent_id = None
        if node.get("parent_title"):
            parent_id = title_to_id.get(node["parent_title"])
        result = await db.execute(
            text("""
                INSERT INTO curriculum_nodes (goal_id, title, description, depth_level, parent_id, source, keywords)
                VALUES (:goal_id, :title, :description, :depth, :parent_id, 'seed', CAST(:keywords AS text[]))
                RETURNING id
            """),
            {
                "goal_id": goal_id,
                "title": node["title"],
                "description": node.get("description", ""),
                "depth": max(0, min(2, int(node.get("depth_level", 0)))),
                "parent_id": parent_id,
                "keywords": "{" + ",".join(
                    '"' + k.replace('"', '\\"') + '"' for k in (node.get("keywords") or [])
                ) + "}",
            },
        )
        row = result.one()
        title_to_id[node["title"]] = str(row.id)

    await db.commit()
    return len(nodes)


def normalize_goal(title: str) -> str:
    """Normalize free-form goal text to a key. Simple heuristic."""
    return "_".join(title.strip().upper().split())
