"""OpenAI Realtime API relay for the Learning Coach voice session.

Bridges a browser WebSocket (PCM16 audio in/out + control events) to the OpenAI
Realtime API while reusing the existing Learning Coach brain:

- Context is loaded with the same ``_load_context`` used by the turn-based graph.
- The 7 brain tools are exposed to Realtime via ``realtime_tools`` and executed
  in-process when the model emits a ``function_call`` (no extra round trips).
- Input/output transcripts are persisted to ``learning_messages`` on close.
- Cost guards: hard session cap, idle watchdog, and per-day usage accounting.

The browser-facing protocol (JSON text frames unless noted):
  client -> relay:
    {"type": "input_audio", "audio": "<base64 pcm16>"}   # mic chunk
    {"type": "bye"}                                        # graceful hangup
  relay -> client:
    {"type": "ready", "model": "..."}
    {"type": "output_audio", "audio": "<base64 pcm16>"}    # speaker chunk
    {"type": "speech_started"}                              # server VAD: barge-in
    {"type": "transcript", "role": "assistant"|"user", "text": "..."}
    {"type": "meta", "tool": "<tool_name>", "result": {...}}
    {"type": "guard", "reason": "session_cap"|"idle"|"daily_cap", "message": "..."}
    {"type": "error", "message": "..."}
    {"type": "closed"}

This module uses ``connection.send(<dict>)`` for client->OpenAI events so it
stays robust against SDK typed-param churn; the SDK transforms the dict against
its RealtimeClientEventParam shape.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from openai import AsyncOpenAI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.agent.learning_coach.graph import _load_context
from app.agent.learning_coach.realtime_tools import (
    adapt_tools_for_realtime,
    dispatch_tool_call,
)
from app.prompts.learning_coach import AGENTIC_SYSTEM_PROMPT

logger = logging.getLogger(__name__)
KST = timezone(timedelta(hours=9))

# Realtime audio defaults — pcm16 mono 24kHz (OpenAI Realtime native format).
_AUDIO_FORMAT = "pcm16"
_VOICE = "sage"


def _kst_today_str() -> str:
    return datetime.now(KST).date().isoformat()


async def get_daily_seconds_used(db: AsyncSession, user_id: str) -> int:
    """Return today's (KST) accumulated realtime voice seconds for a user."""
    row = (
        await db.execute(
            text(
                """
                SELECT seconds_used FROM realtime_voice_usage
                WHERE user_id=:u AND kst_date=:d
                """
            ),
            {"u": user_id, "d": _kst_today_str()},
        )
    ).one_or_none()
    return int(row.seconds_used) if row else 0


async def _record_daily_seconds(db: AsyncSession, user_id: str, seconds: int) -> None:
    """Accumulate realtime voice seconds for the user's KST day."""
    if seconds <= 0:
        return
    await db.execute(
        text(
            """
            INSERT INTO realtime_voice_usage (user_id, kst_date, seconds_used)
            VALUES (:u, :d, :s)
            ON CONFLICT (user_id, kst_date)
            DO UPDATE SET seconds_used = realtime_voice_usage.seconds_used + :s,
                          updated_at = NOW()
            """
        ),
        {"u": user_id, "d": _kst_today_str(), "s": int(seconds)},
    )
    await db.commit()


