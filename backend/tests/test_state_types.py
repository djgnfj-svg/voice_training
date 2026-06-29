"""Verify InterviewState fields for JD rubric coverage structure."""
from app.agent.interview.state import InterviewState, RubricItem


def test_rubric_item_shape():
    item: RubricItem = {
        "id": "r1",
        "label": "FastAPI 비동기 API 설계",
        "jd_requirement": "FastAPI 기반 비동기 API 설계 경험",
        "importance": "must",
        "has_evidence": True,
        "evidence_refs": ["FastAPI"],
        "query": "FastAPI 비동기 API",
    }
    assert item["id"] == "r1"
    assert item["importance"] in ("must", "nice")
    assert item["has_evidence"] is True
    assert "FastAPI" in item["evidence_refs"]


def test_interview_state_has_rubric_fields():
    state: InterviewState = {
        "rubric_plan": [],
        "coverage": [],
        "current_rubric_idx": 0,
        "current_item_depth": 0,
    }
    assert state["rubric_plan"] == []
    assert state["coverage"] == []
    assert state["current_rubric_idx"] == 0
    assert state["current_item_depth"] == 0
