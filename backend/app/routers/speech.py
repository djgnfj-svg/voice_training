from __future__ import annotations

import io
import re

import edge_tts
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.dependencies import AuthUser, get_current_user

router = APIRouter()

MAX_AUDIO_SIZE = int(4.5 * 1024 * 1024)  # 4.5MB


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)


@router.post("/api/tts")
async def text_to_speech(
    body: TTSRequest,
    user: AuthUser = Depends(get_current_user),
):
    # Strip parentheses content
    cleaned = re.sub(r"[\(\[\{][^\)\]\}]*[\)\]\}]", "", body.text).strip()
    if not cleaned:
        raise HTTPException(400, "No speakable text")

    try:
        communicate = edge_tts.Communicate(cleaned, "ko-KR-HyunsuNeural")
        chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        audio = b"".join(chunks)
        return Response(
            content=audio,
            media_type="audio/mpeg",
            headers={"Content-Length": str(len(audio))},
        )
    except Exception:
        raise HTTPException(500, "TTS generation failed")


@router.post("/api/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    from app.config import settings

    if not settings.OPENAI_API_KEY:
        raise HTTPException(503, "Whisper API가 설정되지 않았습니다")

    # 확장자 검증
    ALLOWED_EXTENSIONS = {".webm", ".wav", ".mp3", ".ogg", ".mp4", ".m4a"}
    filename = audio.filename or "recording.webm"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "지원하지 않는 오디오 형식입니다")

    content = await audio.read()
    if len(content) > MAX_AUDIO_SIZE:
        raise HTTPException(413, "오디오 파일이 너무 큽니다")

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

        audio_file = io.BytesIO(content)
        audio_file.name = filename

        result = await client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            language="ko",
        )
        return {"transcript": result.text, "source": "whisper"}
    except Exception:
        raise HTTPException(500, "전사에 실패했습니다")