async def _persist_transcript(
    db: AsyncSession,
    session_id: str,
    turns: list[dict[str, str]],
) -> None:
    """Persist collected realtime transcript turns into ``learning_messages``.

    Mirrors the indexing/bookkeeping of ``graph._persist_graph_turn`` but for a
    full-duplex transcript: each completed user/assistant utterance becomes one
    message row, and ``learning_sessions.turn_count`` advances by the number of
    user turns (one round trip per user utterance).
    """
    if not turns:
        return
    last_idx = (
        (
            await db.execute(
                text(
                    "SELECT COALESCE(MAX(message_index), -1) AS idx FROM learning_messages WHERE session_id=:s"
                ),
                {"s": session_id},
            )
        )
        .one()
        .idx
    )
    next_idx = last_idx + 1
    user_turns = 0
    for turn in turns:
        role = turn.get("role")
        content = (turn.get("text") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        await db.execute(
            text(
                """
                INSERT INTO learning_messages (session_id, message_index, role, content, mode)
                VALUES (:s, :i, :r, :c, 'realtime')
                """
            ),
            {"s": session_id, "i": next_idx, "r": role, "c": content},
        )
        next_idx += 1
        if role == "user":
            user_turns += 1
    if user_turns:
        await db.execute(
            text(
                "UPDATE learning_sessions SET turn_count = turn_count + :inc WHERE id=:s"
            ),
            {"inc": user_turns, "s": session_id},
        )
    await db.commit()


def _build_instructions(ctx: dict[str, Any]) -> str:
    return (
        AGENTIC_SYSTEM_PROMPT
        + "\n\nContext JSON:\n"
        + json.dumps(ctx, ensure_ascii=False, default=str)
    )


class _RealtimeSession:
    """Per-connection state + the two relay pumps."""

    def __init__(
        self,
        websocket: WebSocket,
        db: AsyncSession,
        session_id: str,
        user_id: str,
    ) -> None:
        self.ws = websocket
        self.db = db
        self.session_id = session_id
        self.user_id = user_id
        self.conn: Any = None  # AsyncRealtimeConnection
        self.started_at = time.monotonic()
        self.last_audio_at = time.monotonic()
        self.closed = asyncio.Event()
        self.close_reason: str | None = None
        # Transcript accumulation
        self._turns: list[dict[str, str]] = []
        self._cur_user = ""
        self._cur_assistant = ""

    def _flush_user(self) -> None:
        if self._cur_user.strip():
            self._turns.append({"role": "user", "text": self._cur_user.strip()})
        self._cur_user = ""

    def _flush_assistant(self) -> None:
        if self._cur_assistant.strip():
            self._turns.append(
                {"role": "assistant", "text": self._cur_assistant.strip()}
            )
        self._cur_assistant = ""

    async def _safe_send_json(self, payload: dict[str, Any]) -> None:
        try:
            await self.ws.send_json(payload)
        except Exception:
            self.closed.set()

    # ---- client -> OpenAI pump -------------------------------------------------
    async def pump_client_to_openai(self) -> None:
        try:
            while not self.closed.is_set():
                raw = await self.ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "input_audio":
                    audio = msg.get("audio")
                    if audio:
                        self.last_audio_at = time.monotonic()
                        await self.conn.send(
                            {"type": "input_audio_buffer.append", "audio": audio}
                        )
                elif mtype == "bye":
                    self.close_reason = "client_bye"
                    self.closed.set()
                    return
        except WebSocketDisconnect:
            self.close_reason = self.close_reason or "client_disconnect"
            self.closed.set()
        except Exception:
            logger.exception("realtime: client->openai pump error")
            self.closed.set()

    # ---- OpenAI -> client pump -------------------------------------------------
    async def pump_openai_to_client(self) -> None:
        try:
            async for event in self.conn:
                if self.closed.is_set():
                    return
                await self._handle_openai_event(event)
        except Exception:
            logger.exception("realtime: openai->client pump error")
            self.closed.set()

    async def _handle_openai_event(self, event: Any) -> None:
        etype = getattr(event, "type", None)
        if etype is None:
            return

        # Audio out (delta) — forward base64 pcm16 to the browser.
        if etype in ("response.output_audio.delta", "response.audio.delta"):
            delta = getattr(event, "delta", None)
            if delta:
                await self._safe_send_json({"type": "output_audio", "audio": delta})
            return

        # Server VAD detected user speech -> tell the client to barge-in.
        if etype == "input_audio_buffer.speech_started":
            self.last_audio_at = time.monotonic()
            await self._safe_send_json({"type": "speech_started"})
            return

        # Assistant transcript (incremental + final).
        if etype in (
            "response.output_audio_transcript.delta",
            "response.audio_transcript.delta",
        ):
            delta = getattr(event, "delta", None)
            if delta:
                self._cur_assistant += delta
            return
        if etype in (
            "response.output_audio_transcript.done",
            "response.audio_transcript.done",
        ):
            self._flush_assistant()
            return

        # User input transcription (Whisper-side of Realtime).
        if etype == "conversation.item.input_audio_transcription.completed":
            transcript = getattr(event, "transcript", None)
            if transcript:
                self._cur_user = transcript
                self._flush_user()
                await self._safe_send_json(
                    {"type": "transcript", "role": "user", "text": transcript}
                )
            return

        # Function call requested by the model.
        if etype == "response.function_call_arguments.done":
            await self._handle_function_call(event)
            return

        # Surface OpenAI-side errors without leaking internals.
        if etype == "error":
            logger.error(
                "realtime: openai error event: %s", getattr(event, "error", event)
            )
            await self._safe_send_json(
                {"type": "error", "message": "음성 연결에 문제가 생겼어요."}
            )
            return

    async def _handle_function_call(self, event: Any) -> None:
        name = getattr(event, "name", None)
        call_id = getattr(event, "call_id", None)
        arguments = getattr(event, "arguments", None)
        if not name or not call_id:
            return
        result = await dispatch_tool_call(
            self.db, self.session_id, self.user_id, name, arguments
        )
        # Return the tool output, then ask the model to continue speaking.
        await self.conn.send(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": result,
                },
            }
        )
        await self.conn.send({"type": "response.create"})
        # Forward a compact meta event so the UI can react (topic/proficiency).
        try:
            parsed = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            parsed = {}
        await self._safe_send_json({"type": "meta", "tool": name, "result": parsed})

    # ---- watchdog --------------------------------------------------------------
    async def watchdog(self, cap_sec: int) -> None:
        """Enforce the (daily-clamped) session hard cap and idle timeout."""
        while not self.closed.is_set():
            await asyncio.sleep(1.0)
            now = time.monotonic()
            if now - self.started_at >= cap_sec:
                self.close_reason = "session_cap"
                await self._safe_send_json(
                    {
                        "type": "guard",
                        "reason": "session_cap",
                        "message": "오늘 음성 세션 시간이 다 됐어요. 여기까지 정리할게요.",
                    }
                )
                self.closed.set()
                return
            if now - self.last_audio_at >= settings.REALTIME_IDLE_SEC:
                self.close_reason = "idle"
                await self._safe_send_json(
                    {
                        "type": "guard",
                        "reason": "idle",
                        "message": "한동안 말씀이 없어 음성 세션을 종료할게요.",
                    }
                )
                self.closed.set()
                return

    def elapsed_seconds(self) -> int:
        return int(time.monotonic() - self.started_at)


