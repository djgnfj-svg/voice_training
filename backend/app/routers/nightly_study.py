from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.agent.nightly_study.ns_graph import run_agent_turn, stream_agent_turn
from app.agent.nightly_study.ns_seed import generate_and_insert_seed, normalize_goal
from app.agent.nightly_study.ns_summarizer import generate_session_summary, update_streak_after_session

logger = logging.getLogger(__name__)

router = APIRouter()
KST = timezone(timedelta(hours=9))


def _kst_today() -> date:
    return datetime.now(KST).date()


@router.post("/api/nightly-study/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(text("SELECT id FROM users WHERE id=:u FOR UPDATE"), {"u": user.id})
    await db.execute(
        text("UPDATE learning_sessions SET status='completed', ended_at=NOW() WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )
    await db.commit()

    goal_row = (await db.execute(
        text("SELECT id, title FROM learning_goals WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )).one_or_none()
    goal_id = str(goal_row.id) if goal_row else None
    initial_mode = "learning" if goal_id else "onboarding"
    target_node = await _pick_start_node(db, user.id, goal_id) if goal_id else None

    row = (await db.execute(
        text("""
            INSERT INTO learning_sessions
                (user_id, goal_id, is_free_session, status, target_node_id)
            VALUES (:u, :g, TRUE, 'active', :n)
            RETURNING id
        """),
        {
            "u": user.id,
            "g": goal_id,
            "n": target_node["id"] if target_node else None,
        },
    )).one()
    session_id = str(row.id)
    await db.commit()

    try:
        result = await run_agent_turn(
            db=db,
            session_id=session_id,
            user_id=user.id,
            user_utterance="?몄뀡 ?쒖옉",
            persist_user=False,
        )
        first_text = result.get("final_text") or ""
    except Exception:
        logger.exception("agentic start failed")
        first_text = (
            "?덈뀞?섏꽭?? 癒쇱? ?숈뒿 紐⑺몴? ?꾩옱 以鍮?以묒씤 遺꾩빞瑜?吏㏐쾶 留먰빐 二쇱꽭??"
            if initial_mode == "onboarding"
            else f"?ㅼ떆 ?댁뼱媛 蹂쇨쾶?? ?ㅻ뒛? '{target_node['title']}'遺??蹂쇨퉴??"
            if target_node else "?ㅻ뒛 ?숈뒿???쒖옉??蹂쇨퉴??"
        )
        await db.execute(
            text("""
                INSERT INTO learning_messages (session_id, message_index, role, content, mode, node_id)
                VALUES (:s, 0, 'assistant', :c, :m, :n)
            """),
            {"s": session_id, "c": first_text, "m": initial_mode, "n": target_node["id"] if target_node else None},
        )
        await db.commit()

    return {
        "sessionId": session_id,
        "initialMode": initial_mode,
        "targetNode": target_node,
        "firstMessage": first_text,
    }


class GoalBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/api/nightly-study/goal")
async def set_goal(
    body: GoalBody,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(text("UPDATE learning_goals SET status='archived' WHERE user_id=:u AND status='active'"), {"u": user.id})
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


@router.post("/api/nightly-study/{session_id}/turn")
async def turn(
    session_id: str,
    body: TurnBody,
    background_tasks: BackgroundTasks,
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
    sess = (await db.execute(
        text("SELECT id FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if sess is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    summary_data = await generate_session_summary(db, session_id)
    await db.execute(
        text("""
            UPDATE learning_sessions
            SET status='completed', ended_at=NOW(),
                summary=:sum, highlights=CAST(:h AS jsonb), voice_briefing=:vb,
                pending_action=NULL
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
    streak_state = await update_streak_after_session(db, user.id, _kst_today())
    background_tasks.add_task(_store_insights_bg, session_id, user.id)
    return {
        "summary": summary_data["summary"],
        "highlights": summary_data["highlights"],
        "voiceBriefing": summary_data["voice_briefing"],
        "streakUpdated": streak_state,
    }


@router.get("/api/nightly-study/status")
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
    target = await _pick_start_node(db, user.id, str(goal_row.id)) if goal_row else None
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
                "headline": ((r.highlights or {}).get("headline") or "?숈뒿 ?몄뀡") if isinstance(r.highlights, dict) else "?숈뒿 ?몄뀡",
            }
            for r in recent
        ],
    }


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
        "messages": [{"index": m.message_index, "role": m.role, "content": m.content, "mode": m.mode} for m in msgs],
    }


async def _pick_start_node(db: AsyncSession, user_id: str, goal_id: str | None) -> dict | None:
    if not goal_id:
        return None
    row = (await db.execute(
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
        {"u": user_id, "g": goal_id},
    )).one_or_none()
    if not row:
        return None
    return {"id": str(row.id), "title": row.title, "description": row.description}


async def _store_insights_bg(session_id: str, user_id: str) -> None:
    from app.database import async_session
    from app.agent.nightly_study.ns_rag import insert_learning_memory

    async with async_session() as db:
        try:
            rows = (await db.execute(
                text("""
                    SELECT content, node_id FROM learning_messages
                    WHERE session_id=:s AND role='assistant'
                    ORDER BY message_index DESC LIMIT 2
                """),
                {"s": session_id},
            )).fetchall()
            for row in rows:
                if row.content:
                    await insert_learning_memory(
                        db,
                        user_id=user_id,
                        category="connection",
                        content=row.content[:1000],
                        node_id=str(row.node_id) if row.node_id else None,
                        metadata={"session_id": session_id},
                    )
        except Exception:
            logger.exception("insight extraction failed for session %s", session_id)
