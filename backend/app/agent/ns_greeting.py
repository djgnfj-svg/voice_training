from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.ns_rag import search_learning_memory
from app.lib.llm_client import call_llm
from app.prompts.nightly_study import CONTINUATION_GREETING_PROMPT

logger = logging.getLogger(__name__)

_GREETING_LLM_TIMEOUT_SEC = 3.0
_GREETING_CONTEXT_TIMEOUT_SEC = 2.0


async def generate_continuation_greeting(
    db: AsyncSession,
    user_id: str,
    goal_id: str | None,
    target_node: dict | None,
    fallback: str,
) -> str:
    """
    Build a LLM-generated "이어가기" greeting based on past sessions, weak nodes, and RAG hits.
    Returns `fallback` string on any failure / timeout / empty context.
    """
    try:
        ctx = await asyncio.wait_for(
            _collect_context(db, user_id, goal_id, target_node),
            timeout=_GREETING_CONTEXT_TIMEOUT_SEC,
        )
        if not ctx["has_anything"]:
            return fallback

        prompt = (
            CONTINUATION_GREETING_PROMPT
            .replace("{last_session_summary}", ctx["last_session_summary"] or "(없음)")
            .replace("{weak_nodes}", ", ".join(ctx["weak_nodes"]) or "(없음)")
            .replace("{rag_snippets}", " / ".join(ctx["rag_snippets"]) or "(없음)")
            .replace("{target_node}", (target_node or {}).get("title") or "(미정)")
        )

        text_out = await asyncio.wait_for(call_llm(prompt), timeout=_GREETING_LLM_TIMEOUT_SEC)
        text_out = (text_out or "").strip()
        if not text_out:
            return fallback
        return text_out[:200]  # 프롬프트 위반 시 안전 컷
    except asyncio.TimeoutError:
        logger.warning("continuation greeting LLM timed out, using fallback")
        return fallback
    except Exception:
        logger.exception("continuation greeting failed, using fallback")
        return fallback


async def _collect_context(
    db: AsyncSession,
    user_id: str,
    goal_id: str | None,
    target_node: dict | None,
) -> dict:
    # 1) 직전 세션 요약
    last_row = (await db.execute(
        text("""
            SELECT summary FROM learning_sessions
            WHERE user_id=:u AND status='completed' AND summary IS NOT NULL
            ORDER BY ended_at DESC NULLS LAST LIMIT 1
        """),
        {"u": user_id},
    )).one_or_none()
    last_session_summary = last_row.summary if last_row else None

    # 2) 최근 7일 약점 top-3 (proficiency 낮은 순)
    weak_rows = (await db.execute(
        text("""
            SELECT cn.title
            FROM node_mastery nm
            JOIN curriculum_nodes cn ON cn.id = nm.node_id
            WHERE nm.user_id=:u
              AND nm.updated_at >= NOW() - INTERVAL '7 days'
            ORDER BY nm.proficiency ASC, nm.updated_at DESC
            LIMIT 3
        """),
        {"u": user_id},
    )).fetchall()
    weak_nodes = [r.title for r in weak_rows]

    # 3) RAG top-3: 오늘 target의 제목을 쿼리로 사용
    rag_snippets: list[str] = []
    target_title = (target_node or {}).get("title")
    if target_title:
        try:
            hits = await search_learning_memory(db, user_id=user_id, query=target_title, top_k=3)
            rag_snippets = [h["content"] for h in hits if h.get("content")]
        except Exception:
            logger.exception("RAG fetch in continuation greeting failed; continuing")

    has_anything = bool(last_session_summary or weak_nodes or rag_snippets)
    return {
        "last_session_summary": last_session_summary,
        "weak_nodes": weak_nodes,
        "rag_snippets": rag_snippets,
        "has_anything": has_anything,
    }
