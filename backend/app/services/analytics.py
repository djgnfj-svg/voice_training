from __future__ import annotations

from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.interview import InterviewSession, InterviewAnswer
from app.models.activity import ActivityLog, ActivityItem
from app.models.enums import SessionStatus


async def get_growth_data(db: AsyncSession, user_id: str) -> list[dict]:
    result = await db.execute(
        select(InterviewSession)
        .where(
            InterviewSession.user_id == user_id,
            InterviewSession.status == SessionStatus.COMPLETED,
            InterviewSession.overall_score.isnot(None),
        )
        .order_by(InterviewSession.created_at.asc())
    )
    sessions = result.scalars().all()
    return [
        {
            "date": s.created_at.strftime("%Y-%m-%d") if s.created_at else None,
            "score": s.overall_score,
            "sessionId": s.id,
            "type": s.type,
        }
        for s in sessions
    ]


async def get_category_performance(db: AsyncSession, user_id: str) -> list[dict]:
    result = await db.execute(
        select(
            InterviewAnswer.question_source,
            func.avg(InterviewAnswer.overall_score).label("avg_score"),
            func.count().label("total"),
        )
        .join(InterviewSession, InterviewAnswer.session_id == InterviewSession.id)
        .where(
            InterviewSession.user_id == user_id,
            InterviewAnswer.overall_score.isnot(None),
        )
        .group_by(InterviewAnswer.question_source)
    )
    rows = result.all()
    return [
        {
            "category": row.question_source,
            "averageScore": round(float(row.avg_score), 1) if row.avg_score else 0,
            "totalQuestions": row.total,
        }
        for row in rows
    ]


async def get_session_history(db: AsyncSession, user_id: str, limit: int = 20) -> list[dict]:
    result = await db.execute(
        select(InterviewSession)
        .options(
            selectinload(InterviewSession.resume),
            selectinload(InterviewSession.job_posting),
        )
        .where(InterviewSession.user_id == user_id)
        .order_by(InterviewSession.created_at.desc())
        .limit(limit)
    )
    sessions = result.scalars().all()

    out = []
    for s in sessions:
        # Count answers
        count_result = await db.execute(
            select(func.count()).where(InterviewAnswer.session_id == s.id)
        )
        answer_count = count_result.scalar() or 0

        out.append({
            "_kind": "session",
            "id": s.id,
            "userId": s.user_id,
            "status": s.status,
            "type": s.type,
            "overallScore": s.overall_score,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
            "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
            "resumeName": s.resume.name if s.resume else None,
            "jobPostingData": s.job_posting.parsed_data if s.job_posting else None,
            "answerCount": answer_count,
        })
    return out


async def get_activity_history(db: AsyncSession, user_id: str, limit: int = 20) -> list[dict]:
    result = await db.execute(
        select(ActivityLog)
        .options(selectinload(ActivityLog.resume))
        .where(ActivityLog.user_id == user_id)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
    )
    logs = result.scalars().all()

    out = []
    for a in logs:
        count_result = await db.execute(
            select(func.count()).where(ActivityItem.activity_log_id == a.id)
        )
        item_count = count_result.scalar() or 0

        out.append({
            "_kind": "activity",
            "id": a.id,
            "userId": a.user_id,
            "type": a.type,
            "resumeId": a.resume_id,
            "metadata": a.metadata_,
            "createdAt": a.created_at.isoformat() if a.created_at else None,
            "resumeName": a.resume.name if a.resume else None,
            "itemCount": item_count,
        })
    return out
