from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import DailyProgress


def _date_only(d: date | None = None) -> date:
    """Return a date object (no time component)."""
    if d is None:
        return datetime.now(timezone.utc).date()
    if isinstance(d, datetime):
        return d.date()
    return d


async def record_progress(
    db: AsyncSession,
    *,
    user_id: str,
    session_data: dict,
) -> None:
    """Upsert daily progress for the user.

    session_data keys:
      subjectId, totalQuestions, correctCount, durationSeconds, topicsStudied
    """
    today = _date_only()

    stmt = select(DailyProgress).where(
        DailyProgress.user_id == user_id,
        DailyProgress.date == today,
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()

    subject_id = session_data.get("subjectId", "nightly-study")
    total_questions = session_data.get("totalQuestions", 0)
    correct_count = session_data.get("correctCount", 0)
    duration_seconds = session_data.get("durationSeconds", 0)
    topics_studied = session_data.get("topicsStudied", [])

    if existing:
        existing.total_sessions = (existing.total_sessions or 0) + 1
        existing.total_questions = (existing.total_questions or 0) + total_questions
        existing.total_correct = (existing.total_correct or 0) + correct_count
        existing.total_minutes = (existing.total_minutes or 0) + _ceil_minutes(duration_seconds)
        # Append to arrays
        prev_topics = existing.topics_studied or []
        existing.topics_studied = prev_topics + topics_studied
        prev_subjects = existing.subjects_studied or []
        existing.subjects_studied = prev_subjects + [subject_id]
    else:
        streak_day = await _calculate_streak_day(db, user_id=user_id)
        dp = DailyProgress(
            id=str(uuid4()),
            user_id=user_id,
            date=today,
            total_sessions=1,
            total_questions=total_questions,
            total_correct=correct_count,
            total_minutes=_ceil_minutes(duration_seconds),
            topics_studied=topics_studied,
            subjects_studied=[subject_id],
            streak_day=streak_day,
        )
        db.add(dp)

    await db.flush()


async def get_daily_progress(
    db: AsyncSession,
    *,
    user_id: str,
    target_date: date | None = None,
) -> DailyProgress | None:
    d = _date_only(target_date)
    stmt = select(DailyProgress).where(
        DailyProgress.user_id == user_id,
        DailyProgress.date == d,
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_streak(
    db: AsyncSession,
    *,
    user_id: str,
) -> int:
    """Count consecutive days with at least 1 session.

    Uses a single query to fetch up to 365 days of progress,
    then calculates the streak in Python.
    """
    today = _date_only()
    cutoff = today - timedelta(days=365)

    stmt = (
        select(DailyProgress.date, DailyProgress.total_sessions)
        .where(
            DailyProgress.user_id == user_id,
            DailyProgress.date >= cutoff,
            DailyProgress.date <= today,
            DailyProgress.total_sessions > 0,
        )
        .order_by(DailyProgress.date.desc())
    )
    result = await db.execute(stmt)
    active_dates = {row.date for row in result.all()}

    streak = 0
    check_date = today

    # If today has no progress, start from yesterday
    if check_date not in active_dates:
        check_date = today - timedelta(days=1)

    while check_date in active_dates:
        streak += 1
        check_date -= timedelta(days=1)

    return streak


async def get_weekly_overview(
    db: AsyncSession,
    *,
    user_id: str,
) -> list[dict]:
    """Return last 7 days of progress."""
    today = _date_only()
    week_ago = today - timedelta(days=7)

    stmt = (
        select(DailyProgress)
        .where(
            DailyProgress.user_id == user_id,
            DailyProgress.date >= week_ago,
            DailyProgress.date <= today,
        )
        .order_by(DailyProgress.date.asc())
    )
    result = await db.execute(stmt)
    rows = {str(r.date): r for r in result.scalars().all()}

    days = []
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        d_str = str(d)
        found = rows.get(d_str)
        days.append({
            "date": d_str,
            "totalSessions": found.total_sessions if found else 0,
            "totalQuestions": found.total_questions if found else 0,
            "totalCorrect": found.total_correct if found else 0,
            "totalMinutes": found.total_minutes if found else 0,
        })

    return days


async def _calculate_streak_day(
    db: AsyncSession,
    *,
    user_id: str,
) -> int:
    streak = await get_streak(db, user_id=user_id)
    return streak + 1  # Including today


def _ceil_minutes(seconds: int) -> int:
    if seconds <= 0:
        return 0
    return -(-seconds // 60)  # ceil division
