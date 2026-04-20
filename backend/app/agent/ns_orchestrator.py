from __future__ import annotations

import json
import logging
from typing import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import BackgroundTasks

from app.agent.ns_planner import run_planner
from app.agent.ns_tools import (
    tool_retrieve_memory, tool_explain_concept, tool_quiz,
    tool_ask_probing, tool_suggest_end, tool_pivot_topic,
    tool_extend_curriculum, tool_evaluate_answer,
)
from app.agent.ns_seed import generate_and_insert_seed, normalize_goal

logger = logging.getLogger(__name__)


async def run_turn(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    user_utterance: str,
    background_tasks: BackgroundTasks,
) -> AsyncGenerator[dict, None]:
    """
    Execute one turn. Yields SSE event dicts:
      {type: 'text', data: <chunk>}
      {type: 'meta', data: {...}}
      {type: 'end', data: {...}}
      {type: 'error', data: {...}}
    """
    # 1. Load session state
    state = await _load_turn_state(db, session_id)
    if state is None:
        yield {"type": "error", "data": {"error": "세션을 찾을 수 없어요"}}
        return

    # 2. Persist user message
    await _append_message(db, session_id, state["next_index"], "user", user_utterance, None, None, None)

    # 3. Run planner
    try:
        planner_out = await run_planner(
            user_utterance=user_utterance,
            current_node=state["current_node"],
            current_mode=state["current_mode"],
            mastery=state["mastery"],
            recent_messages=state["recent_messages"],
            rag_hits=[],  # will be filled if retrieve_memory runs
            curriculum_context=state["curriculum_context"],
            turn_count=state["turn_count"],
        )
    except Exception as e:
        logger.exception("planner failed")
        yield {"type": "error", "data": {"error": "잠깐 연결이 끊겼어요. 다시 말씀해주세요."}}
        return

    # 4. Evaluate answer (if applicable) — update proficiency BEFORE other tools
    proficiency_after = None
    if planner_out["intent"] == "answer" and planner_out["evaluation"] and state["current_node"]:
        ev = planner_out["evaluation"]
        proficiency_after = await tool_evaluate_answer(
            db=db,
            user_id=user_id,
            node_id=state["current_node"]["id"],
            delta=int(ev.get("proficiency_delta", 0)),
            correct=bool(ev.get("correct", False)),
            mode=state["current_mode"],
        )

    # 5. Execute actions
    node_changed_to = None
    rag_hits = []
    assistant_reply_parts: list[str] = []

    for action in planner_out["actions"]:
        tool = action.get("tool")
        args = action.get("args") or {}

        try:
            if tool == "retrieve_memory":
                rag_hits = await tool_retrieve_memory(
                    db, user_id, args.get("query", ""),
                    state["current_node"]["id"] if state["current_node"] else None,
                )

            elif tool == "explain_concept" and state["current_node"]:
                text_out = await tool_explain_concept(
                    state["current_node"]["title"],
                    state["current_node"]["description"],
                    state["mastery"]["proficiency"] if state["mastery"] else 0,
                )
                assistant_reply_parts.append(text_out)

            elif tool == "quiz" and state["current_node"]:
                text_out = await tool_quiz(
                    state["current_node"]["title"],
                    state["mastery"]["proficiency"] if state["mastery"] else 0,
                    args.get("difficulty", "medium"),
                )
                assistant_reply_parts.append(text_out)

            elif tool == "ask_probing" and state["current_node"]:
                text_out = await tool_ask_probing(
                    state["current_node"]["title"],
                    args.get("hint", ""),
                    state["mastery"]["proficiency"] if state["mastery"] else 0,
                )
                assistant_reply_parts.append(text_out)

            elif tool == "pivot_topic" and state["goal_id"]:
                target = args.get("target") or planner_out.get("pivot_target") or ""
                if target:
                    new_node, message = await tool_pivot_topic(
                        db=db,
                        goal_id=state["goal_id"],
                        candidate_nodes=state["all_nodes"],
                        target=target,
                        current_node_title=state["current_node"]["title"] if state["current_node"] else "",
                    )
                    node_changed_to = new_node
                    assistant_reply_parts.append(message)

            elif tool == "extend_curriculum" and state["goal_id"]:
                await tool_extend_curriculum(
                    db=db,
                    goal_id=state["goal_id"],
                    proposed_title=args.get("proposed_title", ""),
                    rationale=args.get("rationale", ""),
                    root_titles=[n["title"] for n in state["all_nodes"] if n.get("depth_level") == 0],
                    goal_title=state["goal_title"] or "",
                )
                # Don't auto-switch; planner decides if this should become current_node

            elif tool == "suggest_end":
                topics = [n["title"] for n in state["all_nodes_in_session"]]
                text_out = await tool_suggest_end(topics, state["turn_count"], state["briefing_notes"])
                assistant_reply_parts.append(text_out)

            elif tool == "create_goal":
                title = (args.get("title") or "").strip()
                if title:
                    # 이미 active 목표가 있으면 재사용 (unique 제약 learning_goals_active_per_user)
                    existing = (await db.execute(
                        text("SELECT id FROM learning_goals WHERE user_id=:u AND status='active' LIMIT 1"),
                        {"u": user_id},
                    )).one_or_none()

                    if existing is None:
                        result = await db.execute(
                            text("""
                                INSERT INTO learning_goals (user_id, title, normalized_goal, status)
                                VALUES (:u, :t, :n, 'active')
                                RETURNING id
                            """),
                            {"u": user_id, "t": title, "n": normalize_goal(title)},
                        )
                        row = result.one()
                        new_goal_id = str(row.id)
                        # Schedule seed generation in background — user doesn't wait
                        background_tasks.add_task(_run_seed_bg, new_goal_id, title)
                    else:
                        new_goal_id = str(existing.id)

                    await db.execute(
                        text("UPDATE learning_sessions SET goal_id=:g WHERE id=:s"),
                        {"g": new_goal_id, "s": session_id},
                    )
                    await db.commit()

            elif tool == "generate_immediate_reply":
                text_out = args.get("text", "").strip()
                if text_out:
                    assistant_reply_parts.append(text_out)

        except Exception as e:
            logger.exception(f"tool {tool} failed")

    # 6. Stream assistant reply
    final_reply = " ".join(p for p in assistant_reply_parts if p).strip()
    if not final_reply:
        final_reply = "네, 계속 해볼까요?"

    yield {"type": "text", "data": final_reply}

    # 7. Persist assistant message + state updates
    await _append_message(
        db, session_id, state["next_index"] + 1,
        "assistant", final_reply, planner_out["next_mode"],
        {"actions": planner_out["actions"], "planner": {
            "intent": planner_out["intent"],
            "evaluation": planner_out["evaluation"],
            "briefing_note": planner_out["briefing_note"],
        }},
        (node_changed_to or state["current_node"] or {}).get("id"),
    )
    await db.execute(
        text("UPDATE learning_sessions SET turn_count = turn_count + 1 WHERE id=:s"),
        {"s": session_id},
    )
    await db.commit()

    # 8. meta event
    yield {
        "type": "meta",
        "data": {
            "mode": planner_out["next_mode"],
            "intent": planner_out["intent"],
            "nodeChangedTo": (
                {"id": node_changed_to["id"], "title": node_changed_to["title"]}
                if node_changed_to else None
            ),
            "proficiencyAfter": proficiency_after,
            "shouldSuggestEnd": planner_out["should_suggest_end"],
        },
    }

    yield {"type": "end", "data": {"turnCount": state["turn_count"] + 1}}


