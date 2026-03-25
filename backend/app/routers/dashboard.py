from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.user import User
from app.models.resume import Resume
from app.models.interview import InterviewSession
from app.models.activity import ActivityLog, ActivityItem
from app.models.enums import SessionStatus
from app.services.analytics import (
    get_growth_data,
    get_category_performance,
    get_session_history,
    get_activity_history,
)

router = APIRouter()


@router.get("/api/dashboard")
async def dashboard(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # User info
    user_result = await db.execute(
        select(User.credit_balance, User.free_trial_used, User.name)
        .where(User.id == user.id)
    )
    user_row = user_result.one_or_none()

    # Session count
    session_count_result = await db.execute(
        select(func.count()).where(InterviewSession.user_id == user.id)
    )
    session_count = session_count_result.scalar() or 0

    # Resume count
    resume_count_result = await db.execute(
        select(func.count()).where(Resume.user_id == user.id)
    )
    resume_count = resume_count_result.scalar() or 0

    # Recent sessions (last 5)
    recent_result = await db.execute(
        select(InterviewSession)
        .where(InterviewSession.user_id == user.id)
        .order_by(InterviewSession.created_at.desc())
        .limit(5)
    )
    recent_sessions = [
        {
            "id": s.id,
            "type": s.type,
            "overallScore": s.overall_score,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
            "categories": s.categories,
        }
        for s in recent_result.scalars().all()
    ]

    # Growth & performance
    growth_data = await get_growth_data(db, user.id)
    category_performance = await get_category_performance(db, user.id)

    return {
        "sessionCount": session_count,
        "recentSessions": recent_sessions,
        "resumeCount": resume_count,
        "creditBalance": user_row.credit_balance if user_row else 0,
        "freeTrialUsed": user_row.free_trial_used if user_row else False,
        "userName": user_row.name if user_row else None,
        "growthData": growth_data,
        "categoryPerformance": category_performance,
    }


@router.get("/api/history")
async def history(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
):
    sessions = await get_session_history(db, user.id, limit)
    activities = await get_activity_history(db, user.id, limit)

    # Merge and sort by createdAt descending
    merged = sessions + activities
    merged.sort(key=lambda x: x.get("createdAt", "") or "", reverse=True)

    return merged[:limit]


@router.get("/api/activity/{activity_id}")
async def get_activity(
    activity_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(ActivityLog)
        .options(
            selectinload(ActivityLog.resume),
            selectinload(ActivityLog.items),
        )
        .where(ActivityLog.id == activity_id, ActivityLog.user_id == user.id)
    )
    activity = result.scalar_one_or_none()
    if not activity:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Activity not found")

    return {
        "id": activity.id,
        "userId": activity.user_id,
        "type": activity.type,
        "resumeId": activity.resume_id,
        "metadata": activity.metadata_,
        "createdAt": activity.created_at.isoformat() if activity.created_at else None,
        "resume": {"name": activity.resume.name} if activity.resume else None,
        "items": [
            {
                "id": item.id,
                "index": item.index,
                "question": item.question,
                "answer": item.answer,
                "extra": item.extra,
            }
            for item in sorted(activity.items, key=lambda i: i.index)
        ],
    }
