"""Tests for rubric plan builder pure helpers (no LLM)."""
from app.agent.interview.plan_builder import (
    _build_items_from_llm,
    _fallback_rubric,
    _sort_and_cap,
)


def _raw(label: str, importance: str = "must") -> dict:
    return {"label": label, "jd_requirement": label, "importance": importance}


def test_build_items_marks_evidence_from_matched():
    raw = [
        {"label": "FastAPI API 설계", "jd_requirement": "FastAPI 기반 API", "importance": "must"},
        {"label": "Kafka 메시징", "jd_requirement": "Kafka 스트리밍", "importance": "nice"},
    ]
    items = _build_items_from_llm(raw, ["FastAPI", "PostgreSQL"])
    by_label = {it["label"]: it for it in items}
    assert by_label["FastAPI API 설계"]["has_evidence"] is True
    assert "FastAPI" in by_label["FastAPI API 설계"]["evidence_refs"]
    assert by_label["Kafka 메시징"]["has_evidence"] is False


def test_sort_and_cap_must_first_then_evidence():
    items = [
        {"id": "", "label": "nice-ev", "jd_requirement": "", "importance": "nice", "has_evidence": True, "evidence_refs": [], "query": "q"},
        {"id": "", "label": "must-gap", "jd_requirement": "", "importance": "must", "has_evidence": False, "evidence_refs": [], "query": "q"},
        {"id": "", "label": "must-ev", "jd_requirement": "", "importance": "must", "has_evidence": True, "evidence_refs": [], "query": "q"},
    ]
    out = _sort_and_cap(items)
    assert [it["label"] for it in out] == ["must-ev", "must-gap", "nice-ev"]
    assert out[0]["id"] == "r1"


def test_sort_and_cap_limits_to_six():
    items = [_sort_input(i) for i in range(9)]
    out = _sort_and_cap(items)
    assert len(out) == 6


def _sort_input(i: int) -> dict:
    return {
        "id": "",
        "label": f"L{i}",
        "jd_requirement": "",
        "importance": "must",
        "has_evidence": True,
        "evidence_refs": [],
        "query": "q",
    }


def test_fallback_rubric_from_skill_match():
    items = _fallback_rubric(None, ["Python", "FastAPI"], ["Kafka"])
    ev = {it["label"]: it["has_evidence"] for it in items}
    assert ev["Python"] is True
    assert ev["FastAPI"] is True
    assert ev["Kafka"] is False


def test_fallback_rubric_from_jd_phrases_when_no_skills():
    jd = {"requirements": ["분산 트랜잭션 처리"], "duties": ["대용량 트래픽 운영"]}
    items = _fallback_rubric(jd, [], [])
    assert len(items) >= 1
    assert all(it["has_evidence"] is False for it in items)


def test_fallback_rubric_always_returns_at_least_one():
    items = _fallback_rubric(None, [], [])
    assert len(items) == 1
    assert items[0]["importance"] == "must"
