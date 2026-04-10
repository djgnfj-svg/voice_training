# backend/app/agent/graph.py
from __future__ import annotations

from langgraph.graph import StateGraph, END

from app.agent.state import InterviewState


def _route_after_decide(state: InterviewState) -> str:
    """Route based on next_action decided by interviewer agent."""
    action = state.get("next_action", "end")
    if action == "follow_up":
        return "generate_followup"
    elif action == "next_question":
        return "generate_question"
    else:
        return "update_profile"


def build_start_graph() -> StateGraph:
    """Phase 1: Load profile and generate first question."""
    graph = StateGraph(InterviewState)
    graph.add_node("load_profile", lambda state: state)  # placeholder - actual logic in router
    graph.add_node("generate_question", lambda state: state)  # placeholder
    graph.set_entry_point("load_profile")
    graph.add_edge("load_profile", "generate_question")
    graph.add_edge("generate_question", END)
    return graph


def build_answer_graph() -> StateGraph:
    """Phase 2: Evaluate answer and decide next action."""
    graph = StateGraph(InterviewState)
    graph.add_node("evaluate_answer", lambda state: state)  # placeholder
    graph.add_node("decide_next", lambda state: state)  # placeholder
    graph.add_node("generate_question", lambda state: state)  # placeholder
    graph.add_node("generate_followup", lambda state: state)  # placeholder
    graph.add_node("update_profile", lambda state: state)  # placeholder
    graph.add_node("generate_report", lambda state: state)  # placeholder

    graph.set_entry_point("evaluate_answer")
    graph.add_edge("evaluate_answer", "decide_next")
    graph.add_conditional_edges("decide_next", _route_after_decide, {
        "generate_followup": "generate_followup",
        "generate_question": "generate_question",
        "update_profile": "update_profile",
    })
    graph.add_edge("generate_followup", END)
    graph.add_edge("generate_question", END)
    graph.add_edge("update_profile", "generate_report")
    graph.add_edge("generate_report", END)

    return graph
