# backend/app/agent/nodes.py
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.state import InterviewState
from app.agent import profile_agent, interviewer_agent, evaluator_agent

logger = logging.getLogger(__name__)


async def load_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Load user profile from RAG."""
    profile = await profile_agent.load_user_profile(
        db,
        state["user_id"],
        state["resume"],
        state.get("job_posting"),
    )
    return {
        **state,
        "user_profile": profile,
        "pending_events": state.get("pending_events", []) + [
            {"event": "status", "data": {"phase": "profile_loaded"}},
        ],
    }


async def generate_question(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate next interview question."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_question"}})

    result = await interviewer_agent.generate_question(
        state["resume"],
        state.get("job_posting"),
        state["user_profile"],
        state.get("conversation_history", []),
    )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "followUpRound": 0,
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    })

    return {
        **state,
        "current_question": question,
        "question_count": question_count,
        "follow_up_round": 0,
        "pending_events": events,
    }


async def generate_followup(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate follow-up question."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_followup"}})

    result = await interviewer_agent.generate_followup(
        state.get("conversation_history", []),
        state.get("current_evaluation", {}),
    )

    question = result.get("question", "")
    follow_up_round = state.get("follow_up_round", 0) + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": state.get("question_count", 1),
            "followUpRound": follow_up_round,
        },
    })

    return {
        **state,
        "current_question": question,
        "follow_up_round": follow_up_round,
        "pending_events": events,
    }


async def evaluate_answer(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Evaluate user's answer."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "evaluating"}})

    evaluation = await evaluator_agent.evaluate_answer(
        state["current_question"],
        state["current_answer"],
        state.get("user_profile", {}),
        state.get("conversation_history", []),
    )

    # Append to conversation history
    history = list(state.get("conversation_history", []))
    history.append({
        "question": state["current_question"],
        "answer": state["current_answer"],
        "evaluation": evaluation,
        "question_number": state.get("question_count", 1),
        "follow_up_round": state.get("follow_up_round", 0),
    })

    events.append({
        "event": "evaluation",
        "data": {
            "overallScore": evaluation.get("overallScore", 0),
            "briefFeedback": evaluation.get("briefFeedback", ""),
            "detailedFeedback": evaluation.get("detailedFeedback", ""),
            "modelAnswer": evaluation.get("modelAnswer", ""),
            "scores": evaluation.get("scores", {}),
        },
    })

    return {
        **state,
        "current_evaluation": evaluation,
        "conversation_history": history,
        "pending_events": events,
    }


async def decide_next(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Decide next action after evaluation."""
    result = await interviewer_agent.decide_next_action(
        state.get("conversation_history", []),
        state.get("current_evaluation", {}),
        state.get("question_count", 0),
        state.get("max_questions", 7),
        state.get("follow_up_round", 0),
    )

    action = result.get("action", "next_question")

    return {
        **state,
        "next_action": action,
        "pending_events": state.get("pending_events", []),
    }


async def update_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Save session insights to user profile RAG."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "updating_profile"}})

    await profile_agent.save_session_insights(
        db,
        state["user_id"],
        state.get("conversation_history", []),
        state["session_id"],
    )

    return {
        **state,
        "pending_events": events,
    }


async def generate_report(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate overall report."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_report"}})

    report = await evaluator_agent.generate_report(
        state.get("conversation_history", []),
        state.get("user_profile", {}),
    )

    events.append({"event": "complete", "data": {"report": report}})

    return {
        **state,
        "overall_report": report,
        "pending_events": events,
    }
