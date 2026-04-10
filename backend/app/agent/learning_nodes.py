from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.learning_state import LearningState
from app.agent import tutor_agent
from app.agent.profile_agent import search_profile, update_profile

logger = logging.getLogger(__name__)

FREE_LLM_CALL_LIMIT = 3


async def load_profile(state: LearningState, db: AsyncSession) -> LearningState:
    """Load user profile from RAG for the current topic."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "loading_profile"}})

    query = state.get("topic") or "개발자 학습 역량 종합"
    profiles = await search_profile(db, state["user_id"], query, top_k=10)

    CATEGORY_KEY = {
        "strength": "strengths",
        "weakness": "weaknesses",
        "pattern": "patterns",
        "context": "context",
        "learning_progress": "learning_progress",
    }
    organized: dict[str, list[str]] = {
        "strengths": [],
        "weaknesses": [],
        "patterns": [],
        "context": [],
        "learning_progress": [],
    }
    for p in profiles:
        cat = p["category"]
        key = CATEGORY_KEY.get(cat)
        if key and key in organized:
            organized[key].append(p["content"])

    events.append({"event": "status", "data": {"phase": "profile_loaded"}})

    return {
        **state,
        "user_profile": organized,
        "pending_events": events,
    }


async def greet(state: LearningState, db: AsyncSession) -> LearningState:
    """Generate a greeting message from the tutor."""
    events = list(state.get("pending_events", []))

    result = await tutor_agent.generate_greeting(state.get("user_profile", {}))
    message = result.get("message", "안녕하세요! 오늘 어떤 주제를 공부해볼까요?")

    events.append({"event": "tutor", "data": {"message": message, "phase": "greeting"}})

    history = list(state.get("conversation_history", []))
    history.append({"role": "tutor", "content": message, "phase": "greeting"})

    return {
        **state,
        "conversation_history": history,
        "llm_call_count": state.get("llm_call_count", 0) + 1,
        "pending_events": events,
    }


async def assess(
    state: LearningState, db: AsyncSession, user_message: str
) -> LearningState:
    """Assess user understanding and determine next phase."""
    events = list(state.get("pending_events", []))

    result = await tutor_agent.assess_understanding(
        state.get("topic", ""),
        state.get("current_phase", "greeting"),
        state.get("conversation_history", []),
        user_message,
    )

    understanding = result.get("understanding", "partial")
    next_phase = result.get("next_phase", "explain")
    topic = result.get("topic", state.get("topic", ""))

    history = list(state.get("conversation_history", []))
    history.append({
        "role": "user",
        "content": user_message,
        "assessment": {
            "understanding": understanding,
            "weak_points": result.get("weak_points", []),
            "next_phase": next_phase,
            "reasoning": result.get("reasoning", ""),
        },
    })

    new_state = {
        **state,
        "conversation_history": history,
        "current_phase": next_phase if next_phase != "new_topic" else "explain",
        "llm_call_count": state.get("llm_call_count", 0) + 1,
        "pending_events": events,
    }

    # Handle topic selection / change
    if understanding == "topic_selected" or next_phase == "new_topic":
        new_state["topic"] = topic
        new_state["current_phase"] = "explain"

    return new_state


async def teach(state: LearningState, db: AsyncSession) -> LearningState:
    """Generate teaching content based on current phase."""
    events = list(state.get("pending_events", []))

    topic = state.get("topic", "")
    phase = state.get("current_phase", "explain")

    # If topic exists but profile not loaded for this topic, load it
    if topic and not state.get("user_profile"):
        state = await load_profile(state, db)
        events = list(state.get("pending_events", []))

    # Get last user message from history
    user_message = ""
    for entry in reversed(state.get("conversation_history", [])):
        if entry.get("role") == "user":
            user_message = entry.get("content", "")
            break

    result = await tutor_agent.generate_teaching(
        topic,
        phase,
        state.get("user_profile", {}),
        state.get("conversation_history", []),
        user_message,
    )

    message = result.get("message", "")

    events.append({"event": "tutor", "data": {"message": message, "phase": phase}})

    history = list(state.get("conversation_history", []))
    history.append({"role": "tutor", "content": message, "phase": phase})

    return {
        **state,
        "conversation_history": history,
        "llm_call_count": state.get("llm_call_count", 0) + 1,
        "pending_events": events,
    }


async def check_credit(state: LearningState, db: AsyncSession) -> LearningState:
    """Check if free session has hit the LLM call limit."""
    events = list(state.get("pending_events", []))

    is_free = state.get("is_free_session", False)
    credit_activated = state.get("credit_activated", False)
    llm_call_count = state.get("llm_call_count", 0)

    if is_free and not credit_activated and llm_call_count >= FREE_LLM_CALL_LIMIT:
        events.append({
            "event": "credit_prompt",
            "data": {"llmCallCount": llm_call_count, "limit": FREE_LLM_CALL_LIMIT},
        })

    return {
        **state,
        "pending_events": events,
    }


async def wrap_up(state: LearningState, db: AsyncSession) -> LearningState:
    """Generate session summary and save profile insights."""
    events = list(state.get("pending_events", []))

    topic = state.get("topic", "")
    conversation_history = state.get("conversation_history", [])

    # Only generate summary if there's enough conversation and a topic
    if len(conversation_history) < 3 or not topic:
        events.append({
            "event": "complete",
            "data": {"summary": None},
        })
        return {
            **state,
            "pending_events": events,
        }

    # Generate summary
    try:
        summary = await tutor_agent.generate_summary(
            topic, conversation_history, state.get("user_profile", {})
        )
    except Exception:
        logger.exception("Failed to generate session summary")
        summary = {
            "topicCovered": topic,
            "keyPoints": [],
            "strengths": [],
            "weaknesses": [],
            "nextTopicSuggestion": "",
            "encouragement": "오늘도 수고했어요!",
        }

    # Extract and save profile insights to RAG
    try:
        insights = await tutor_agent.extract_profile_insights(topic, conversation_history)

        user_id = state["user_id"]
        session_id = state.get("session_id", "")
        metadata = {"session_id": session_id, "source": "learning_agent"}

        for strength in insights.get("strengths", []):
            if strength.strip():
                await update_profile(db, user_id, "strength", strength.strip(), metadata)

        for weakness in insights.get("weaknesses", []):
            if weakness.strip():
                await update_profile(db, user_id, "weakness", weakness.strip(), metadata)

        for progress in insights.get("learning_progress", []):
            if progress.strip():
                await update_profile(db, user_id, "learning_progress", progress.strip(), metadata)
    except Exception:
        logger.exception("Failed to extract/save profile insights")

    events.append({"event": "complete", "data": {"summary": summary}})

    return {
        **state,
        "pending_events": events,
    }