async def run_realtime_session(
    websocket: WebSocket,
    db: AsyncSession,
    session_id: str,
    user_id: str,
    *,
    daily_remaining_sec: int,
) -> None:
    """Open the OpenAI Realtime connection and relay until close.

    Assumes the caller already authenticated, verified ownership, accepted the
    WebSocket, and checked the daily cap. ``daily_remaining_sec`` caps this
    session so the per-day budget is never exceeded.
    """
    ctx = await _load_context(db, session_id, user_id)
    instructions = _build_instructions(ctx)
    tools = adapt_tools_for_realtime()

    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

    session = _RealtimeSession(websocket, db, session_id, user_id)
    # Effective hard cap for this connection = min(session cap, remaining daily).
    effective_cap = min(settings.REALTIME_SESSION_MAX_SEC, max(1, daily_remaining_sec))

    try:
        async with client.realtime.connect(model=settings.REALTIME_MODEL) as conn:
            session.conn = conn
            await conn.send(
                {
                    "type": "session.update",
                    "session": {
                        "type": "realtime",
                        "instructions": instructions,
                        "tools": tools,
                        "tool_choice": "auto",
                        "audio": {
                            "input": {
                                "format": {"type": _AUDIO_FORMAT},
                                "turn_detection": {"type": "server_vad"},
                                "transcription": {"model": "whisper-1"},
                            },
                            "output": {
                                "format": {"type": _AUDIO_FORMAT},
                                "voice": _VOICE,
                            },
                        },
                    },
                }
            )

            await session._safe_send_json(
                {"type": "ready", "model": settings.REALTIME_MODEL}
            )

            # Start the clock fresh after the connection + session.update settle.
            session.started_at = time.monotonic()
            session.last_audio_at = time.monotonic()
            tasks = [
                asyncio.create_task(session.pump_client_to_openai()),
                asyncio.create_task(session.pump_openai_to_client()),
                asyncio.create_task(session.watchdog(effective_cap)),
            ]
            await session.closed.wait()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except Exception:
        logger.exception("realtime: session relay failed")
        try:
            await session._safe_send_json(
                {
                    "type": "error",
                    "message": "음성 연결에 실패했어요. 잠시 후 다시 시도해주세요.",
                }
            )
        except Exception:
            pass
    finally:
        # Persist transcript + record usage on a fresh session (the relay one
        # may be in an inconsistent state after errors).
        session._flush_user()
        session._flush_assistant()
        elapsed = session.elapsed_seconds()
        try:
            async with async_session() as persist_db:
                await _persist_transcript(persist_db, session_id, session._turns)
                await _record_daily_seconds(persist_db, user_id, elapsed)
        except Exception:
            logger.exception("realtime: persist/usage record failed")
        try:
            await websocket.send_json({"type": "closed"})
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
