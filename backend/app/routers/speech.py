from __future__ import annotations

import io
import logging
import os
import re

import edge_tts
import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.dependencies import AuthUser, get_current_user

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_AUDIO_SIZE = int(4.5 * 1024 * 1024)  # 4.5MB
TTS_SERVICE_URL = os.environ.get("TTS_SERVICE_URL", "http://tts:8080")
TTS_TIMEOUT = float(os.environ.get("TTS_TIMEOUT", "30"))


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)
    voice: str | None = None
    persona: str | None = None
    speed: float | None = Field(default=None, ge=0.25, le=4.0)
    model: str | None = None


async def _tts_synthesize(
    text: str, voice: str | None, persona: str | None, speed: float | None, model: str | None
) -> tuple[bytes, str]:
    payload: dict = {"text": text}
    if voice:
        payload["voice"] = voice
    if persona:
        payload["persona"] = persona
    if speed is not None:
        payload["speed"] = speed
    if model:
        payload["model"] = model
    async with httpx.AsyncClient(timeout=TTS_TIMEOUT) as client:
        res = await client.post(f"{TTS_SERVICE_URL}/synthesize", json=payload)
        res.raise_for_status()
        return res.content, res.headers.get("content-type", "audio/mpeg")


async def _edge_fallback(text: str) -> tuple[bytes, str]:
    communicate = edge_tts.Communicate(text, "ko-KR-HyunsuNeural")
    chunks: list[bytes] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks), "audio/mpeg"


@router.post("/api/tts")
async def text_to_speech(
    body: TTSRequest,
    user: AuthUser = Depends(get_current_user),
):
    cleaned = re.sub(r"[\(\[\{][^\)\]\}]*[\)\]\}]", "", body.text).strip()
    if not cleaned:
        raise HTTPException(400, "No speakable text")

    try:
        audio, media_type = await _tts_synthesize(cleaned, body.voice, body.persona, body.speed, body.model)
    except Exception as e:
        logger.warning("OpenAI TTS failed (%s), falling back to edge-tts", type(e).__name__)
        try:
            audio, media_type = await _edge_fallback(cleaned)
        except Exception:
            raise HTTPException(500, "TTS generation failed")

    return Response(
        content=audio,
        media_type=media_type,
        headers={"Content-Length": str(len(audio))},
    )


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
