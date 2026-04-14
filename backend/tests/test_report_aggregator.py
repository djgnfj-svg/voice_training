"""Tests for aggregate_evaluations."""
from app.agent.report_aggregator import aggregate_evaluations


def _turn(q: str, score: int, *, scores: dict | None = None, meta: dict | None = None,
          demo: list[str] | None = None, miss: list[str] | None = None) -> dict:
    return {
        "question": q,
        "answer": "답변",
        "evaluation": {
            "scores": scores or {"clarity": score, "accuracy": score, "practicality": score, "depth": score, "completeness": score},
            "overallScore": score,
            "demonstratedKeywords": demo or [],
            "missingKeywords": miss or [],
            "meta": meta or {"phase": "scan"},
        },
    }


def test_empty_history_returns_safe_defaults():
    out = aggregate_evaluations([])
    assert out["overallStats"]["count"] == 0
    assert out["categoryBreakdown"] == {}
    assert out["phaseAnalysis"] == {"scan": {"avg": 0, "count": 0, "qIndices": []}, "dive": {"avg": 0, "count": 0, "qIndices": []}}
    assert out["diveTopicAnalysis"] == []
    assert out["keywordStats"] == {"demonstrated": [], "missing": []}
    assert out["extremes"]["best"] is None
    assert out["extremes"]["worst"] is None


def test_category_breakdown_avg_min_max():
    history = [
        _turn("Q1", 80, scores={"clarity": 80, "accuracy": 70, "practicality": 60, "depth": 50, "completeness": 40}),
        _turn("Q2", 60, scores={"clarity": 60, "accuracy": 90, "practicality": 40, "depth": 70, "completeness": 60}),
    ]
    out = aggregate_evaluations(history)
    assert out["categoryBreakdown"]["clarity"] == {"avg": 70, "min": 60, "max": 80}
    assert out["categoryBreakdown"]["accuracy"] == {"avg": 80, "min": 70, "max": 90}


def test_phase_analysis_splits_scan_and_dive():
    history = [
        _turn("Q1", 80, meta={"phase": "scan", "scanIdx": 0, "projectRef": "P1"}),
        _turn("Q2", 60, meta={"phase": "scan", "scanIdx": 1, "projectRef": "P2"}),
        _turn("Q3", 40, meta={"phase": "dive", "diveIdx": 0, "topicLabel": "T", "angle": "weakness", "projectRef": "P1"}),
    ]
    out = aggregate_evaluations(history)
    assert out["phaseAnalysis"]["scan"] == {"avg": 70, "count": 2, "qIndices": [1, 2]}
    assert out["phaseAnalysis"]["dive"] == {"avg": 40, "count": 1, "qIndices": [3]}


def test_extremes_best_and_worst():
    history = [
        _turn("왜 React를 썼나요", 80),
        _turn("DB 설계 설명", 40),
        _turn("배포 파이프라인", 90),
    ]
    out = aggregate_evaluations(history)
    assert out["extremes"]["best"]["qIdx"] == 3
    assert out["extremes"]["best"]["score"] == 90
    assert out["extremes"]["worst"]["qIdx"] == 2
    assert out["extremes"]["worst"]["score"] == 40


def test_dive_topic_analysis_groups_by_topic_and_angle():
    history = [
        _turn("Q1", 50, meta={"phase": "dive", "diveIdx": 0, "topicLabel": "분산 TX", "angle": "weakness", "projectRef": "P1"}),
        _turn("Q2", 60, meta={"phase": "dive", "diveIdx": 0, "topicLabel": "분산 TX", "angle": "weakness", "projectRef": "P1"}),
        _turn("Q3", 85, meta={"phase": "dive", "diveIdx": 1, "topicLabel": "React 최적화", "angle": "strength", "projectRef": "P2"}),
    ]
    out = aggregate_evaluations(history)
    topics = {(t["topicLabel"], t["angle"]): t for t in out["diveTopicAnalysis"]}
    assert topics[("분산 TX", "weakness")]["avg"] == 55
    assert topics[("분산 TX", "weakness")]["qIndices"] == [1, 2]
    assert topics[("React 최적화", "strength")]["avg"] == 85


def test_keyword_stats_count_and_indices():
    history = [
        _turn("Q1", 70, demo=["JWT", "refresh token"], miss=["CSRF"]),
        _turn("Q2", 60, demo=["JWT", "React"], miss=["CSRF", "XSS"]),
        _turn("Q3", 80, demo=["React"], miss=[]),
    ]
    out = aggregate_evaluations(history)
    demo = {k["keyword"]: k for k in out["keywordStats"]["demonstrated"]}
    assert demo["JWT"]["count"] == 2
    assert demo["JWT"]["qIndices"] == [1, 2]
    assert demo["React"]["count"] == 2
    miss = {k["keyword"]: k for k in out["keywordStats"]["missing"]}
    assert miss["CSRF"]["count"] == 2
    assert miss["XSS"]["count"] == 1


def test_keyword_stats_top_10_only():
    history = [_turn("Q1", 70, demo=[f"k{i}" for i in range(15)])]
    out = aggregate_evaluations(history)
    assert len(out["keywordStats"]["demonstrated"]) <= 10


def test_skipped_answers_excluded():
    """'(건너뜀)' 답변이나 evaluation 없는 턴은 제외."""
    history = [
        _turn("Q1", 80),
        {"question": "Q2", "answer": "(건너뜀)", "evaluation": None},
        {"question": "Q3", "answer": "답", "evaluation": {}},
    ]
    out = aggregate_evaluations(history)
    assert out["overallStats"]["count"] == 1
