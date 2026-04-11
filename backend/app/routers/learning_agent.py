from __future__ import annotations

import json
import logging
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.config import settings
from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.agent import learning_nodes
from app.agent.learning_state import LearningState
from app.models.learning_agent import LearningAgentSession, LearningAgentMessage
from app.models.activity import ActivityLog, ActivityItem
from app.models.enums import ActivityType
from app.models.user import User
from app.services.credit import CREDIT_COSTS, deduct_for_feature
from app.services import daily_progress as daily_progress_service

logger = logging.getLogger(__name__)

router = APIRouter()

KST = timezone(timedelta(hours=9))


def _get_kst_midnight() -> datetime:
    """Return the start of today in KST as a UTC datetime."""
    now_kst = datetime.now(KST)
    midnight_kst = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_kst.astimezone(timezone.utc).replace(tzinfo=None)


# ---------- Schemas ----------

class RespondRequest(BaseModel):
    message: str = Field(min_length=1, max_length=10000)
    credit_confirmed: bool = False


# ---------- POST /api/nightly-study/start ----------

@router.post("/api/nightly-study/start")
async def start_learning_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start a learning agent session: load profile, greet user."""
    # Lock user row
    await db.execute(
        select(User).where(User.id == user.id).with_for_update()
    )

    is_free_session = False

    # Daily limit check (skip in dev)
    if not settings.is_dev:
        kst_midnight = _get_kst_midnight()
        stmt = select(LearningAgentSession).where(
            LearningAgentSession.user_id == user.id,
            LearningAgentSession.is_free_session == True,  # noqa: E712
            LearningAgentSession.created_at >= kst_midnight,
        )
        result = await db.execute(stmt)
        today_free = result.scalar_one_or_none()

        if today_free is None:
            # First free session today
            is_free_session = True
        else:
            # Already used free session — need credits
            info_result = await db.execute(
                select(User.credit_balance).where(User.id == user.id)
            )
            balance = info_result.scalar_one_or_none() or 0
            if balance < CREDIT_COSTS["SESSION"]:
                raise HTTPException(
                    402,
                    {"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"},
                )

    # Create session
    session_id = str(uuid4())
    session = LearningAgentSession(
        id=session_id,
        user_id=user.id,
        status="active",
        is_free_session=is_free_session,
    )
    db.add(session)
    await db.commit()

    # Build initial state
    initial_state: LearningState = {
        "session_id": session_id,
        "user_id": user.id,
        "topic": "",
        "user_profile": {},
        "conversation_history": [],
        "current_phase": "greeting",
        "llm_call_count": 0,
        "credit_activated": False,
        "is_free_session": is_free_session,
        "pending_events": [],
    }

    async def event_generator():
        try:
            state = initial_state.copy()

            # Send session info first (before any other events)
            yield {
                "event": "session",
                "data": json.dumps({
                    "sessionId": session_id,
                    "isFreeSession": is_free_session,
                }),
            }

            # Load profile
            state = await learning_nodes.load_profile(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Greet
            state = await learning_nodes.greet(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Save greeting message to DB
            greeting_content = ""
            for entry in state.get("conversation_history", []):
                if entry.get("role") == "tutor":
                    greeting_content = entry.get("content", "")
                    break

            msg = LearningAgentMessage(
                id=str(uuid4()),
                session_id=session_id,
                message_index=0,
                role="tutor",
                content=greeting_content,
                phase="greeting",
            )
            db.add(msg)

            # Update session llm_call_count
            session.llm_call_count = state.get("llm_call_count", 0)
            await db.commit()

        except Exception:
            logger.exception("Learning agent start failed")
            yield {"event": "error", "data": json.dumps({"error": "학습 시작에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/nightly-study/{session_id}/respond ----------

@router.post("/api/nightly-study/{session_id}/respond")
async def respond_to_session(
    session_id: str,
    body: RespondRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Handle user response in a learning session."""
    # Verify session
    result = await db.execute(
        select(LearningAgentSession)
        .where(
            LearningAgentSession.id == session_id,
            LearningAgentSession.user_id == user.id,
            LearningAgentSession.status == "active",
        )
        .options(selectinload(LearningAgentSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Rebuild state from DB messages
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history: list[dict] = []
    current_phase = "greeting"
    topic = session.topic or ""

    for msg in messages:
        entry: dict = {"role": msg.role, "content": msg.content}
        if msg.phase:
            entry["phase"] = msg.phase
        if msg.assessment:
            entry["assessment"] = msg.assessment
        conversation_history.append(entry)
        if msg.phase and msg.role == "tutor":
            current_phase = msg.phase

    state: LearningState = {
        "session_id": session_id,
        "user_id": user.id,
        "topic": topic,
        "user_profile": {},
        "conversation_history": conversation_history,
        "current_phase": current_phase,
        "llm_call_count": session.llm_call_count or 0,
        "credit_activated": session.credit_deducted or body.credit_confirmed or False,
        "is_free_session": session.is_free_session or False,
        "pending_events": [],
        "profile_context": [],
        "journal_context": [],
        "strategy": "",
        "loop_count": 0,
        "actions_taken": [],
    }

    next_message_index = len(messages)

    async def event_generator():
        nonlocal state, next_message_index
        try:
            # Save user message to DB
            user_msg = LearningAgentMessage(
                id=str(uuid4()),
                session_id=session_id,
                message_index=next_message_index,
                role="user",
                content=body.message,
            )
            db.add(user_msg)
            next_message_index += 1

            # Agent loop: plan → action → plan → ... → teach
            state = await learning_nodes.agent_loop(state, db, body.message)

            # Flush all pending events
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Get assessment from last user entry in history
            assessment = None
            for entry in reversed(state.get("conversation_history", [])):
                if entry.get("role") == "user" and entry.get("assessment"):
                    assessment = entry["assessment"]
                    break

            # Save assessment to user message
            if assessment:
                user_msg.assessment = assessment

            # Check if wrap_up
            phase = state.get("current_phase", "explain")
            if phase == "wrap_up":
                # Load profile before wrap_up for insights
                state = await learning_nodes.load_profile(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                state = await learning_nodes.wrap_up(state, db)

                # Extract summary before flushing events
                summary = None
                for ev_data in state.get("pending_events", []):
                    if ev_data.get("event") == "complete":
                        summary = ev_data.get("data", {}).get("summary")

                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                session.status = "completed"

                # Deduct credits for paid sessions (atomic flag)
                if state.get("credit_activated") and not session.credit_deducted:
                    flag_result = await db.execute(
                        update(LearningAgentSession)
                        .where(
                            LearningAgentSession.id == session_id,
                            LearningAgentSession.credit_deducted == False,  # noqa: E712
                        )
                        .values(credit_deducted=True)
                    )
                    if flag_result.rowcount > 0:
                        try:
                            await deduct_for_feature(
                                db, user.id, session_id,
                                "학습 에이전트 세션", CREDIT_COSTS["SESSION"],
                                tx_type="LEARNING_DEBIT",
                            )
                            session.credit_deducted = True
                        except Exception:
                            logger.exception("Credit deduction failed in respond wrap_up")
                            await db.execute(
                                update(LearningAgentSession)
                                .where(LearningAgentSession.id == session_id)
                                .values(credit_deducted=False)
                            )
                            session.status = "abandoned"
                            await db.commit()
                            yield {"event": "error", "data": json.dumps({"error": "크레딧 차감에 실패했습니다"})}
                            return

                # Save activity log
                await _save_activity(db, user.id, session, state.get("conversation_history", []), summary)
            else:
                # Check credit limit for free sessions
                state = await learning_nodes.check_credit(state, db)
                has_credit_prompt = any(
                    ev.get("event") == "credit_prompt"
                    for ev in state.get("pending_events", [])
                )
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                # If credit prompt was sent, stop here (wait for user response)
                if has_credit_prompt:
                    session.llm_call_count = state.get("llm_call_count", 0)
                    await db.commit()
                    return

                # Save tutor message to DB
                tutor_content = ""
                tutor_phase = phase
                for entry in reversed(state.get("conversation_history", [])):
                    if entry.get("role") == "tutor":
                        tutor_content = entry.get("content", "")
                        tutor_phase = entry.get("phase", phase)
                        break

                tutor_msg = LearningAgentMessage(
                    id=str(uuid4()),
                    session_id=session_id,
                    message_index=next_message_index,
                    role="tutor",
                    content=tutor_content,
                    phase=tutor_phase,
                )
                db.add(tutor_msg)
                next_message_index += 1

            # Update session
            session.topic = state.get("topic") or session.topic
            session.llm_call_count = state.get("llm_call_count", 0)
            await db.commit()

            yield {
                "event": "state",
                "data": json.dumps({
                    "phase": state.get("current_phase", "explain"),
                    "topic": state.get("topic", ""),
                    "llmCallCount": state.get("llm_call_count", 0),
                }),
            }

        except Exception:
            logger.exception("Learning agent respond failed")
            yield {"event": "error", "data": json.dumps({"error": "응답 처리에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/nightly-study/{session_id}/end ----------

@router.post("/api/nightly-study/{session_id}/end")
async def end_learning_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually end a learning session."""
    result = await db.execute(
        select(LearningAgentSession)
        .where(
            LearningAgentSession.id == session_id,
            LearningAgentSession.user_id == user.id,
            LearningAgentSession.status == "active",
        )
        .options(selectinload(LearningAgentSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Rebuild state
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history: list[dict] = []
    topic = session.topic or ""

    for msg in messages:
        entry: dict = {"role": msg.role, "content": msg.content}
        if msg.phase:
            entry["phase"] = msg.phase
        if msg.assessment:
            entry["assessment"] = msg.assessment
        conversation_history.append(entry)

    state: LearningState = {
        "session_id": session_id,
        "user_id": user.id,
        "topic": topic,
        "user_profile": {},
        "conversation_history": conversation_history,
        "current_phase": "wrap_up",
        "llm_call_count": session.llm_call_count or 0,
        "credit_activated": session.credit_deducted or False,
        "is_free_session": session.is_free_session or False,
        "pending_events": [],
        "profile_context": [],
        "journal_context": [],
        "strategy": "",
        "loop_count": 0,
        "actions_taken": [],
    }

    async def event_generator():
        nonlocal state
        try:
            # Load profile for wrap_up insights
            state = await learning_nodes.load_profile(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Wrap up
            state = await learning_nodes.wrap_up(state, db)

            # Extract summary BEFORE clearing pending_events
            summary = None
            for ev_data in state.get("pending_events", []):
                if ev_data.get("event") == "complete":
                    summary = ev_data.get("data", {}).get("summary")

            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Mark session completed
            session.status = "completed"

            # Deduct credits for paid sessions (atomic flag)
            if state.get("credit_activated") and not session.credit_deducted:
                flag_result = await db.execute(
                    update(LearningAgentSession)
                    .where(
                        LearningAgentSession.id == session_id,
                        LearningAgentSession.credit_deducted == False,  # noqa: E712
                    )
                    .values(credit_deducted=True)
                )
                if flag_result.rowcount > 0:
                    try:
                        await deduct_for_feature(
                            db, user.id, session_id,
                            "학습 에이전트 세션", CREDIT_COSTS["SESSION"],
                            tx_type="LEARNING_DEBIT",
                        )
                        session.credit_deducted = True
                    except Exception:
                        logger.exception("Failed to deduct credits for learning session")
                        await db.execute(
                            update(LearningAgentSession)
                            .where(LearningAgentSession.id == session_id)
                            .values(credit_deducted=False)
                        )
                        session.status = "abandoned"
                        await db.commit()
                        yield {"event": "error", "data": json.dumps({"error": "크레딧 차감에 실패했습니다"})}
                        return

            # Save activity log
            await _save_activity(db, user.id, session, state.get("conversation_history", []), summary)
            await db.commit()

        except Exception:
            logger.exception("Learning agent end failed")
            yield {"event": "error", "data": json.dumps({"error": "세션 종료에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- Helpers ----------

async def _save_activity(
    db: AsyncSession,
    user_id: str,
    session: LearningAgentSession,
    conversation_history: list[dict],
    summary: dict | None,
) -> None:
    """Save ActivityLog + ActivityItems + DailyProgress."""
    topic = session.topic or ""

    activity_log = ActivityLog(
        id=str(uuid4()),
        user_id=user_id,
        type=ActivityType.LEARNING_AGENT,
        metadata_={"topic": topic, "summary": summary},
    )
    db.add(activity_log)
    await db.flush()

    user_messages = [e for e in conversation_history if e.get("role") == "user"]
    for idx, entry in enumerate(user_messages):
        item = ActivityItem(
            id=str(uuid4()),
            activity_log_id=activity_log.id,
            index=idx,
            question=topic or "학습 대화",
            answer=entry.get("content", ""),
            extra={"phase": entry.get("phase", ""), "assessment": entry.get("assessment")},
        )
        db.add(item)

    try:
        await daily_progress_service.record_progress(
            db,
            user_id=user_id,
            session_data={
                "subjectId": "learning-agent",
                "totalQuestions": len(user_messages),
                "correctCount": len(user_messages),
                "durationSeconds": 0,
                "topicsStudied": [topic] if topic else [],
            },
        )
    except Exception:
        logger.exception("Failed to record daily progress")


# ---------- GET /api/nightly-study/history ----------

@router.get("/api/nightly-study/history")
async def get_history(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get completed learning sessions."""
    result = await db.execute(
        select(LearningAgentSession)
        .where(
            LearningAgentSession.user_id == user.id,
            LearningAgentSession.status.in_(["completed", "timeout"]),
        )
        .order_by(LearningAgentSession.created_at.desc())
        .limit(30)
    )
    sessions = result.scalars().all()

    return [
        {
            "id": s.id,
            "topic": s.topic,
            "status": s.status,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
        }
        for s in sessions
    ]


# ---------- GET /api/nightly-study/status ----------

@router.get("/api/nightly-study/status")
async def learning_session_status(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Check if user has used their free daily session."""
    if settings.is_dev:
        return {"dailyLimitReached": False}

    kst_midnight = _get_kst_midnight()
    stmt = select(LearningAgentSession).where(
        LearningAgentSession.user_id == user.id,
        LearningAgentSession.is_free_session == True,  # noqa: E712
        LearningAgentSession.created_at >= kst_midnight,
    )
    result = await db.execute(stmt)
    today_session = result.scalar_one_or_none()

    return {"dailyLimitReached": today_session is not None}
