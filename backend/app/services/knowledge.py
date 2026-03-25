from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.learning import UserKnowledge, Topic


async def get_user_knowledge(
    db: AsyncSession,
    *,
    user_id: str,
    subject_id: str | None = None,
) -> list[UserKnowledge]:
    """Return all UserKnowledge rows for a user, ordered by proficiency ascending."""
    stmt = (
        select(UserKnowledge)
        .options(selectinload(UserKnowledge.topic))
        .where(UserKnowledge.user_id == user_id)
        .order_by(UserKnowledge.proficiency.asc())
    )
    if subject_id:
        stmt = stmt.join(Topic).where(Topic.subject_id == subject_id)

    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_weak_topics(
    db: AsyncSession,
    *,
    user_id: str,
    subject_id: str,
    limit: int = 5,
) -> list[UserKnowledge]:
    """Return topics with proficiency < 60, ordered by lowest first."""
    stmt = (
        select(UserKnowledge)
        .options(selectinload(UserKnowledge.topic))
        .join(Topic)
        .where(
            UserKnowledge.user_id == user_id,
            Topic.subject_id == subject_id,
            UserKnowledge.proficiency < 60,
        )
        .order_by(UserKnowledge.proficiency.asc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_due_for_review(
    db: AsyncSession,
    *,
    user_id: str,
    limit: int = 10,
) -> list[UserKnowledge]:
    """Return topics due for review (nextReviewAt <= now)."""
    now = datetime.now(timezone.utc)
    stmt = (
        select(UserKnowledge)
        .options(
            selectinload(UserKnowledge.topic).selectinload(Topic.subject)
        )
        .where(
            UserKnowledge.user_id == user_id,
            UserKnowledge.next_review_at <= now,
        )
        .order_by(UserKnowledge.next_review_at.asc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def update_knowledge(
    db: AsyncSession,
    *,
    user_id: str,
    topic_id: str,
    was_correct: bool,
    score: int,
    metadata: dict | None = None,
) -> UserKnowledge:
    """SM-2 simplified algorithm for updating knowledge proficiency."""
    stmt = select(UserKnowledge).where(
        UserKnowledge.user_id == user_id,
        UserKnowledge.topic_id == topic_id,
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()

    now = datetime.now(timezone.utc)

    if not existing:
        # First learning
        proficiency = round(score * 0.5) if was_correct else 10
        next_review = now + timedelta(days=3 if was_correct else 1)

        uk = UserKnowledge(
            id=str(uuid4()),
            user_id=user_id,
            topic_id=topic_id,
            proficiency=proficiency,
            success_count=1 if was_correct else 0,
            failure_count=0 if was_correct else 1,
            streak_count=1 if was_correct else 0,
            last_practiced=now,
            next_review_at=next_review,
        )
        if metadata:
            uk.metadata_ = metadata
        db.add(uk)
        await db.flush()
        return uk

    # Update existing
    if was_correct:
        new_proficiency = round(existing.proficiency + (100 - existing.proficiency) * 0.2)
        new_streak = existing.streak_count + 1
        # nextReview = now + base(1 day) * 1.5^streak, capped at 30 days
        interval_days = min(1 * math.pow(1.5, new_streak), 30)
        next_review = now + timedelta(days=interval_days)
        existing.success_count = (existing.success_count or 0) + 1
    else:
        new_proficiency = round(existing.proficiency - existing.proficiency * 0.15)
        new_streak = 0
        next_review = now + timedelta(days=1)
        existing.failure_count = (existing.failure_count or 0) + 1

    new_proficiency = max(0, min(100, new_proficiency))

    existing.proficiency = new_proficiency
    existing.streak_count = new_streak
    existing.last_practiced = now
    existing.next_review_at = next_review
    if metadata:
        existing.metadata_ = metadata

    await db.flush()
    return existing


async def get_subject_proficiency(
    db: AsyncSession,
    *,
    user_id: str,
    subject_id: str,
) -> int:
    """Average proficiency for all topics in a subject."""
    stmt = (
        select(func.avg(UserKnowledge.proficiency))
        .join(Topic)
        .where(
            UserKnowledge.user_id == user_id,
            Topic.subject_id == subject_id,
        )
    )
    result = await db.execute(stmt)
    avg = result.scalar()
    return round(avg) if avg is not None else 0
