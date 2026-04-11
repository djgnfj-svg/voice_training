# backend/app/agent/journal_nodes.py
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.journal_state import JournalState
from app.agent import journal_planner, journal_router_agent, journal_agent, counseling_agent
from app.agent import journal_extractor, journal_summarizer
from app.agent.journal_rag import search_past_context

logger = logging.getLogger(__name__)

MAX_ACTIONS = 3


# ── 에이전트 루프 ──────────────────────────────────────────

async def agent_loop(state: JournalState, db: AsyncSession) -> JournalState:
    """Main agent loop: planner decides actions, executes them, loops back."""
    state = {
        **state,
        "loop_count": 0,
        "actions_taken": list(state.get("actions_taken", [])),
        "past_context": list(state.get("past_context", [])),
    }

    while state.get("loop_count", 0) < MAX_ACTIONS:
        # Planner 결정
        state = await plan(state, db)
        action = state.get("next_action", "respond")

        if action == "search_past":
            state = await search_past(state, db)
        elif action == "classify_mode":
            state = await classify_mode(state, db)
        elif action == "respond":
            state = await respond(state, db)
            break
    else:
        # 루프 초과 → 강제 응답
        logger.warning("Agent loop exceeded MAX_ACTIONS (%d), forcing respond", MAX_ACTIONS)
        state["strategy"] = state.get("strategy", "deepen")
        state = await respond(state, db)

    # 후처리: 인사이트 추출 (비차단)
    state = await extract(state, db)
    return state


# ── 개별 노드 ──────────────────────────────────────────────

async def plan(state: JournalState, db: AsyncSession) -> JournalState:
    """Planner node: decide next action."""
    result = await journal_planner.plan_next_action(
        user_message=state["user_message"],
        mode=state.get("mode", "journal"),
        recent_messages=state.get("messages", []),
        today_context=state.get("journal_context", []),
        past_context=state.get("past_context", []),
        actions_taken=state.get("actions_taken", []),
    )

    return {
        **state,
        "next_action": result["action"],
        "strategy": result["strategy"],
        "search_query": result.get("search_query", ""),
        "loop_count": state.get("loop_count", 0) + 1,
    }


async def search_past(state: JournalState, db: AsyncSession) -> JournalState:
    """Search past journal entries via RAG (30 days)."""
    events = list(state.get("pending_events", []))
    actions = list(state.get("actions_taken", []))
    actions.append("search_past")

    query = state.get("search_query", state["user_message"])
    results = await search_past_context(db, state["user_id"], query)

    if results:
        events.append({
            "event": "status",
            "data": {"phase": "past_context_found", "count": len(results)},
        })

    return {
        **state,
        "past_context": results,
        "actions_taken": actions,
        "pending_events": events,
    }


async def classify_mode(state: JournalState, db: AsyncSession) -> JournalState:
    """Classify conversation mode (journal/counseling)."""
    events = list(state.get("pending_events", []))
    actions = list(state.get("actions_taken", []))
    actions.append("classify_mode")

    classification = await journal_router_agent.classify_intent(
        state["user_message"],
        state.get("mode", "journal"),
        state.get("messages", []),
    )
    new_mode = classification["mode"]
    current_mode = state.get("mode", "journal")

    if new_mode != current_mode:
        events.append({
            "event": "status",
            "data": {"phase": "mode_change", "mode": new_mode, "reason": classification["reason"]},
        })

    return {
        **state,
        "mode": new_mode,
        "actions_taken": actions,
        "pending_events": events,
    }


async def respond(state: JournalState, db: AsyncSession) -> JournalState:
    """Generate response based on strategy and context."""
    events = list(state.get("pending_events", []))
    messages = list(state.get("messages", []))
    user_message = state["user_message"]
    mode = state.get("mode", "journal")
    strategy = state.get("strategy", "deepen")
    journal_context = state.get("journal_context", [])
    past_context = state.get("past_context", [])

    if mode == "counseling":
        ai_response = await counseling_agent.generate_response(
            messages, user_message, journal_context,
            strategy=strategy, past_context=past_context or None,
        )
    else:
        ai_response = await journal_agent.generate_response(
            messages, user_message, journal_context,
            strategy=strategy, past_context=past_context or None,
        )

    messages.append({"role": "user", "content": user_message, "mode": mode})
    messages.append({"role": "assistant", "content": ai_response, "mode": mode})

    events.append({
        "event": "response",
        "data": {"content": ai_response, "mode": mode},
    })

    return {
        **state,
        "messages": messages,
        "mode": mode,
        "ai_response": ai_response,
        "message_count": state.get("message_count", 0) + 1,
        "pending_events": events,
    }


async def extract(state: JournalState, db: AsyncSession) -> JournalState:
    """Extract insights from conversation and save to RAG."""
    saved = await journal_extractor.extract_and_save(
        db,
        state["user_id"],
        state["session_id"],
        state.get("messages", []),
        state["user_message"],
    )

    events = list(state.get("pending_events", []))
    if saved > 0:
        events.append({
            "event": "extracted",
            "data": {"count": saved},
        })

    return {
        **state,
        "extracted_count": state.get("extracted_count", 0) + saved,
        "pending_events": events,
    }


async def summarize(state: JournalState, db: AsyncSession) -> JournalState:
    """Generate session summary on end."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "summarizing"}})

    result = await journal_summarizer.generate_summary(
        db,
        state["user_id"],
        state["session_id"],
        state.get("messages", []),
    )

    events.append({
        "event": "summary",
        "data": result,
    })

    return {
        **state,
        "session_summary": result.get("summary", ""),
        "pending_events": events,
    }
