# backend/app/agent/learning_nodes.py
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.learning_state import LearningState
from app.agent import tutor_agent, learning_planner
from app.agent.profile_agent import search_profile, update_profile
from app.agent.journal_rag import search_past_context

logger = logging.getLogger(__name__)

FREE_LLM_CALL_LIMIT = 3
MAX_ACTIONS = 4


# ── 에이전트 루프 ──────────────────────────────────────────

async def agent_loop(
    state: LearningState, db: AsyncSession, user_message: str
) -> LearningState:
    """Main agent loop: planner decides actions, executes them, loops back."""
    state = {
        **state,
        "loop_count": 0,
        "actions_taken": list(state.get("actions_taken", [])),
        "profile_context": list(state.get("profile_context", [])),
        "journal_context": list(state.get("journal_context", [])),
    }

    # Store user message + last assessment for planner
    last_assessment = None
    for entry in reversed(state.get("conversation_history", [])):
        if entry.get("role") == "user" and entry.get("assessment"):
            last_assessment = entry["assessment"]
            break

    while state.get("loop_count", 0) < MAX_ACTIONS:
        # Planner 결정
        plan_result = await learning_planner.plan_next_action(
            user_message=user_message,
            topic=state.get("topic", ""),
            phase=state.get("current_phase", "greeting"),
            recent_messages=state.get("conversation_history", []),
            profile_context=state.get("profile_context", []),
            journal_context=state.get("journal_context", []),
            assessment=last_assessment,
            actions_taken=state.get("actions_taken", []),
        )

        action = plan_result["action"]
        state["strategy"] = plan_result["strategy"]
        state["loop_count"] = state.get("loop_count", 0) + 1

        if action == "search_profile":
            state = await search_profile_node(state, db, plan_result.get("search_query", ""))
        elif action == "search_journal":
            state = await search_journal_node(state, db, plan_result.get("search_query", ""))
        elif action == "assess":
            state = await assess(state, db, user_message)
            # Update assessment for next planner call
            for entry in reversed(state.get("conversation_history", [])):
                if entry.get("role") == "user" and entry.get("assessment"):
                    last_assessment = entry["assessment"]
                    break
        elif action == "teach":
            state = await teach(state, db, user_message)
            break
    else:
        # 루프 초과 → 강제 teach
        logger.warning("Learning agent loop exceeded MAX_ACTIONS (%d), forcing teach", MAX_ACTIONS)
        state["strategy"] = state.get("strategy", "explain")
        state = await teach(state, db, user_message)

    return state


# ── 개별 노드 ──────────────────────────────────────────────

async def search_profile_node(
    state: LearningState, db: AsyncSession, query: str
) -> LearningState:
    """Search user profile via RAG."""
    events = list(state.get("pending_events", []))
    actions = list(state.get("actions_taken", []))
    actions.append("search_profile")

    search_query = query or state.get("topic", "") or "개발자 학습 역량"
    results = await search_profile(db, state["user_id"], search_query, top_k=5)

    if results:
        events.append({
            "event": "status",
            "data": {"phase": "profile_context_found", "count": len(results)},
        })

    return {
        **state,
        "profile_context": results,
        "actions_taken": actions,
        "pending_events": events,
    }


async def search_journal_node(
    state: LearningState, db: AsyncSession, query: str
) -> LearningState:
    """Search journal embeddings for cross-context (30 days)."""
    events = list(state.get("pending_events", []))
    actions = list(state.get("actions_taken", []))
    actions.append("search_journal")

    search_query = query or state.get("topic", "")
    results = await search_past_context(db, state["user_id"], search_query)

    if results:
        events.append({
            "event": "status",
            "data": {"phase": "journal_context_found", "count": len(results)},
        })

    return {
        **state,
        "journal_context": results,
        "actions_taken": actions,
        "pending_events": events,
    }


async def load_profile(state: LearningState, db: AsyncSession) -> LearningState:
    """Load user profile from RAG for the current topic (session start)."""
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
    actions = list(state.get("actions_taken", []))
    actions.append("assess")

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
        "actions_taken": actions,
        "pending_events": events,
    }

    if understanding == "topic_selected" or next_phase == "new_topic":
        new_state["topic"] = topic
        new_state["current_phase"] = "explain"

    return new_state


async def teach(
    state: LearningState, db: AsyncSession, user_message: str = ""
) -> LearningState:
    """Generate teaching content based on strategy and context."""
    events = list(state.get("pending_events", []))

    topic = state.get("topic", "")
    phase = state.get("current_phase", "explain")
    strategy = state.get("strategy", "explain")
    profile_context = state.get("profile_context", [])
    journal_context = state.get("journal_context", [])

    result = await tutor_agent.generate_teaching(
        topic, phase, state.get("user_profile", {}),
        state.get("conversation_history", []),
        user_message or "",
        strategy=strategy,
        profile_context=profile_context or None,
        journal_context=journal_context or None,
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

    if len(conversation_history) < 3 or not topic:
        events.append({
            "event": "complete",
            "data": {"summary": None},
        })
        return {
            **state,
            "pending_events": events,
        }

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
