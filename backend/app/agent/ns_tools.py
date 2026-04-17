from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm, call_llm_json
from app.prompts.nightly_study import (
    EXPLAIN_CONCEPT_PROMPT,
    QUIZ_PROMPT,
    ASK_PROBING_PROMPT,
    SUGGEST_END_PROMPT,
    EXTEND_CURRICULUM_PROMPT,
    PIVOT_TOPIC_PROMPT,
)
from app.agent.ns_rag import search_learning_memory
from app.agent.ns_pivot import match_pivot_target
from app.agent.ns_srs import apply_proficiency_delta, compute_next_review

logger = logging.getLogger(__name__)


async def tool_retrieve_memory(db: AsyncSession, user_id: str, query: str, node_id: str | None) -> list[dict]:
    return await search_learning_memory(db, user_id, query, node_id=node_id)


async def tool_explain_concept(node_title: str, node_description: str, proficiency: int) -> str:
    prompt = EXPLAIN_CONCEPT_PROMPT.format(
        node_title=node_title, node_description=node_description, proficiency=proficiency
    )
    return await call_llm(prompt, system="당신은 친절한 개발 튜터입니다.")


async def tool_quiz(node_title: str, proficiency: int, difficulty: str = "medium") -> str:
    prompt = QUIZ_PROMPT.format(
        node_title=node_title, proficiency=proficiency, difficulty=difficulty
    )
    return await call_llm(prompt, system="당신은 개발 면접관입니다.")


async def tool_ask_probing(node_title: str, hint: str, proficiency: int) -> str:
    prompt = ASK_PROBING_PROMPT.format(
        node_title=node_title, hint=hint, proficiency=proficiency
    )
    return await call_llm(prompt, system="당신은 소크라틱 튜터입니다.")


async def tool_suggest_end(topics: list[str], turn_count: int, briefing_notes: list[str]) -> str:
    prompt = SUGGEST_END_PROMPT.format(
        topics_json=json.dumps(topics, ensure_ascii=False),
        turn_count=turn_count,
        briefing_notes="\n".join(f"- {n}" for n in briefing_notes if n),
    )
    return await call_llm(prompt, system="당신은 학습 코치입니다.")


async def tool_pivot_topic(
    db: AsyncSession,
    goal_id: str,
    candidate_nodes: list[dict],
    target: str,
    current_node_title: str,
) -> tuple[dict, str]:
    """
    Match target to existing node or create new. Returns (new_current_node, transition_message).
    """
    matched = match_pivot_target(candidate_nodes, target)
    if matched is None:
        # Create new extended node
        import uuid as _uuid
        new_id = str(_uuid.uuid4())
        await db.execute(
            text("""
                INSERT INTO curriculum_nodes (id, goal_id, title, description, depth_level, source, keywords)
                VALUES (:id, :goal_id, :title, :description, 1, 'extended', CAST(:keywords AS text[]))
            """),
            {
                "id": new_id,
                "goal_id": goal_id,
                "title": target,
                "description": f"유저 요청으로 추가된 주제: {target}",
                "keywords": "{" + '"' + target.lower().replace('"', '\\"') + '"' + "}",
            },
        )
        await db.commit()
        matched = {"id": new_id, "title": target, "description": f"유저 요청으로 추가된 주제: {target}", "depth_level": 1, "keywords": [target.lower()]}

    prompt = PIVOT_TOPIC_PROMPT.format(current_node_title=current_node_title, target=target)
    message = await call_llm(prompt, system="당신은 학습 코치입니다.")
    return matched, message


async def tool_extend_curriculum(
    db: AsyncSession,
    goal_id: str,
    proposed_title: str,
    rationale: str,
    root_titles: list[str],
    goal_title: str,
) -> dict:
    """Create a new extended node based on conversation gap. Returns created node."""
    import uuid as _uuid

    prompt = EXTEND_CURRICULUM_PROMPT.format(
        proposed_title=proposed_title,
        rationale=rationale,
        goal_title=goal_title,
        root_titles_json=json.dumps(root_titles, ensure_ascii=False),
    )
    node_spec = await call_llm_json(prompt)

    new_id = str(_uuid.uuid4())
    await db.execute(
        text("""
            INSERT INTO curriculum_nodes (id, goal_id, title, description, depth_level, source, keywords)
            VALUES (:id, :goal_id, :title, :description, :depth, 'extended', CAST(:keywords AS text[]))
        """),
        {
            "id": new_id,
            "goal_id": goal_id,
            "title": node_spec.get("title", proposed_title),
            "description": node_spec.get("description", ""),
            "depth": max(0, min(2, int(node_spec.get("depth_level", 1)))),
            "keywords": "{" + ",".join(
                '"' + k.replace('"', '\\"') + '"' for k in (node_spec.get("keywords") or [])
            ) + "}",
        },
    )
    await db.commit()
    return {
        "id": new_id,
        "title": node_spec.get("title", proposed_title),
        "description": node_spec.get("description", ""),
        "depth_level": int(node_spec.get("depth_level", 1)),
        "keywords": node_spec.get("keywords") or [],
    }


async def tool_evaluate_answer(
    db: AsyncSession,
    user_id: str,
    node_id: str,
    delta: int,
    correct: bool,
    mode: str,
) -> int:
    """Apply proficiency delta + update counts + recompute next_review_at. Returns new proficiency."""
    # Upsert node_mastery
    existing = await db.execute(
        text("SELECT proficiency, success_count, failure_count, streak_count FROM node_mastery WHERE user_id=:u AND node_id=:n"),
        {"u": user_id, "n": node_id},
    )
    row = existing.one_or_none()
    now = datetime.now(timezone.utc)

    if row is None:
        new_prof = apply_proficiency_delta(0, delta)
        success = 1 if correct else 0
        failure = 0 if correct else 1
        streak = 1 if correct else 0
        next_review = compute_next_review(new_prof, now)
        await db.execute(
            text("""
                INSERT INTO node_mastery (user_id, node_id, proficiency, success_count, failure_count, streak_count, last_studied_at, next_review_at, last_mode)
                VALUES (:u, :n, :p, :s, :f, :sc, :ls, :nr, :lm)
            """),
            {"u": user_id, "n": node_id, "p": new_prof, "s": success, "f": failure, "sc": streak, "ls": now, "nr": next_review, "lm": mode},
        )
    else:
        new_prof = apply_proficiency_delta(row.proficiency, delta)
        success = row.success_count + (1 if correct else 0)
        failure = row.failure_count + (0 if correct else 1)
        streak = (row.streak_count + 1) if correct else 0
        next_review = compute_next_review(new_prof, now)
        await db.execute(
            text("""
                UPDATE node_mastery
                SET proficiency=:p, success_count=:s, failure_count=:f, streak_count=:sc,
                    last_studied_at=:ls, next_review_at=:nr, last_mode=:lm
                WHERE user_id=:u AND node_id=:n
            """),
            {"p": new_prof, "s": success, "f": failure, "sc": streak, "ls": now, "nr": next_review, "lm": mode, "u": user_id, "n": node_id},
        )
    await db.commit()
    return new_prof
