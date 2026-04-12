from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

logger = logging.getLogger("tts")
logging.basicConfig(level=logging.INFO)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is required")

MODEL = os.environ.get("TTS_MODEL", "gpt-4o-mini-tts")
DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "sage")
DEFAULT_FORMAT = os.environ.get("TTS_FORMAT", "mp3")
DEFAULT_SPEED = float(os.environ.get("TTS_SPEED", "2.0"))

# 페르소나별 instructions (gpt-4o-mini-tts 전용)
PERSONA_INSTRUCTIONS = {
    "interviewer": (
        "You are a professional Korean tech interviewer. "
        "Speak clearly, confidently, and at a slightly brisk pace. "
        "Tone: neutral-professional, not robotic. Natural Korean prosody."
    ),
    "journal_friend": (
        "You are a warm, friendly Korean friend listening to a daily reflection. "
        "Speak casually and with empathy, like chatting over coffee. "
        "Pace: natural conversational speed."
    ),
    "journal_counselor": (
        "You are a calm, empathetic Korean counselor. "
        "Speak slowly and warmly, with understanding pauses where natural. "
        "Tone: gentle, validating."
    ),
    "tutor": (
        "You are an encouraging Korean tutor explaining a concept. "
        "Speak with clarity and energy, like a friendly teacher who wants the student to succeed. "
        "Pace: natural, lively but not rushed."
    ),
    "default": (
        "Speak natural Korean at a brisk, confident pace. "
        "Tone: warm and engaging, not robotic."
    ),
}

client = AsyncOpenAI(api_key=OPENAI_API_KEY)
app = FastAPI()


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)
    voice: Optional[str] = None
    persona: Optional[str] = None
    speed: Optional[float] = None
    model: Optional[str] = None


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL, "voice": DEFAULT_VOICE}


@app.get("/voices")
def voices():
    return {
        "voices": ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"],
        "default": DEFAULT_VOICE,
        "personas": list(PERSONA_INSTRUCTIONS.keys()),
    }


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    voice = req.voice or DEFAULT_VOICE
    persona = req.persona or "default"
    instructions = PERSONA_INSTRUCTIONS.get(persona, PERSONA_INSTRUCTIONS["default"])
    speed = req.speed if req.speed is not None else DEFAULT_SPEED
    model = req.model or MODEL

    try:
        kwargs: dict = dict(
            model=model,
            voice=voice,
            input=req.text,
            response_format=DEFAULT_FORMAT,
        )
        if model == "gpt-4o-mini-tts":
            # gpt-4o-mini-tts: speed 파라미터 무시 → instructions로 속도 강도 세분화
            if speed >= 1.7:
                pace_hint = " Speak very fast, almost rushed — like giving urgent news."
            elif speed >= 1.4:
                pace_hint = " Speak noticeably fast and energetic."
            elif speed >= 1.2:
                pace_hint = " Speak at a brisk, slightly fast pace."
            elif speed <= 0.7:
                pace_hint = " Speak very slowly and deliberately, with long pauses."
            elif speed <= 0.85:
                pace_hint = " Speak at a slow, calm pace."
            else:
                pace_hint = ""
            kwargs["instructions"] = instructions + pace_hint
            # gpt-4o-mini-tts도 speed 파라미터 받기는 받음 (약하게나마 적용)
            kwargs["speed"] = max(0.25, min(4.0, speed))
        else:
            kwargs["speed"] = max(0.25, min(4.0, speed))

        async with client.audio.speech.with_streaming_response.create(**kwargs) as resp:
            chunks = []
            async for chunk in resp.iter_bytes():
                chunks.append(chunk)
        audio = b"".join(chunks)
    except Exception as e:
        logger.exception("OpenAI TTS failed")
        raise HTTPException(500, f"TTS failed: {type(e).__name__}")

    media_type = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "opus": "audio/opus",
        "flac": "audio/flac",
    }.get(DEFAULT_FORMAT, "audio/mpeg")

    return Response(
        content=audio,
        media_type=media_type,
        headers={"Content-Length": str(len(audio))},
    )
