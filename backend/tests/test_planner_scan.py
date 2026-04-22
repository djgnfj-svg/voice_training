"""Tests for build_scan_plan."""
from app.agent.interview.plan_builder import build_scan_plan


def test_scan_plan_jd_matched_two_plus_unmatched_one():
    """JD 있고 projects 4개: 매칭 2 + 비매칭 1 총 3개."""
    resume = {
        "projects": [
            {"name": "크롤링", "techStack": ["Python", "Selenium"]},
            {"name": "AI투자", "techStack": ["LangGraph", "Redis"]},
            {"name": "로봇관제", "techStack": ["PyQt", "Vue"]},
            {"name": "QA자동화", "techStack": ["Python", "pytest"]},
        ]
    }
    fit_analysis = {
        "skill_match": {
            "matched": ["Python", "Selenium", "LangGraph", "Redis"],
            "gap": ["Kubernetes"],
            "coverage": 0.8,
        },
        "avoid_topics": [],
    }

    plan = build_scan_plan(resume, fit_analysis)

    assert len(plan) == 3
    assert plan[0]["reason"] == "jd_match"
    assert plan[1]["reason"] == "jd_match"
    assert plan[2]["reason"] == "jd_unmatched"
    assert plan[0]["project_ref"] in ("크롤링", "AI투자")
    assert plan[1]["project_ref"] in ("크롤링", "AI투자")
    assert plan[2]["project_ref"] == "로봇관제"


def test_scan_plan_no_jd_project_order():
    """JD 없음: projects[0..2] 순서."""
    resume = {
        "projects": [
            {"name": "P1", "techStack": ["X"]},
            {"name": "P2", "techStack": ["Y"]},
            {"name": "P3", "techStack": ["Z"]},
            {"name": "P4", "techStack": ["W"]},
        ]
    }
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)

    assert [p["project_ref"] for p in plan] == ["P1", "P2", "P3"]
    assert all(p["reason"] == "project_order" for p in plan)


def test_scan_plan_two_projects_only():
    """projects 2개만 있으면 scan 2개."""
    resume = {
        "projects": [
            {"name": "P1", "techStack": ["X"]},
            {"name": "P2", "techStack": ["Y"]},
        ]
    }
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert len(plan) == 2


def test_scan_plan_one_project_fills_with_experience():
    """projects 1개 + experience 1개 → 총 2 scan."""
    resume = {
        "projects": [{"name": "P1", "techStack": ["X"]}],
        "experience": [
            {"company": "A사", "position": "백엔드", "period": "2023-2024"},
        ],
    }
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert len(plan) == 2
    assert plan[0]["project_ref"] == "P1"
    assert "A사" in plan[1]["project_ref"]


def test_scan_plan_zero_projects_returns_empty():
    """projects도 experience도 없으면 빈 플랜."""
    resume = {}
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert plan == []


def test_scan_query_contains_techstack():
    """query에 project_ref + techStack 포함되어야 RAG가 해당 프로젝트 청크를 top-3로 가져옴."""
    resume = {"projects": [{"name": "크롤링", "techStack": ["Python", "Selenium"]}]}
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert "크롤링" in plan[0]["query"]
    assert "Selenium" in plan[0]["query"]


def test_scan_plan_two_projects_with_jd_score_based_reason():
    """projects 2개 + JD: 매칭되는 것은 jd_match, 안 되는 것은 jd_unmatched."""
    resume = {
        "projects": [
            {"name": "매칭프로젝트", "techStack": ["Python", "Django"]},
            {"name": "비매칭프로젝트", "techStack": ["Vue", "Elixir"]},
        ]
    }
    fit_analysis = {
        "skill_match": {
            "matched": ["Python", "Django"],
            "gap": [],
            "coverage": 1.0,
        },
        "avoid_topics": [],
    }

    plan = build_scan_plan(resume, fit_analysis)

    assert len(plan) == 2
    # 매칭프로젝트가 먼저 나옴 (jd_match), 비매칭프로젝트가 뒤 (jd_unmatched)
    reasons = {p["project_ref"]: p["reason"] for p in plan}
    assert reasons["매칭프로젝트"] == "jd_match"
    assert reasons["비매칭프로젝트"] == "jd_unmatched"


def test_scan_plan_experience_supplement_with_jd_marks_unmatched():
    """projects 1개 + experience 2개 + JD: experience는 score=0이라 jd_unmatched로 붙어야."""
    resume = {
        "projects": [{"name": "매칭P", "techStack": ["Python"]}],
        "experience": [
            {"company": "A사", "position": "백엔드", "period": "2023"},
            {"company": "B사", "position": "프론트", "period": "2024"},
        ],
    }
    fit_analysis = {
        "skill_match": {"matched": ["Python"], "gap": [], "coverage": 1.0},
        "avoid_topics": [],
    }

    plan = build_scan_plan(resume, fit_analysis)

    assert len(plan) == 3
    # 매칭P가 jd_match여야 함
    matched = [p for p in plan if p["reason"] == "jd_match"]
    assert len(matched) == 1
    assert matched[0]["project_ref"] == "매칭P"
    # experience 항목들은 techStack 없으므로 score=0 → jd_unmatched
    unmatched = [p for p in plan if p["reason"] == "jd_unmatched"]
    assert len(unmatched) == 2
