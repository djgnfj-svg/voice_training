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


def test_dig_followup_metadata_matches_item_depth():
    # item_depth=2 → dig 꼬리질문 (첫 질문은 1).
    state = {"current_item_depth": 2}
    assert agent_interview._question_role_for_state(state) == "agent_followup"
    assert agent_interview._follow_up_round_for_state(state) == 1


def test_base_question_metadata():
    # item_depth=1 → 항목 첫 질문 (꼬리질문 아님).
    state = {"current_item_depth": 1}
    assert agent_interview._question_role_for_state(state) == "agent_question"
    assert agent_interview._follow_up_round_for_state(state) == 0
