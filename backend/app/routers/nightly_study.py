from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta, date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.config import settings
from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.services.credit import deduct_for_feature, InsufficientCreditsError
from app.agent.ns_orchestrator import run_turn
from app.agent.ns_seed import generate_and_insert_seed, normalize_goal
from app.agent.ns_summarizer import generate_session_summary, update_streak_after_session

logger = logging.getLogger(__name__)

router = APIRouter()

KST = timezone(timedelta(hours=9))

FREE_COST = 0
EXTRA_COST = 1  # 추가 세션 1 코인


def _kst_today() -> date:
    return datetime.now(KST).date()


def _kst_today_utc_midnight() -> datetime:
    now_kst = datetime.now(KST)
    midnight_kst = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_kst.astimezone(timezone.utc).replace(tzinfo=None)


# ---------- POST /api/nightly-study/start ----------

@router.post("/api/nightly-study/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 0. Auto-close any existing active session for this user
    await db.execute(
        text("UPDATE learning_sessions SET status='completed', ended_at=NOW() WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )
    await db.commit()

    # 1. Daily free check (skip in dev)
    midnight_utc = _kst_today_utc_midnight()
    is_free = False
    if settings.is_dev:
        is_free = True
    else:
        existing_free_row = (await db.execute(
            text("""
                SELECT 1 FROM learning_sessions
                WHERE user_id=:u AND is_free_session=TRUE AND started_at >= :m
                LIMIT 1
            """),
            {"u": user.id, "m": midnight_utc},
        )).one_or_none()
        if existing_free_row is None:
            is_free = True
        else:
            # Need credit
            try:
                await deduct_for_feature(
                    db=db, user_id=user.id, reference_id="nightly-study-extra",
                    description="오늘의 학습 추가 세션", cost=EXTRA_COST, tx_type="FEATURE_DEBIT",
                )
            except InsufficientCreditsError:
                raise HTTPException(
                    status_code=402,
                    detail={"error": "크레딧이 부족해요", "code": "INSUFFICIENT_CREDITS"},
                )

    # 2. Check goal
    goal_row = (await db.execute(
        text("SELECT id, title FROM learning_goals WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )).one_or_none()

    goal_id = str(goal_row.id) if goal_row else None
    initial_mode = "learning" if goal_id else "onboarding"

    # 3. Pick target node if goal exists
    target_node = None
    if goal_id:
        tn_row = (await db.execute(
            text("""
                SELECT cn.id, cn.title, cn.description
                FROM curriculum_nodes cn
                LEFT JOIN node_mastery nm ON nm.node_id = cn.id AND nm.user_id=:u
                WHERE cn.goal_id=:g
                ORDER BY
                    CASE WHEN nm.next_review_at IS NULL OR nm.next_review_at <= NOW() THEN 0 ELSE 1 END,
                    nm.proficiency ASC NULLS FIRST,
                    cn.depth_level ASC
                LIMIT 1
            """),
            {"u": user.id, "g": goal_id},
        )).one_or_none()
        if tn_row:
            target_node = {"id": str(tn_row.id), "title": tn_row.title, "description": tn_row.description}

    # 4. Create session
    result = await db.execute(
        text("""
            INSERT INTO learning_sessions (user_id, goal_id, is_free_session, credit_deducted, status)
            VALUES (:u, :g, :f, :c, 'active')
            RETURNING id
        """),
        {"u": user.id, "g": goal_id, "f": is_free, "c": 0 if is_free else EXTRA_COST},
    )
    row = result.one()
    session_id = str(row.id)
    await db.commit()

    # 5. Seed the first assistant message (non-LLM, fixed greeting for onboarding or learning)
    if initial_mode == "onboarding":
        first_text = "어떤 개발자가 되고 싶으세요?"
        first_node_id = None
    else:
        first_text = f"다시 오셨네요. 오늘은 '{target_node['title']}' 해볼까요?" if target_node else "오늘도 시작해볼까요?"
        first_node_id = target_node["id"] if target_node else None

    await db.execute(
        text("""
            INSERT INTO learning_messages (session_id, message_index, role, content, mode, node_id)
            VALUES (:s, 0, 'assistant', :c, :m, :n)
        """),
        {"s": session_id, "c": first_text, "m": initial_mode, "n": first_node_id},
    )
    await db.commit()

    return {
        "sessionId": session_id,
        "initialMode": initial_mode,
        "targetNode": target_node,
        "firstMessage": first_text,
    }


# ---------- POST /api/nightly-study/goal (온보딩 + 변경 겸용) ----------

class GoalBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/api/nightly-study/goal")
async def set_goal(
    body: GoalBody,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Archive existing active goal
    await db.execute(
        text("UPDATE learning_goals SET status='archived' WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )
    # Insert new active goal
    result = await db.execute(
        text("""
            INSERT INTO learning_goals (user_id, title, normalized_goal, status)
            VALUES (:u, :t, :n, 'active')
            RETURNING id
        """),
        {"u": user.id, "t": body.title, "n": normalize_goal(body.title)},
    )
    row = result.one()
    goal_id = str(row.id)
    await db.commit()

    # Generate seed synchronously (called from non-voice context, e.g. settings)
    try:
        count = await generate_and_insert_seed(db, goal_id, body.title)
    except Exception:
        logger.exception("seed generation failed")
        raise HTTPException(
            status_code=500,
            detail={"error": "커리큘럼 생성에 실패했어요. 잠시 후 다시 시도해주세요."},
        )

    return {"goalId": goal_id, "seedNodeCount": count}


# ---------- POST /api/nightly-study/{session_id}/turn ----------

class TurnBody(BaseModel):
    userUtterance: str = Field(min_length=1, max_length=5000)


@router.post("/api/nightly-study/{session_id}/turn")
async def turn(
    session_id: str,
    body: TurnBody,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Ownership check
    own = (await db.execute(
        text("SELECT 1 FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if own is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    async def event_stream():
        try:
            async for ev in run_turn(
                db=db,
                session_id=session_id,
                user_id=user.id,
                user_utterance=body.userUtterance,
                background_tasks=background_tasks,
            ):
                yield {"event": ev["type"], "data": json.dumps(ev["data"], ensure_ascii=False)}
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("turn stream failed")
            yield {"event": "error", "data": json.dumps({"error": "잠깐 문제가 생겼어요. 다시 시도해주세요."})}

    return EventSourceResponse(event_stream())


# ---------- POST /api/nightly-study/{session_id}/end ----------

class EndBody(BaseModel):
    reason: str = Field(default="user")


@router.post("/api/nightly-study/{session_id}/end")
async def end_session(
    session_id: str,
    body: EndBody,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Ownership + active check
    sess = (await db.execute(
        text("SELECT id, user_id FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if sess is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    # Generate summary
    summary_data = await generate_session_summary(db, session_id)

    # Mark completed + persist summary
    await db.execute(
        text("""
            UPDATE learning_sessions
            SET status='completed', ended_at=NOW(),
                summary=:sum, highlights=CAST(:h AS jsonb), voice_briefing=:vb
            WHERE id=:s
        """),
        {
            "s": session_id,
            "sum": summary_data["summary"],
            "h": json.dumps(summary_data["highlights"], ensure_ascii=False),
            "vb": summary_data["voice_briefing"],
        },
    )
    await db.commit()

    # Update streak
    streak_state = await update_streak_after_session(db, user.id, _kst_today())

    # Background: store insights to learning_embeddings
    background_tasks.add_task(_store_insights_bg, session_id, user.id)

    return {
        "summary": summary_data["summary"],
        "highlights": summary_data["highlights"],
        "voiceBriefing": summary_data["voice_briefing"],
        "streakUpdated": streak_state,
    }


async def _store_insights_bg(session_id: str, user_id: str) -> None:
    """Background: extract and store learning_embeddings (misconception/explanation)."""
    from app.database import async_session
    from app.agent.ns_rag import insert_learning_memory
    async with async_session() as db:
        try:
            rows = (await db.execute(
                text("""
                    SELECT tool_calls, node_id FROM learning_messages
                    WHERE session_id=:s AND role='assistant' AND tool_calls IS NOT NULL
                """),
                {"s": session_id},
            )).fetchall()
            for r in rows:
                tc = r.tool_calls or {}
                planner = tc.get("planner") or {}
                evaluation = planner.get("evaluation") or {}
                note = planner.get("briefing_note")
                misc = evaluation.get("misconception")
                if misc:
                    await insert_learning_memory(
                        db, user_id=user_id, category="misconception",
                        content=misc, node_id=str(r.node_id) if r.node_id else None,
                    )
                if note:
                    await insert_learning_memory(
                        db, user_id=user_id, category="connection",
                        content=note, node_id=str(r.node_id) if r.node_id else None,
                    )
        except Exception:
            logger.exception("insight extraction failed for session %s", session_id)


# ---------- GET /api/nightly-study/status ----------

@router.get("/api/nightly-study/status")
async def status(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    midnight_utc = _kst_today_utc_midnight()

    # Daily free used?
    used_row = (await db.execute(
        text("""
            SELECT 1 FROM learning_sessions
            WHERE user_id=:u AND is_free_session=TRUE AND started_at >= :m LIMIT 1
        """),
        {"u": user.id, "m": midnight_utc},
    )).one_or_none()
    daily_free_used = used_row is not None

    # Credit balance
    cb_row = (await db.execute(
        text('SELECT credit_balance FROM users WHERE id=:u'),
        {"u": user.id},
    )).one()
    credit_balance = cb_row.credit_balance

    # Streak
    s_row = (await db.execute(
        text("SELECT current_streak, longest_streak, total_sessions, total_nodes_learned FROM learning_streaks WHERE user_id=:u"),
        {"u": user.id},
    )).one_or_none()
    streak = {
        "current": s_row.current_streak if s_row else 0,
        "longest": s_row.longest_streak if s_row else 0,
        "totalSessions": s_row.total_sessions if s_row else 0,
        "totalNodesLearned": s_row.total_nodes_learned if s_row else 0,
    }

    # Goal / today target node
    goal_row = (await db.execute(
        text("SELECT id FROM learning_goals WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )).one_or_none()
    has_goal = goal_row is not None

    today_target = None
    if has_goal:
        tn_row = (await db.execute(
            text("""
                SELECT cn.title, cn.description
                FROM curriculum_nodes cn
                LEFT JOIN node_mastery nm ON nm.node_id = cn.id AND nm.user_id=:u
                WHERE cn.goal_id=:g
                ORDER BY
                    CASE WHEN nm.next_review_at IS NULL OR nm.next_review_at <= NOW() THEN 0 ELSE 1 END,
                    nm.proficiency ASC NULLS FIRST,
                    cn.depth_level ASC
                LIMIT 1
            """),
            {"u": user.id, "g": str(goal_row.id)},
        )).one_or_none()
        if tn_row:
            today_target = {"title": tn_row.title, "description": tn_row.description}

    # Recent 5 sessions
    rs_rows = (await db.execute(
        text("""
            SELECT id, started_at, ended_at, highlights
            FROM learning_sessions
            WHERE user_id=:u AND status='completed'
            ORDER BY started_at DESC LIMIT 5
        """),
        {"u": user.id},
    )).fetchall()
    recent_sessions = []
    for r in rs_rows:
        headline = None
        if r.highlights and isinstance(r.highlights, dict):
            headline = r.highlights.get("headline")
        recent_sessions.append({
            "id": str(r.id),
            "startedAt": r.started_at.isoformat() if r.started_at else None,
            "endedAt": r.ended_at.isoformat() if r.ended_at else None,
            "headline": headline or "학습 세션",
        })

    return {
        "dailyFreeUsed": daily_free_used,
        "creditBalance": credit_balance,
        "streak": streak,
        "hasGoal": has_goal,
        "todayTargetNode": today_target,
        "recentSessions": recent_sessions,
    }


# ---------- GET /api/nightly-study/sessions/{session_id} ----------

@router.get("/api/nightly-study/sessions/{session_id}")
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
        "messages": [
            {"index": m.message_index, "role": m.role, "content": m.content, "mode": m.mode}
            for m in msgs
        ],
    }