async def _run_seed_bg(goal_id: str, goal_title: str) -> None:
    """Background: generate seed curriculum. Uses its own DB session."""
    from app.database import async_session
    async with async_session() as db:
        try:
            await generate_and_insert_seed(db, goal_id, goal_title)
        except Exception:
            logger.exception("seed generation failed for goal_id=%s", goal_id)


async def _load_turn_state(db: AsyncSession, session_id: str) -> dict | None:
    """Load everything planner needs: session, goal, current_node candidate, mastery, history."""
    sess_row = (await db.execute(
        text("SELECT user_id, goal_id, turn_count FROM learning_sessions WHERE id=:s AND status='active'"),
        {"s": session_id},
    )).one_or_none()
    if sess_row is None:
        return None

    user_id = sess_row.user_id
    goal_id = str(sess_row.goal_id) if sess_row.goal_id else None
    turn_count = sess_row.turn_count

    # Last assistant message index
    last_idx_row = (await db.execute(
        text("SELECT COALESCE(MAX(message_index), -1) AS idx FROM learning_messages WHERE session_id=:s"),
        {"s": session_id},
    )).one()
    next_index = last_idx_row.idx + 1

    # Recent messages
    recent_rows = (await db.execute(
        text("SELECT role, content FROM learning_messages WHERE session_id=:s ORDER BY message_index DESC LIMIT 6"),
        {"s": session_id},
    )).fetchall()
    recent_messages = [{"role": r.role, "content": r.content} for r in reversed(recent_rows)]

    # Current node: last assistant message's node_id, or null
    cur_node_row = (await db.execute(
        text("""
            SELECT cn.id, cn.title, cn.description, cn.depth_level, cn.keywords
            FROM learning_messages lm
            JOIN curriculum_nodes cn ON cn.id = lm.node_id
            WHERE lm.session_id=:s AND lm.role='assistant' AND lm.node_id IS NOT NULL
            ORDER BY lm.message_index DESC LIMIT 1
        """),
        {"s": session_id},
    )).one_or_none()

    current_node = None
    if cur_node_row:
        current_node = {
            "id": str(cur_node_row.id),
            "title": cur_node_row.title,
            "description": cur_node_row.description,
            "depth_level": cur_node_row.depth_level,
            "keywords": list(cur_node_row.keywords) if cur_node_row.keywords else [],
        }

    # Mastery
    mastery = None
    if current_node:
        m_row = (await db.execute(
            text("SELECT proficiency, success_count, failure_count, streak_count, last_mode FROM node_mastery WHERE user_id=:u AND node_id=:n"),
            {"u": user_id, "n": current_node["id"]},
        )).one_or_none()
        if m_row:
            mastery = {
                "proficiency": m_row.proficiency,
                "success_count": m_row.success_count,
                "failure_count": m_row.failure_count,
                "streak_count": m_row.streak_count,
                "last_mode": m_row.last_mode,
            }

    # Determine mode from proficiency
    current_mode = "onboarding"
    if goal_id:
        p = (mastery or {}).get("proficiency", 0)
        if p < 30:
            current_mode = "tutoring"
        elif p < 70:
            current_mode = "quiz"
        else:
            current_mode = "socratic"

    # All nodes for goal (for pivot matching)
    all_nodes = []
    goal_title = None
    if goal_id:
        g_row = (await db.execute(
            text("SELECT title FROM learning_goals WHERE id=:g"),
            {"g": goal_id},
        )).one_or_none()
        goal_title = g_row.title if g_row else None

        n_rows = (await db.execute(
            text("SELECT id, title, description, depth_level, keywords FROM curriculum_nodes WHERE goal_id=:g"),
            {"g": goal_id},
        )).fetchall()
        all_nodes = [
            {
                "id": str(r.id),
                "title": r.title,
                "description": r.description,
                "depth_level": r.depth_level,
                "keywords": list(r.keywords) if r.keywords else [],
            }
            for r in n_rows
        ]

    root_nodes = [n for n in all_nodes if n["depth_level"] == 0]

    # Nodes covered in this session
    nodes_in_sess_rows = (await db.execute(
        text("""
            SELECT DISTINCT cn.id, cn.title FROM learning_messages lm
            JOIN curriculum_nodes cn ON cn.id = lm.node_id
            WHERE lm.session_id=:s
        """),
        {"s": session_id},
    )).fetchall()
    all_nodes_in_session = [{"id": str(r.id), "title": r.title} for r in nodes_in_sess_rows]

    # Briefing notes collected so far
    notes_rows = (await db.execute(
        text("""
            SELECT tool_calls -> 'planner' ->> 'briefing_note' AS note
            FROM learning_messages
            WHERE session_id=:s AND role='assistant' AND tool_calls IS NOT NULL
            ORDER BY message_index
        """),
        {"s": session_id},
    )).fetchall()
    briefing_notes = [r.note for r in notes_rows if r.note]

    return {
        "user_id": user_id,
        "goal_id": goal_id,
        "goal_title": goal_title,
        "current_node": current_node,
        "current_mode": current_mode,
        "mastery": mastery,
        "recent_messages": recent_messages,
        "curriculum_context": {
            "root_nodes": [{"id": n["id"], "title": n["title"]} for n in root_nodes[:5]],
            "all_node_count": len(all_nodes),
        },
        "all_nodes": all_nodes,
        "all_nodes_in_session": all_nodes_in_session,
        "turn_count": turn_count,
        "next_index": next_index,
        "briefing_notes": briefing_notes,
    }


async def _append_message(
    db: AsyncSession,
    session_id: str,
    message_index: int,
    role: str,
    content: str,
    mode: str | None,
    tool_calls: dict | None,
    node_id: str | None,
) -> None:
    await db.execute(
        text("""
            INSERT INTO learning_messages (session_id, message_index, role, content, mode, tool_calls, node_id)
            VALUES (:s, :i, :r, :c, :m, CAST(:t AS jsonb), :n)
        """),
        {
            "s": session_id,
            "i": message_index,
            "r": role,
            "c": content,
            "m": mode,
            "t": json.dumps(tool_calls) if tool_calls else None,
            "n": node_id,
        },
    )
