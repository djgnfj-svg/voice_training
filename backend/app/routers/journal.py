# backend/app/routers/journal.py
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.agent import journal_nodes
from app.agent.journal_state import JournalState
from app.models.journal import JournalSession, JournalMessage

logger = logging.getLogger(__name__)

router = APIRouter()

FREE_MESSAGE_LIMIT = 10
COST_PER_MESSAGE = 1
RESUME_WINDOW_MINUTES = 120  # 마지막 활동 후 2시간 초과 시 기존 세션 timeout → 새 세션


# ---------- Schemas ----------

class MessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


# ---------- POST /api/journal/start ----------

@router.post("/api/journal/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start or resume journal session.

    Resume policy: 마지막 활동 이후 2시간 이내인 active 세션만 이어간다.
    2시간 초과면 기존 세션은 timeout 처리하고 새 세션을 만든다 —
    오래된 맥락("오늘 피곤했다" 등)이 새 대화에 끌려오지 않도록 보장.
    """
    # Find most recent active session (날짜 제한 없음 — 시간 경과로 분리)
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
        )
        .order_by(JournalSession.updated_at.desc())
        .limit(1)
        .options(selectinload(JournalSession.messages))
    )
    existing = result.scalar_one_or_none()

    if existing:
        messages = sorted(existing.messages, key=lambda m: m.message_index)
        last_activity = messages[-1].created_at if messages else existing.created_at
        now = datetime.utcnow()
        elapsed = now - last_activity if last_activity else timedelta(0)

        if elapsed > timedelta(minutes=RESUME_WINDOW_MINUTES):
            # 오래된 세션 — timeout 처리하고 새로 시작
            logger.info(
                "[journal.start] timing out stale session=%s elapsed=%dmin",
                existing.id, int(elapsed.total_seconds() // 60),
            )
            existing.status = "timeout"
            await db.commit()
            existing = None

    if existing:
        messages = sorted(existing.messages, key=lambda m: m.message_index)
        recent = messages[-5:] if len(messages) > 5 else messages
        return {
            "sessionId": existing.id,
            "resumed": True,
            "messages": [
                {"role": m.role, "content": m.content, "mode": m.mode}
                for m in recent
            ],
            "context": [],
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
    logger.info("[journal.start] new session=%s user=%s", session_id, user.id)

    return {
        "sessionId": session_id,
        "resumed": False,
        "messages": [],
        "context": [],
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
        from app.services.credit import deduct_for_feature, InsufficientCreditsError
        try:
            await deduct_for_feature(
                db, user.id, session_id,
                "저널 메시지", COST_PER_MESSAGE,
                tx_type="JOURNAL_DEBIT",
            )
        except InsufficientCreditsError:
            raise HTTPException(402, {"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"})

    # Rebuild conversation history from DB — 현재 세션 내 대화만 사용.
    # 오늘 날짜의 다른 세션/RAG 임베딩은 주입하지 않는다 (세션 간 맥락 누수 방지).
    db_messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation: list[dict] = [
        {"role": m.role, "content": m.content, "mode": m.mode}
        for m in db_messages
    ]

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
        "extracted_count": 0,
        "message_count": session.message_count,
        "free_messages_used": session.free_messages_used,
        "ai_response": "",
        "session_summary": None,
        "past_context": [],
        "strategy": "",
        "loop_count": 0,
        "actions_taken": [],
        "pending_events": [],
    }

    async def event_generator():
        nonlocal state, next_index
        try:
            # Agent loop: plan → action → plan → ... → respond → extract
            state = await journal_nodes.agent_loop(state, db)
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
                # Atomic increment — race condition 방어
                result = await db.execute(
                    update(JournalSession)
                    .where(
                        JournalSession.id == session_id,
                        JournalSession.free_messages_used < FREE_MESSAGE_LIMIT,
                    )
                    .values(free_messages_used=JournalSession.free_messages_used + 1)
                )
                if result.rowcount > 0:
                    session.free_messages_used += 1
            else:
                session.credits_charged = session.credits_charged + COST_PER_MESSAGE

            await db.commit()

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
        "extracted_count": 0,
        "message_count": session.message_count,
        "free_messages_used": session.free_messages_used,
        "ai_response": "",
        "session_summary": None,
        "past_context": [],
        "strategy": "",
        "loop_count": 0,
        "actions_taken": [],
        "pending_events": [],
    }

    state = await journal_nodes.summarize(state, db)

    # 세션 종료 시 1회만 장기 기억 추출 (메시지당 추출 대신)
    try:
        state = await journal_nodes.extract(state, db)
    except Exception:
        logger.exception("End-session extraction failed")

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
