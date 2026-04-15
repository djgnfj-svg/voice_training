from __future__ import annotations

import io
import logging
import os
import re

import edge_tts
import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
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
    format: str | None = None


async def _edge_stream(text: str):
    communicate = edge_tts.Communicate(text, "ko-KR-HyunsuNeural")
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]


@router.post("/api/tts")
async def text_to_speech(
    body: TTSRequest,
    user: AuthUser = Depends(get_current_user),
):
    cleaned = re.sub(r"[\(\[\{][^\)\]\}]*[\)\]\}]", "", body.text).strip()
    if not cleaned:
        raise HTTPException(400, "No speakable text")

    payload: dict = {"text": cleaned}
    if body.voice:
        payload["voice"] = body.voice
    if body.persona:
        payload["persona"] = body.persona
    if body.speed is not None:
        payload["speed"] = body.speed
    if body.model:
        payload["model"] = body.model
    if body.format:
        payload["format"] = body.format

    client = httpx.AsyncClient(timeout=TTS_TIMEOUT)
    upstream = None
    try:
        req = client.build_request("POST", f"{TTS_SERVICE_URL}/synthesize", json=payload)
        upstream = await client.send(req, stream=True)
        upstream.raise_for_status()
    except Exception as e:
        logger.warning("OpenAI TTS failed (%s), falling back to edge-tts", type(e).__name__)
        if upstream is not None:
            await upstream.aclose()
        await client.aclose()
        try:
            return StreamingResponse(_edge_stream(cleaned), media_type="audio/mpeg")
        except Exception:
            raise HTTPException(500, "TTS generation failed")

    media_type = upstream.headers.get("content-type", "audio/mpeg")

    async def passthrough():
        try:
            async for chunk in upstream.aiter_raw():
                if chunk:
                    yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(passthrough(), media_type=media_type)


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
