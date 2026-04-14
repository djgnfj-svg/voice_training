"""Tests for build_dive_plan."""
from app.agent.planner import build_dive_plan


def _scan(name: str, reason: str = "jd_match") -> dict:
    return {"project_ref": name, "query": f"{name} 쿼리", "reason": reason}


def _eval(depth: int, overall: int = 70) -> dict:
    return {"scores": {"depth": depth}, "overallScore": overall}


def test_dive_plan_jd_match_picks_best_worst():
    """JD 있음 + 매칭 프로젝트 안에서 최고/최저 depth 2개."""
    scan_plan = [
        _scan("크롤링", "jd_match"),
        _scan("AI투자", "jd_match"),
        _scan("로봇관제", "jd_unmatched"),
    ]
    scan_evals = [_eval(85), _eval(40), _eval(60)]
    fa = {"skill_match": {"matched": ["Python"], "gap": [], "coverage": 0.5}, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    assert len(plan) == 2
    angles = {t["angle"] for t in plan}
    assert angles == {"weakness", "strength"}
    weakness = next(t for t in plan if t["angle"] == "weakness")
    strength = next(t for t in plan if t["angle"] == "strength")
    assert weakness["project_ref"] == "AI투자"
    assert strength["project_ref"] == "크롤링"


def test_dive_plan_no_jd_uses_all_scans():
    """JD 없음 → 전체 scan 중 최고/최저."""
    scan_plan = [
        _scan("P1", "project_order"),
        _scan("P2", "project_order"),
        _scan("P3", "project_order"),
    ]
    scan_evals = [_eval(30), _eval(80), _eval(55)]
    fa = {"skill_match": None, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    assert len(plan) == 2
    weakness = next(t for t in plan if t["angle"] == "weakness")
    strength = next(t for t in plan if t["angle"] == "strength")
    assert weakness["project_ref"] == "P1"
    assert strength["project_ref"] == "P2"


def test_dive_plan_same_project_different_angles():
    """매칭 프로젝트가 1개뿐 → 같은 프로젝트를 두 각도로."""
    scan_plan = [
        _scan("크롤링", "jd_match"),
        _scan("로봇관제", "jd_unmatched"),
        _scan("QA", "jd_unmatched"),
    ]
    scan_evals = [_eval(60), _eval(70), _eval(50)]
    fa = {"skill_match": {"matched": ["X"], "gap": [], "coverage": 0.1}, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    assert len(plan) == 2
    assert all(t["project_ref"] == "크롤링" for t in plan)
    assert plan[0]["angle"] != plan[1]["angle"]
    assert {t["angle"] for t in plan} == {"weakness", "strength"}


def test_dive_plan_query_matches_scan_plan():
    """dive query는 scan_plan의 query를 재사용해야 RAG가 같은 프로젝트 청크 가져옴."""
    scan_plan = [
        _scan("크롤링", "project_order"),
        _scan("AI투자", "project_order"),
    ]
    scan_evals = [_eval(40), _eval(80)]
    fa = {"skill_match": None, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    weakness = next(t for t in plan if t["angle"] == "weakness")
    assert weakness["query"] == "크롤링 쿼리"


def test_dive_plan_empty_when_no_scans():
    """scan_plan이 비어있으면 dive도 빈 배열."""
    plan = build_dive_plan([], [], {"skill_match": None, "avoid_topics": []})
    assert plan == []


def test_dive_plan_single_scan_returns_one_topic():
    """scan 1개면 dive도 1주제."""
    scan_plan = [_scan("P1", "project_order")]
    scan_evals = [_eval(50)]
    plan = build_dive_plan(scan_plan, scan_evals, {"skill_match": None, "avoid_topics": []})

    assert len(plan) >= 1
    assert plan[0]["project_ref"] == "P1"
