from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.config import settings
from app.database import async_session, get_db
from app.dependencies import AuthUser, get_current_user, get_current_user_ws
from app.agent.learning_coach.graph import pick_start_node, run_end_graph, run_start_graph, stream_agent_turn
from app.agent.learning_coach.curriculum_seed import generate_and_insert_seed, normalize_goal
from app.agent.learning_coach.realtime_relay import get_daily_seconds_used, run_realtime_session

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/learning-coach/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await run_start_graph(db, user.id)


class GoalBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/api/learning-coach/goal")
async def set_goal(
    body: GoalBody,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        text("UPDATE learning_goals SET status='archived' WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )
    row = (await db.execute(
        text("""
            INSERT INTO learning_goals (user_id, title, normalized_goal, status)
            VALUES (:u, :t, :n, 'active')
            RETURNING id
        """),
        {"u": user.id, "t": body.title, "n": normalize_goal(body.title)},
    )).one()
    goal_id = str(row.id)
    await db.execute(
        text("""
            INSERT INTO learning_user_profiles (user_id, current_goal, preferences)
            VALUES (:u, :g, '{}'::jsonb)
            ON CONFLICT (user_id) DO UPDATE SET current_goal=:g, updated_at=NOW()
        """),
        {"u": user.id, "g": body.title},
    )
    await db.commit()

    try:
        count = await generate_and_insert_seed(db, goal_id, body.title)
    except Exception:
        logger.exception("seed generation failed")
        raise HTTPException(status_code=500, detail={"error": "커리큘럼 생성에 실패했어요. 잠시 후 다시 시도해주세요."})

    return {"goalId": goal_id, "seedNodeCount": count}


class TurnBody(BaseModel):
    userUtterance: str = Field(min_length=1, max_length=5000)


@router.post("/api/learning-coach/{session_id}/turn")
async def turn(
    session_id: str,
    body: TurnBody,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    own = (await db.execute(
        text("SELECT 1 FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if own is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    async def event_stream():
        try:
            async for ev in stream_agent_turn(db, session_id, user.id, body.userUtterance):
                yield {"event": ev["type"], "data": json.dumps(ev["data"], ensure_ascii=False)}
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("turn stream failed")
            yield {"event": "error", "data": json.dumps({"error": "응답 생성 중 문제가 생겼어요. 다시 시도해주세요."}, ensure_ascii=False)}

    return EventSourceResponse(event_stream())


@router.websocket("/api/learning-coach/{session_id}/realtime")
async def realtime(websocket: WebSocket, session_id: str):
    """Full-duplex voice session over WebSocket (OpenAI Realtime relay).

    Gated before ``accept``: NextAuth cookie auth, kill-switch, session
    ownership, and a per-day voice-minute pre-check. Falls back to the turn-based
    ``/turn`` path on any failure (the client downgrades gracefully on close).
    Uses WebSocket application close codes (4xxx) to signal the reason.
    """
    # 1) Auth before accept — close 4401 on failure so the client can fall back.
    user = await get_current_user_ws(websocket)
    if user is None:
        await websocket.close(code=4401)
        return

    # 2) Kill-switch — feature disabled means immediate fallback to turn-based.
    if not settings.REALTIME_VOICE_ENABLED:
        await websocket.close(code=4403)
        return

    # 3) Ownership + active status (same query as REST /turn) and daily pre-check.
    async with async_session() as db:
        own = (
            await db.execute(
                text(
                    "SELECT 1 FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"
                ),
                {"s": session_id, "u": user.id},
            )
        ).one_or_none()
        if own is None:
            await websocket.close(code=4404)
            return

        used = await get_daily_seconds_used(db, user.id)
        remaining = settings.REALTIME_DAILY_MAX_SEC - used
        if remaining <= 0:
            await websocket.close(code=4429)
            return

        # 4) All gates passed — accept and hand off to the relay.
        await websocket.accept()
        await run_realtime_session(
            websocket,
            db,
            session_id,
            user.id,
            daily_remaining_sec=remaining,
        )


class EndBody(BaseModel):
    reason: str = Field(default="user")


@router.post("/api/learning-coach/{session_id}/end")
async def end_session(
    session_id: str,
    body: EndBody,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sess = (await db.execute(
        text("SELECT id FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if sess is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    return await run_end_graph(db, session_id, user.id)


@router.get("/api/learning-coach/status")
async def status(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    streak_row = (await db.execute(
        text("SELECT current_streak, longest_streak, total_sessions, total_nodes_learned FROM learning_streaks WHERE user_id=:u"),
        {"u": user.id},
    )).one_or_none()
    goal_row = (await db.execute(
        text("SELECT id FROM learning_goals WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )).one_or_none()
    target = await pick_start_node(db, user.id, str(goal_row.id)) if goal_row else None
    recent = (await db.execute(
        text("""
            SELECT id, started_at, ended_at, highlights
            FROM learning_sessions
            WHERE user_id=:u AND status='completed'
            ORDER BY started_at DESC LIMIT 5
        """),
        {"u": user.id},
    )).fetchall()
    return {
        "streak": {
            "current": streak_row.current_streak if streak_row else 0,
            "longest": streak_row.longest_streak if streak_row else 0,
            "totalSessions": streak_row.total_sessions if streak_row else 0,
            "totalNodesLearned": streak_row.total_nodes_learned if streak_row else 0,
        },
        "hasGoal": goal_row is not None,
        "todayTargetNode": target,
        "recentSessions": [
            {
                "id": str(r.id),
                "startedAt": r.started_at.isoformat() if r.started_at else None,
                "endedAt": r.ended_at.isoformat() if r.ended_at else None,
                "headline": ((r.highlights or {}).get("headline") or "학습 세션") if isinstance(r.highlights, dict) else "학습 세션",
            }
            for r in recent
        ],
    }


@router.get("/api/learning-coach/sessions/{session_id}")
async def get_session_detail(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sess = (await db.execute(
        text("""
            SELECT id, started_at, ended_at, summary, highlights, voice_briefing
            FROM learning_sessions WHERE id=:s AND user_id=:u
        """),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if sess is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})
    msgs = (await db.execute(
        text("SELECT message_index, role, content, mode FROM learning_messages WHERE session_id=:s ORDER BY message_index"),
        {"s": session_id},
    )).fetchall()
    return {
        "session": {
            "id": str(sess.id),
            "startedAt": sess.started_at.isoformat() if sess.started_at else None,
            "endedAt": sess.ended_at.isoformat() if sess.ended_at else None,
            "summary": sess.summary,
        },
        "highlights": sess.highlights,
        "voiceBriefing": sess.voice_briefing,
        "messages": [{"index": m.message_index, "role": m.role, "content": m.content, "mode": m.mode} for m in msgs],
    }
