from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


class JobPostingRequest(BaseModel):
    rawText: str = Field(min_length=10)


@router.post("/api/job-posting")
async def analyze_job_posting(
    body: JobPostingRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.job_posting import analyze_job_posting as analyze

    try:
        result = await analyze(db, user_id=user.id, raw_text=body.rawText)
        return result
    except Exception as e:
        logger.exception("Failed to analyze job posting")
        raise HTTPException(500, "Internal server error")


@router.get("/api/job-posting")
async def list_job_postings(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.job_posting import get_user_job_postings

    return await get_user_job_postings(db, user_id=user.id)


@router.post("/api/job-posting/{posting_id}/research")
async def deep_research(
    posting_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.services.job_posting import do_deep_research

    try:
        result = await do_deep_research(db, posting_id, user.id)
        return result
    except ValueError as e:
        code = str(e)
        if code == "NOT_FOUND":
            raise HTTPException(404, {"error": code})
        if code == "INSUFFICIENT_CREDITS":
            raise HTTPException(402, {"error": code, "code": code})
        if code == "TAVILY_NOT_AVAILABLE":
            raise HTTPException(503, {"error": code})
        raise HTTPException(400, {"error": code})
