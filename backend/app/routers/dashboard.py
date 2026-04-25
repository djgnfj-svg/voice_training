from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.activity import ActivityItem, ActivityLog
from app.models.agent_interview import AgentInterviewSession
from app.models.learning_coach import LearningSession
from app.models.user import User
from app.services.analytics import get_activity_history, get_session_history

router = APIRouter()


@router.get("/api/dashboard")
async def dashboard(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_result = await db.execute(select(User.name).where(User.id == user.id))
    user_row = user_result.one_or_none()

    interview_count_result = await db.execute(
        select(func.count()).where(
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status == "completed",
        )
    )
    interview_count = interview_count_result.scalar() or 0

    learning_count_result = await db.execute(
        select(func.count()).where(
            LearningSession.user_id == user.id,
            LearningSession.status == "completed",
        )
    )
    learning_count = learning_count_result.scalar() or 0

    interview_result = await db.execute(
        select(AgentInterviewSession)
        .where(
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status.in_(["completed", "in_progress"]),
        )
        .order_by(AgentInterviewSession.created_at.desc())
        .limit(5)
    )
    interview_items = [
        {
            "kind": "interview",
            "id": s.id,
            "title": "AI 코치 면접",
            "subtitle": f"{s.total_questions}문제" + (f" · {round(s.overall_score)}점" if s.overall_score else ""),
            "status": s.status,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
        }
        for s in interview_result.scalars().all()
    ]

    learning_result = await db.execute(
        select(LearningSession)
        .where(
            LearningSession.user_id == user.id,
            LearningSession.status == "completed",
        )
        .order_by(LearningSession.started_at.desc())
        .limit(5)
    )
    learning_items = [
        {
            "kind": "learning",
            "id": str(s.id),
            "title": "오늘의 학습",
            "subtitle": s.summary[:50] + "..." if s.summary and len(s.summary) > 50 else (s.summary or "학습 세션"),
            "status": s.status,
            "createdAt": s.started_at.isoformat() if s.started_at else None,
        }
        for s in learning_result.scalars().all()
    ]

    recent_activity = interview_items + learning_items
    recent_activity.sort(key=lambda x: x.get("createdAt") or "", reverse=True)

    return {
        "userName": user_row.name if user_row else None,
        "stats": {
            "interviewCount": interview_count,
            "learningCount": learning_count,
        },
        "recentActivity": recent_activity[:10],
    }


@router.get("/api/history")
async def history(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
):
    sessions = await get_session_history(db, user.id, limit)
    activities = await get_activity_history(db, user.id, limit)
    merged = sessions + activities
    merged.sort(key=lambda x: x.get("createdAt", "") or "", reverse=True)
    return merged[:limit]


@router.get("/api/activity/{activity_id}")
async def get_activity(
    activity_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi import HTTPException
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
        raise HTTPException(status_code=404, detail={"error": "활동을 찾을 수 없습니다."})

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
