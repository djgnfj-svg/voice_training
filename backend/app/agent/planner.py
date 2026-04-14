"""Scan+Dive 플래너 — 순수 코드 (LLM 호출 없음).

입력:
- resume: dict (parsedData 형태. projects / experience 포함)
- fit_analysis: {skill_match: {matched, gap, coverage} | None, avoid_topics: list}
- scan_plan + scan_evaluations (dive 시점)

출력:
- ScanItem / DiveTopic 리스트
"""
from __future__ import annotations

from app.agent.state import DiveTopic, ScanItem


def _normalize(s: str) -> str:
    return str(s).lower().replace(".", "").replace("-", "").replace(" ", "").strip()


def _project_query(project: dict) -> str:
    """RAG 검색용 쿼리. project_ref + techStack 결합."""
    name = project.get("name", "")
    tech = " ".join(str(t) for t in (project.get("techStack") or [])[:5])
    return f"{name} {tech}".strip() or name or "프로젝트"


def _score_projects_by_match(projects: list[dict], matched_skills: list[str]) -> list[tuple[dict, int]]:
    """각 프로젝트의 techStack이 matched_skills와 얼마나 겹치는지 점수화."""
    matched_keys = {_normalize(s) for s in matched_skills if s}
    scored = []
    for p in projects:
        if not isinstance(p, dict):
            continue
        tech = p.get("techStack") or []
        p_keys = {_normalize(t) for t in tech if t}
        score = len(p_keys & matched_keys)
        scored.append((p, score))
    return scored


def _experience_as_project_like(exp: dict) -> dict:
    """experience 항목을 project-like dict로 변환 (name/techStack)."""
    if not isinstance(exp, dict):
        return {"name": "경력", "techStack": []}
    company = exp.get("company", "")
    position = exp.get("position", "")
    name = f"{company} {position}".strip() or "경력"
    return {"name": name, "techStack": exp.get("techStack") or []}


def build_scan_plan(resume: dict, fit_analysis: dict) -> list[ScanItem]:
    """훑기 3질문 계획을 확정.

    - JD 있음 + projects >= 3 → 매칭 2 + 비매칭 1 (총 3)
    - JD 있음 + projects 2개 → 매칭/비매칭 섞어 2
    - JD 없음 또는 skill_match 없음 → projects[0..2] 순서
    - projects < 3이면 experience로 보충 (최대 3개까지)
    - 아무것도 없으면 [] (호출자가 FALLBACK 처리)
    """
    projects = [p for p in (resume or {}).get("projects") or [] if isinstance(p, dict)]

    # projects 부족시 experience로 보충
    if len(projects) < 3:
        exp = [_experience_as_project_like(e) for e in (resume or {}).get("experience") or []]
        projects = projects + exp

    if not projects:
        return []

    skill_match = (fit_analysis or {}).get("skill_match")
    max_scan = min(3, len(projects))

    # JD 없음 → 순서대로
    if not skill_match or not skill_match.get("matched"):
        return [
            {
                "project_ref": p.get("name", f"항목{i+1}"),
                "query": _project_query(p),
                "reason": "project_order",
            }
            for i, p in enumerate(projects[:max_scan])
        ]

    # JD 있음 → 점수화 후 매칭 상위 + 비매칭 하위
    scored = _score_projects_by_match(projects, skill_match.get("matched") or [])
    scored_sorted = sorted(scored, key=lambda x: x[1], reverse=True)

    if max_scan >= 3 and len(scored_sorted) >= 3:
        top = scored_sorted[:2]
        bottom = scored_sorted[-1]
        plan: list[ScanItem] = []
        for p, score in top:
            plan.append({
                "project_ref": p.get("name", "프로젝트"),
                "query": _project_query(p),
                "reason": "jd_match" if score > 0 else "jd_unmatched",
            })
        p, _ = bottom
        plan.append({
            "project_ref": p.get("name", "프로젝트"),
            "query": _project_query(p),
            "reason": "jd_unmatched",
        })
        return plan

    # projects 2개 → 점수순으로 2개 (reason은 점수>0이면 jd_match 아니면 jd_unmatched)
    plan: list[ScanItem] = []
    for p, score in scored_sorted[:max_scan]:
        plan.append({
            "project_ref": p.get("name", "프로젝트"),
            "query": _project_query(p),
            "reason": "jd_match" if score > 0 else "jd_unmatched",
        })
    return plan
