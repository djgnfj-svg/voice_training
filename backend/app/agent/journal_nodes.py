from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.journal_state import JournalState
from app.agent import journal_router_agent, journal_agent, counseling_agent
from app.agent import journal_extractor, journal_summarizer

logger = logging.getLogger(__name__)


async def route_and_respond(state: JournalState, db: AsyncSession) -> JournalState:
    """Route user message to journal or counseling agent, generate response."""
    events = list(state.get("pending_events", []))
    messages = list(state.get("messages", []))
    user_message = state["user_message"]
    current_mode = state.get("mode", "journal")

    # 1. Classify intent
    classification = await journal_router_agent.classify_intent(
        user_message,
        current_mode,
        messages,
    )
    new_mode = classification["mode"]

    # Notify mode change if switched
    if new_mode != current_mode:
        events.append({
            "event": "status",
            "data": {"phase": "mode_change", "mode": new_mode, "reason": classification["reason"]},
        })

    # 2. Generate response based on mode
    journal_context = state.get("journal_context", [])

    if new_mode == "counseling":
        ai_response = await counseling_agent.generate_response(messages, user_message, journal_context)
    else:
        ai_response = await journal_agent.generate_response(messages, user_message, journal_context)

    # 3. Update messages
    messages.append({"role": "user", "content": user_message, "mode": new_mode})
    messages.append({"role": "assistant", "content": ai_response, "mode": new_mode})

    events.append({
        "event": "response",
        "data": {"content": ai_response, "mode": new_mode},
    })

    return {
        **state,
        "messages": messages,
        "mode": new_mode,
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
