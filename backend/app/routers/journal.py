# backend/app/routers/journal.py
from __future__ import annotations

import json
import logging
from datetime import date
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.agent import journal_nodes
from app.agent.journal_state import JournalState
from app.agent.journal_rag import load_today_context
from app.models.journal import JournalSession, JournalMessage

logger = logging.getLogger(__name__)

router = APIRouter()

FREE_MESSAGE_LIMIT = 10
COST_PER_MESSAGE = 1


# ---------- Schemas ----------

class MessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


# ---------- POST /api/journal/start ----------

@router.post("/api/journal/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start or resume today's journal session."""
    today = date.today()

    # Check for existing active session today
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
            sa_func.date(JournalSession.created_at) == today,
        )
        .options(selectinload(JournalSession.messages))
    )
    existing = result.scalar_one_or_none()

    if existing:
        # Resume: load recent messages + today's context
        messages = sorted(existing.messages, key=lambda m: m.message_index)
        recent = messages[-5:] if len(messages) > 5 else messages
        context = await load_today_context(db, user.id, today)

        return {
            "sessionId": existing.id,
            "resumed": True,
            "messages": [
                {
                    "role": m.role,
                    "content": m.content,
                    "mode": m.mode,
                }
                for m in recent
            ],
            "context": [{"category": c["category"], "content": c["content"]} for c in context],
            "messageCount": existing.message_count,
            "freeMessagesUsed": existing.free_messages_used,
        }

    # New session
    session_id = str(uuid4())
    session = JournalSession(
        id=session_id,
        user_id=user.id,
    )
    db.add(session)
    await db.commit()

    context = await load_today_context(db, user.id, today)

    return {
        "sessionId": session_id,
        "resumed": False,
        "messages": [],
        "context": [{"category": c["category"], "content": c["content"]} for c in context],
        "messageCount": 0,
        "freeMessagesUsed": 0,
    }


# ---------- POST /api/journal/{session_id}/message ----------

@router.post("/api/journal/{session_id}/message")
async def send_message(
    session_id: str,
    body: MessageRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Send a message and get AI response via SSE."""
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.id == session_id,
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
        )
        .options(selectinload(JournalSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Credit check (after free limit)
    if session.free_messages_used >= FREE_MESSAGE_LIMIT:
        from sqlalchemy import text
        credit_result = await db.execute(
            text("""
                UPDATE users SET "creditBalance" = "creditBalance" - :cost
                WHERE id = :user_id AND "creditBalance" >= :cost
            """),
            {"user_id": user.id, "cost": COST_PER_MESSAGE},
        )
        if credit_result.rowcount == 0:
            raise HTTPException(402, {"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"})

    # Rebuild conversation history from DB
    db_messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation: list[dict] = [
        {"role": m.role, "content": m.content, "mode": m.mode}
        for m in db_messages
    ]

    today = date.today()
    journal_context = await load_today_context(db, user.id, today)

    # Determine current mode from last message
    current_mode = "journal"
    if db_messages:
        current_mode = db_messages[-1].mode or "journal"

    next_index = len(db_messages)

    state: JournalState = {
        "session_id": session_id,
        "user_id": user.id,
        "messages": conversation,
        "mode": current_mode,
        "user_message": body.message,
        "journal_context": [
            {"category": c["category"], "content": c["content"]}
            for c in journal_context
        ],
        "extracted_count": 0,
        "message_count": session.message_count,
        "free_messages_used": session.free_messages_used,
        "ai_response": "",
        "session_summary": None,
        "pending_events": [],
    }

    async def event_generator():
        nonlocal state, next_index
        try:
            # Route + respond
            state = await journal_nodes.route_and_respond(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Save user message to DB
            user_msg = JournalMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=next_index,
                role="user",
                content=body.message,
                mode=state["mode"],
            )
            db.add(user_msg)
            next_index += 1

            # Save AI response to DB
            ai_msg = JournalMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=next_index,
                role="assistant",
                content=state["ai_response"],
                mode=state["mode"],
            )
            db.add(ai_msg)
            next_index += 1

            # Update session counters
            session.message_count = state["message_count"]
            if session.free_messages_used < FREE_MESSAGE_LIMIT:
                session.free_messages_used = session.free_messages_used + 1
            else:
                session.credits_charged = session.credits_charged + COST_PER_MESSAGE

            await db.commit()

            # Extract (doesn't block response)
            state["pending_events"] = []
            state = await journal_nodes.extract(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}

        except Exception:
            logger.exception("Journal message processing failed")
            yield {"event": "error", "data": json.dumps({"error": "메시지 처리에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/journal/{session_id}/end ----------

@router.post("/api/journal/{session_id}/end")
async def end_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """End journal session and generate summary."""
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.id == session_id,
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
        )
        .options(selectinload(JournalSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Empty session → just close
    if session.message_count == 0:
        session.status = "completed"
        await db.commit()
        return {"status": "completed", "summary": None}

    # Build conversation for summary
    db_messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation = [
        {"role": m.role, "content": m.content, "mode": m.mode}
        for m in db_messages
    ]

    state: JournalState = {
        "session_id": session_id,
        "user_id": user.id,
        "messages": conversation,
        "mode": "journal",
        "user_message": "",
        "journal_context": [],
        "extracted_count": 0,
        "message_count": session.message_count,
        "free_messages_used": session.free_messages_used,
        "ai_response": "",
        "session_summary": None,
        "pending_events": [],
    }

    state = await journal_nodes.summarize(state, db)

    session.status = "completed"
    session.summary = state.get("session_summary", "")
    await db.commit()

    # Extract summary event data
    summary_data = None
    for ev in state.get("pending_events", []):
        if ev["event"] == "summary":
            summary_data = ev["data"]
            break

    return {"status": "completed", "summary": summary_data}


# ---------- GET /api/journal/history ----------

@router.get("/api/journal/history")
async def get_history(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get journal session summaries (completed only)."""
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.user_id == user.id,
            JournalSession.status.in_(["completed", "timeout"]),
        )
        .order_by(JournalSession.created_at.desc())
        .limit(30)
    )
    sessions = result.scalars().all()

    return [
        {
            "id": s.id,
            "summary": s.summary,
            "messageCount": s.message_count,
            "status": s.status,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
        }
        for s in sessions
    ]


# ---------- GET /api/journal/{session_id} ----------

@router.get("/api/journal/{session_id}")
async def get_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific journal session summary."""
    result = await db.execute(
        select(JournalSession).where(
            JournalSession.id == session_id,
            JournalSession.user_id == user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    return {
        "id": session.id,
        "status": session.status,
        "summary": session.summary,
        "messageCount": session.message_count,
        "createdAt": session.created_at.isoformat() if session.created_at else None,
    }
