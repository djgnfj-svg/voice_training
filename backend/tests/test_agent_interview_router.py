from __future__ import annotations

from types import SimpleNamespace

from app.routers import agent_interview


def test_latest_question_number_counts_followups():
    messages = [
        SimpleNamespace(role="agent_question", question_number=1),
        SimpleNamespace(role="user_answer", question_number=1),
        SimpleNamespace(role="agent_followup", question_number=2),
    ]

    assert agent_interview._latest_question_number(messages) == 2


def test_dive_followup_metadata_matches_depth():
    state = {"phase": "dive", "current_dive_depth": 2}

    assert agent_interview._question_role_for_state(state) == "agent_followup"
    assert agent_interview._follow_up_round_for_state(state) == 1
