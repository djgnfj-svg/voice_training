from __future__ import annotations

import json
import logging
from datetime import date
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm_json
from app.prompts.learning_coach import SESSION_SUMMARY_PROMPT
from app.agent.learning_coach.spaced_repetition import update_streak_state

logger = logging.getLogger(__name__)


async def generate_session_summary(
    db: AsyncSession,
    session_id: str,
) -> dict:
    """
    Returns {
        'summary': str,
        'highlights': {'headline', 'learned', 'improved'},
        'voice_briefing': str,
    }
    """
    # Collect messages
    msg_rows = (await db.execute(
        text("SELECT role, content FROM learning_messages WHERE session_id=:s ORDER BY message_index"),
        {"s": session_id},
    )).fetchall()
    transcript = "\n".join(
        f"{'유저' if r.role == 'user' else 'AI'}: {r.content}" for r in msg_rows
    )

    # Collect mastery changes in session
    user_row = (await db.execute(
        text("SELECT user_id FROM learning_sessions WHERE id=:s"),
        {"s": session_id},
    )).one()
    user_id = user_row.user_id

    mastery_rows = (await db.execute(
        text("""
            SELECT cn.title, nm.proficiency, nm.success_count, nm.failure_count
            FROM node_mastery nm
            JOIN curriculum_nodes cn ON cn.id = nm.node_id
            JOIN (
                SELECT DISTINCT node_id FROM learning_messages WHERE session_id=:s AND node_id IS NOT NULL
            ) used ON used.node_id = nm.node_id
            WHERE nm.user_id=:u
        """),
        {"s": session_id, "u": user_id},
    )).fetchall()

    mastery_changes = [
        {
            "title": r.title,
            "proficiency_now": r.proficiency,
            "success": r.success_count,
            "failure": r.failure_count,
        }
        for r in mastery_rows
    ]

    prompt = SESSION_SUMMARY_PROMPT.format(
        transcript=transcript[:10000],
        mastery_changes_json=json.dumps(mastery_changes, ensure_ascii=False),
    )

    try:
        # call_llm_json takes prompt as first positional arg
        result = await call_llm_json(prompt)
        summary = result.get("summary", "")
        highlights = result.get("highlights") or {}
        voice_briefing = result.get("voice_briefing", "")
    except Exception:
        logger.exception("summary LLM failed; falling back")
        summary = ""
        highlights = {
            "headline": "오늘 학습을 마쳤어요",
            "learned": [],
            "improved": [],
        }
        voice_briefing = "오늘의 학습을 마쳤어요. 수고하셨어요."

    # 서버에서도 learned는 success_count > 0인 노드 title만 허용한다.
    succeeded_titles = {m["title"] for m in mastery_changes if (m.get("success") or 0) > 0}
    raw_learned = highlights.get("learned") or []
    highlights["learned"] = [t for t in raw_learned if t in succeeded_titles][:3]

    return {"summary": summary, "highlights": highlights, "voice_briefing": voice_briefing}


async def update_streak_after_session(db: AsyncSession, user_id: str, today: date) -> dict:
    """Upsert learning_streaks. Returns the new state + isNewRecord flag."""
    row = (await db.execute(
        text("SELECT current_streak, longest_streak, total_sessions, total_nodes_learned, last_session_date FROM learning_streaks WHERE user_id=:u"),
        {"u": user_id},
    )).one_or_none()

    if row is None:
        current, longest = update_streak_state(0, 0, None, today)
        total_sessions = 1
    else:
        current, longest = update_streak_state(
            row.current_streak, row.longest_streak,
            row.last_session_date, today,
        )
        total_sessions = row.total_sessions + 1

    # total_nodes_learned = proficiency >= 70 count
    learned_row = (await db.execute(
        text("SELECT COUNT(*) AS c FROM node_mastery WHERE user_id=:u AND proficiency >= 70"),
        {"u": user_id},
    )).one()
    total_nodes_learned = learned_row.c

    is_new_record = (row is None) or (current > (row.longest_streak if row else 0))

    await db.execute(
        text("""
            INSERT INTO learning_streaks (user_id, current_streak, longest_streak, total_sessions, total_nodes_learned, last_session_date)
            VALUES (:u, :cur, :lng, :ts, :tn, :ld)
            ON CONFLICT (user_id) DO UPDATE SET
                current_streak=:cur, longest_streak=:lng, total_sessions=:ts,
                total_nodes_learned=:tn, last_session_date=:ld
        """),
        {"u": user_id, "cur": current, "lng": longest, "ts": total_sessions, "tn": total_nodes_learned, "ld": today},
    )
    await db.commit()

    return {
        "current": current,
        "longest": longest,
        "totalSessions": total_sessions,
        "totalNodesLearned": total_nodes_learned,
        "isNewRecord": is_new_record,
    }
