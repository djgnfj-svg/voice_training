# backend/app/routers/journal.py
from __future__ import annotations

import json
import logging
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.database import async_session, get_db
from app.dependencies import AuthUser, get_current_user
from app.agent import journal_nodes
from app.agent.journal_state import JournalState
from app.models.journal import JournalSession, JournalMessage

logger = logging.getLogger(__name__)

router = APIRouter()

FREE_MESSAGE_LIMIT = 10
COST_PER_MESSAGE = 1


# ---------- Schemas ----------

class MessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


# ---------- 내부 헬퍼 ----------

async def _finalize_session(
    session: JournalSession,
    user_id: str,
    db: AsyncSession,
) -> dict | None:
    """세션을 마감한다.

    - 메시지 0개 → status="timeout", 요약 없음
    - 메시지 있음 → summarize + extract 수행 후 status="completed"

    Returns: 요약 dict (있으면) or None
    """
    if not session.messages:
        session.status = "timeout"
        await db.commit()
        logger.info("[journal.finalize] empty session=%s → timeout", session.id)
        return None

    db_messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation = [
        {"role": m.role, "content": m.content, "mode": m.mode}
        for m in db_messages
    ]

    state: JournalState = {
        "session_id": session.id,
        "user_id": user_id,
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
    try:
        state = await journal_nodes.extract(state, db)
    except Exception:
        logger.exception("Finalize: extract failed session=%s", session.id)

    session.status = "completed"
    session.summary = state.get("session_summary", "")
    await db.commit()
    logger.info(
        "[journal.finalize] session=%s msgs=%d → completed",
        session.id, session.message_count,
    )

    for ev in state.get("pending_events", []):
        if ev["event"] == "summary":
            return ev["data"]
    return None


async def _finalize_session_in_background(session_id: str, user_id: str) -> None:
    """독립 DB 세션으로 이전 세션 마감 (start 시 백그라운드 호출용)."""
    async with async_session() as db:
        try:
            result = await db.execute(
                select(JournalSession)
                .where(
                    JournalSession.id == session_id,
                    JournalSession.status == "active",
                )
                .options(selectinload(JournalSession.messages))
            )
            session = result.scalar_one_or_none()
            if not session:
                return
            await _finalize_session(session, user_id, db)
        except Exception:
            logger.exception("Background finalize failed: %s", session_id)


# ---------- POST /api/journal/start ----------

@router.post("/api/journal/start")
async def start_session(
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """항상 새 세션을 생성한다 (ChatGPT 스타일).

    이전 active 세션이 있으면 백그라운드에서 자동 마감 (요약·추출 포함).
    사용자는 즉시 빈 세션으로 시작하고, 과거 대화는 /journal/history 로 접근.
    """
    # 이전 active 세션 id 수집 → 백그라운드 마감 예약
    result = await db.execute(
        select(JournalSession.id).where(
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
        )
    )
    prev_ids = [row[0] for row in result.all()]
    for prev_id in prev_ids:
        background_tasks.add_task(_finalize_session_in_background, prev_id, user.id)

    # 새 세션 생성
    session_id = str(uuid4())
    session = JournalSession(
        id=session_id,
        user_id=user.id,
    )
    db.add(session)
    await db.commit()

    logger.info(
        "[journal.start] new session=%s user=%s prev_to_finalize=%d",
        session_id, user.id, len(prev_ids),
    )

    return {
        "sessionId": session_id,
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

    # 현재 세션 내 대화만 사용 — 다른 세션/RAG 오염 없음.
    db_messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation: list[dict] = [
        {"role": m.role, "content": m.content, "mode": m.mode}
        for m in db_messages
    ]

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
            state = await journal_nodes.agent_loop(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

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

            session.message_count = state["message_count"]
            if session.free_messages_used < FREE_MESSAGE_LIMIT:
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
    """사용자 명시 종료: 요약·추출 후 세션 마감."""
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

    summary_data = await _finalize_session(session, user.id, db)
    return {"status": session.status, "summary": summary_data}


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
