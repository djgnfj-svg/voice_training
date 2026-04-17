from __future__ import annotations

import asyncio
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.interview import InterviewSession, InterviewAnswer

router = APIRouter()

AUDIO_DIR = Path(__file__).resolve().parent.parent.parent / ".audio-storage"
MAX_SIZE = 10 * 1024 * 1024  # 10MB
ALLOWED_EXTS = {"webm", "mp3", "wav", "ogg"}
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
MIME_MAP = {
    "webm": "audio/webm",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
}


@router.post("/api/interview/audio")
async def upload_audio(
    audio: UploadFile = File(...),
    sessionId: str = Form(...),
    questionIndex: str = Form(...),
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate sessionId
    if not UUID_RE.match(sessionId):
        raise HTTPException(400, {"error": "잘못된 세션 ID"})

    try:
        q_idx = int(questionIndex)
    except ValueError:
        raise HTTPException(400, {"error": "잘못된 questionIndex"})
    if q_idx < 0:
        raise HTTPException(400, {"error": "잘못된 questionIndex"})

    # Get extension
    ext = (audio.filename or "").rsplit(".", 1)[-1].lower() if audio.filename else ""
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, {"error": f"지원하지 않는 파일 형식: {ext}"})

    # Read and check size
    content = await audio.read()
    if len(content) > MAX_SIZE:
        raise HTTPException(400, {"error": "파일 크기가 너무 큽니다 (최대 10MB)"})

    # Verify session ownership
    result = await db.execute(
        select(InterviewSession.id).where(
            InterviewSession.id == sessionId,
            InterviewSession.user_id == user.id,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Save locally
    dir_path = AUDIO_DIR / sessionId
    dir_path.mkdir(parents=True, exist_ok=True)
    file_path = dir_path / f"{q_idx}.{ext}"
    await asyncio.to_thread(file_path.write_bytes, content)

    audio_url = f"/api/interview/audio?sessionId={sessionId}&questionIndex={q_idx}"

    # Update answer record
    await db.execute(
        update(InterviewAnswer)
        .where(
            InterviewAnswer.session_id == sessionId,
            InterviewAnswer.question_index == q_idx,
        )
        .values(audio_url=audio_url)
    )
    await db.commit()

    return {"audioUrl": audio_url}


@router.get("/api/interview/audio")
async def get_audio(
    sessionId: str = Query(...),
    questionIndex: int = Query(...),
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not UUID_RE.match(sessionId):
        raise HTTPException(400, {"error": "잘못된 세션 ID"})

    # Verify ownership
    result = await db.execute(
        select(InterviewSession.id).where(
            InterviewSession.id == sessionId,
            InterviewSession.user_id == user.id,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Find file
    dir_path = AUDIO_DIR / sessionId
    for ext in ALLOWED_EXTS:
        file_path = dir_path / f"{questionIndex}.{ext}"
        if file_path.exists():
            return FileResponse(
                str(file_path), media_type=MIME_MAP.get(ext, "audio/webm")
            )

    raise HTTPException(404, {"error": "오디오 파일을 찾을 수 없습니다"})
