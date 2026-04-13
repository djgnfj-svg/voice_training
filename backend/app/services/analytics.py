from __future__ import annotations

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.interview import InterviewSession, InterviewAnswer, JobPosting
from app.models.agent_interview import AgentInterviewSession, AgentInterviewMessage
from app.models.resume import Resume
from app.models.activity import ActivityLog, ActivityItem


async def get_session_history(db: AsyncSession, user_id: str, limit: int = 20) -> list[dict]:
    # ── 레거시 InterviewSession ──
    legacy_answer_count_sub = (
        select(
            InterviewAnswer.session_id,
            func.count().label("cnt"),
        )
        .group_by(InterviewAnswer.session_id)
        .subquery()
    )

    legacy_result = await db.execute(
        select(InterviewSession, func.coalesce(legacy_answer_count_sub.c.cnt, 0).label("answer_count"))
        .outerjoin(legacy_answer_count_sub, InterviewSession.id == legacy_answer_count_sub.c.session_id)
        .options(
            selectinload(InterviewSession.resume),
            selectinload(InterviewSession.job_posting),
        )
        .where(InterviewSession.user_id == user_id)
        .order_by(InterviewSession.created_at.desc())
        .limit(limit)
    )
    legacy_sessions = [
        {
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
            "_sortKey": s.created_at,
        }
        for s, answer_count in legacy_result.all()
    ]

    # ── AgentInterviewSession ──
    agent_answer_count_sub = (
        select(
            AgentInterviewMessage.session_id,
            func.count().label("cnt"),
        )
        .where(AgentInterviewMessage.role == "user_answer")
        .group_by(AgentInterviewMessage.session_id)
        .subquery()
    )

    agent_result = await db.execute(
        select(
            AgentInterviewSession,
            Resume.name.label("resume_name"),
            JobPosting.parsed_data.label("job_posting_data"),
            func.coalesce(agent_answer_count_sub.c.cnt, 0).label("answer_count"),
        )
        .outerjoin(Resume, AgentInterviewSession.resume_id == Resume.id)
        .outerjoin(JobPosting, AgentInterviewSession.job_posting_id == JobPosting.id)
        .outerjoin(agent_answer_count_sub, AgentInterviewSession.id == agent_answer_count_sub.c.session_id)
        .where(AgentInterviewSession.user_id == user_id)
        .order_by(AgentInterviewSession.created_at.desc())
        .limit(limit)
    )
    agent_sessions = [
        {
            "_kind": "session",
            "id": s.id,
            "userId": s.user_id,
            # 프론트가 대문자로 비교하므로 통일
            "status": (s.status or "").upper(),
            "type": "ai-coach",
            "overallScore": s.overall_score,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
            "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
            "resumeName": resume_name,
            "jobPostingData": job_posting_data,
            "answerCount": answer_count,
            "_sortKey": s.created_at,
        }
        for s, resume_name, job_posting_data, answer_count in agent_result.all()
    ]

    # ── 병합 후 createdAt 내림차순, limit ──
    merged = legacy_sessions + agent_sessions
    merged.sort(key=lambda x: x["_sortKey"], reverse=True)
    merged = merged[:limit]
    for m in merged:
        m.pop("_sortKey", None)
    return merged


async def get_activity_history(db: AsyncSession, user_id: str, limit: int = 20) -> list[dict]:
    item_count_sub = (
        select(
            ActivityItem.activity_log_id,
            func.count().label("cnt"),
        )
        .group_by(ActivityItem.activity_log_id)
        .subquery()
    )

    result = await db.execute(
        select(ActivityLog, func.coalesce(item_count_sub.c.cnt, 0).label("item_count"))
        .outerjoin(item_count_sub, ActivityLog.id == item_count_sub.c.activity_log_id)
        .options(selectinload(ActivityLog.resume))
        .where(ActivityLog.user_id == user_id)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
    )
    rows = result.all()

    return [
        {
            "_kind": "activity",
            "id": a.id,
            "userId": a.user_id,
            "type": a.type,
            "resumeId": a.resume_id,
            "metadata": a.metadata_,
            "createdAt": a.created_at.isoformat() if a.created_at else None,
            "resumeName": a.resume.name if a.resume else None,
            "itemCount": item_count,
        }
        for a, item_count in rows
    ]
