from __future__ import annotations

from uuid import uuid4

import pymupdf
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.interview.resume_memory import embed_resume
from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.lib.llm_client import call_llm_json
from app.models.resume import Resume
from app.prompts.resume import RESUME_PARSING_PROMPT

router = APIRouter()

MAX_PDF_SIZE = 10 * 1024 * 1024  # 10MB


@router.get("/api/resume")
async def list_resumes(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    detail: bool = Query(False),
):
    result = await db.execute(
        select(Resume)
        .where(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
    )
    resumes = result.scalars().all()

    if detail:
        return [
            {
                "id": r.id,
                "name": r.name,
                "parsedData": r.parsed_data,
                "createdAt": r.created_at.isoformat() if r.created_at else None,
            }
            for r in resumes
        ]

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
        raise HTTPException(status_code=404, detail={"error": "?´ë ¥?œë? ì°¾ì„ ???†ìŠµ?ˆë‹¤."})
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
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail={"error": "PDF ?Œì¼ë§??…ë¡œ?œí•  ???ˆìŠµ?ˆë‹¤."})

    content = await file.read()
    if len(content) > MAX_PDF_SIZE:
        raise HTTPException(status_code=413, detail={"error": "PDF ?Œì¼???ˆë¬´ ?½ë‹ˆ??(ìµœë? 10MB)"})

    try:
        doc = pymupdf.open(stream=content, filetype="pdf")
        text = "".join(page.get_text() for page in doc)
        doc.close()
    except Exception:
        raise HTTPException(status_code=400, detail={"error": "PDF ?Œì¼???½ì„ ???†ìŠµ?ˆë‹¤."})

    if not text.strip():
        raise HTTPException(status_code=400, detail={"error": "PDF?ì„œ ?ìŠ¤?¸ë? ì¶”ì¶œ?????†ìŠµ?ˆë‹¤."})

    # Strip .pdf extension for the display name
    name = file.filename.rsplit(".", 1)[0]

    # AI ?Œì‹±: rawText ??êµ¬ì¡°?”ëœ ?°ì´??ì¶”ì¶œ
    parsed_data: dict = {"rawText": text}
    try:
        structured = await call_llm_json(
            RESUME_PARSING_PROMPT.format(resumeText=text),
            max_tokens=4096,
        )
        if isinstance(structured, dict):
            parsed_data.update(structured)
    except Exception:
        pass  # ?Œì‹± ?¤íŒ¨ ??rawTextë§??€??

    resume = Resume(
        id=str(uuid4()),
        user_id=user.id,
        name=name,
        parsed_data=parsed_data,
    )
    db.add(resume)
    await db.commit()
    await db.refresh(resume)

    background_tasks.add_task(embed_resume, resume.id, user.id, resume.parsed_data)

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
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Resume).where(Resume.id == resume_id, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(status_code=404, detail={"error": "?´ë ¥?œë? ì°¾ì„ ???†ìŠµ?ˆë‹¤."})

    resume.name = body.name
    await db.commit()
    await db.refresh(resume)

    background_tasks.add_task(embed_resume, resume.id, user.id, resume.parsed_data)

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
        raise HTTPException(status_code=404, detail={"error": "?´ë ¥?œë? ì°¾ì„ ???†ìŠµ?ˆë‹¤."})

    try:
        await db.delete(resume)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error": "???´ë ¥?œì? ?°ê²°??ë©´ì ‘ ê¸°ë¡???ˆì–´ ?? œ?????†ìŠµ?ˆë‹¤."},
        )

    return {"success": True}
