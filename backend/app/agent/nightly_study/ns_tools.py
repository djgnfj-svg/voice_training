from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.nightly_study.ns_srs import apply_proficiency_delta, compute_next_review


async def tool_evaluate_answer(
    db: AsyncSession,
    user_id: str,
    node_id: str,
    delta: int,
    correct: bool,
    mode: str,
) -> int:
    """Apply proficiency delta and update spaced-review state."""
    row = (await db.execute(
        text("""
            SELECT proficiency, success_count, failure_count, streak_count
            FROM node_mastery
            WHERE user_id=:u AND node_id=:n
        """),
        {"u": user_id, "n": node_id},
    )).one_or_none()

    now = datetime.now(timezone.utc)
    if row is None:
        new_prof = apply_proficiency_delta(0, delta)
        success = 1 if correct else 0
        failure = 0 if correct else 1
        streak = 1 if correct else 0
        await db.execute(
            text("""
                INSERT INTO node_mastery
                    (user_id, node_id, proficiency, success_count, failure_count,
                     streak_count, last_studied_at, next_review_at, last_mode)
                VALUES (:u, :n, :p, :s, :f, :sc, :ls, :nr, :lm)
            """),
            {
                "u": user_id,
                "n": node_id,
                "p": new_prof,
                "s": success,
                "f": failure,
                "sc": streak,
                "ls": now,
                "nr": compute_next_review(new_prof, now),
                "lm": mode,
            },
        )
    else:
        new_prof = apply_proficiency_delta(row.proficiency, delta)
        success = row.success_count + (1 if correct else 0)
        failure = row.failure_count + (0 if correct else 1)
        streak = (row.streak_count + 1) if correct else 0
        await db.execute(
            text("""
                UPDATE node_mastery
                SET proficiency=:p, success_count=:s, failure_count=:f,
                    streak_count=:sc, last_studied_at=:ls,
                    next_review_at=:nr, last_mode=:lm
                WHERE user_id=:u AND node_id=:n
            """),
            {
                "p": new_prof,
                "s": success,
                "f": failure,
                "sc": streak,
                "ls": now,
                "nr": compute_next_review(new_prof, now),
                "lm": mode,
                "u": user_id,
                "n": node_id,
            },
        )

    await db.commit()
    return new_prof
