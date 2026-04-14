from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
ALLOWED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}


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


@router.post("/api/job-posting/extract-image")
async def extract_image_text(
    image: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    from app.services.job_posting import extract_text_from_image

    mime = (image.content_type or "").lower()
    if mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(
            status_code=400,
            detail={"error": "지원하지 않는 이미지 형식입니다 (png/jpeg/webp)"},
        )

    content = await image.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(
            status_code=413,
            detail={"error": "이미지 크기가 너무 큽니다 (최대 5MB)"},
        )
    if len(content) == 0:
        raise HTTPException(
            status_code=400,
            detail={"error": "빈 이미지 파일입니다"},
        )

    b64 = base64.b64encode(content).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"

    try:
        text = await extract_text_from_image(data_url)
    except Exception:
        logger.exception("Failed to extract text from JD image")
        raise HTTPException(
            status_code=500,
            detail={"error": "텍스트 추출에 실패했습니다"},
        )

    return {"text": text}

