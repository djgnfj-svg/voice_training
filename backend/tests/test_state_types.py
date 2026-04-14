"""Verify new InterviewState fields for Scan+Dive structure."""
from app.agent.state import InterviewState, ScanItem, DiveTopic


def test_scan_item_shape():
    item: ScanItem = {
        "project_ref": "크롤링",
        "query": "웹 크롤링 Selenium",
        "reason": "jd_match",
    }
    assert item["project_ref"] == "크롤링"
    assert item["reason"] in ("jd_match", "jd_unmatched", "project_order")


def test_dive_topic_shape():
    topic: DiveTopic = {
        "topic": "크롤링 안정성",
        "project_ref": "크롤링",
        "angle": "weakness",
        "scan_question_idx": 0,
        "query": "크롤링 실패 대응",
    }
    assert topic["angle"] in ("weakness", "strength")


def test_interview_state_has_phase_fields():
    state: InterviewState = {
        "phase": "scan",
        "scan_plan": [],
        "dive_plan": [],
        "current_scan_idx": 0,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
    }
    assert state["phase"] == "scan"
    assert state["current_dive_depth"] == 0
