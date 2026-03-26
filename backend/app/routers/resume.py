from __future__ import annotations

from uuid import uuid4

import pymupdf
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.resume import Resume

router = APIRouter()

MAX_PDF_SIZE = 10 * 1024 * 1024  # 10MB


@router.get("/api/resume")
async def list_resumes(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Resume)
        .where(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
    )
    resumes = result.scalars().all()
    return [
        {
            "id": r.id,
            "name": r.name,
            "skills": (r.parsed_data or {}).get("skills", []) if isinstance(r.parsed_data, dict) else [],
            "createdAt": r.created_at.isoformat() if r.created_at else None,
        }
        for r in resumes
    ]


@router.get("/api/resume/{resume_id}")
async def get_resume(
    resume_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Resume).where(Resume.id == resume_id, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")
    return {
        "id": resume.id,
        "userId": resume.user_id,
        "name": resume.name,
        "parsedData": resume.parsed_data,
        "fileUrl": resume.file_url,
        "createdAt": resume.created_at.isoformat() if resume.created_at else None,
        "updatedAt": resume.updated_at.isoformat() if resume.updated_at else None,
    }


@router.post("/api/resume")
async def upload_resume(
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 업로드할 수 있습니다.")

    content = await file.read()
    if len(content) > MAX_PDF_SIZE:
        raise HTTPException(status_code=413, detail="PDF 파일이 너무 큽니다 (최대 10MB)")

    try:
        doc = pymupdf.open(stream=content, filetype="pdf")
        text = "".join(page.get_text() for page in doc)
        doc.close()
    except Exception:
        raise HTTPException(status_code=400, detail="PDF 파일을 읽을 수 없습니다.")

    if not text.strip():
        raise HTTPException(status_code=400, detail="PDF에서 텍스트를 추출할 수 없습니다.")

    # Strip .pdf extension for the display name
    name = file.filename.rsplit(".", 1)[0]

    resume = Resume(
        id=str(uuid4()),
        user_id=user.id,
        name=name,
        parsed_data={"rawText": text},
    )
    db.add(resume)
    await db.commit()
    await db.refresh(resume)

    return {
        "id": resume.id,
        "userId": resume.user_id,
        "name": resume.name,
        "parsedData": resume.parsed_data,
        "fileUrl": resume.file_url,
        "createdAt": resume.created_at.isoformat() if resume.created_at else None,
        "updatedAt": resume.updated_at.isoformat() if resume.updated_at else None,
    }


class ResumeUpdateRequest(BaseModel):
    name: str


@router.patch("/api/resume/{resume_id}")
async def update_resume(
    resume_id: str,
    body: ResumeUpdateRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Resume).where(Resume.id == resume_id, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")

    resume.name = body.name
    await db.commit()
    await db.refresh(resume)

    return {
        "id": resume.id,
        "userId": resume.user_id,
        "name": resume.name,
        "parsedData": resume.parsed_data,
        "fileUrl": resume.file_url,
        "createdAt": resume.created_at.isoformat() if resume.created_at else None,
        "updatedAt": resume.updated_at.isoformat() if resume.updated_at else None,
    }


@router.delete("/api/resume/{resume_id}")
async def delete_resume(
    resume_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Resume).where(Resume.id == resume_id, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")

    try:
        await db.delete(resume)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="이 이력서와 연결된 면접 기록이 있어 삭제할 수 없습니다.",
        )

    return {"success": True}
