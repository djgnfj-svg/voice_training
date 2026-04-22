"""Scan+Dive 플래너 — 순수 코드 (LLM 호출 없음).

입력:
- resume: dict (parsedData 형태. projects / experience 포함)
- fit_analysis: {skill_match: {matched, gap, coverage} | None, avoid_topics: list}
- scan_plan + scan_evaluations (dive 시점)

출력:
- ScanItem / DiveTopic 리스트
"""
from __future__ import annotations

from app.agent.interview.state import DiveTopic, ScanItem


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


def _topic_label(project_ref: str, angle: str) -> str:
    if angle == "weakness":
        return f"{project_ref} 한계/개선점"
    return f"{project_ref} 핵심 의사결정"


def build_dive_plan(
    scan_plan: list[ScanItem],
    scan_evaluations: list[dict],
    fit_analysis: dict,
) -> list[DiveTopic]:
    """딥다이브 2주제 선정.

    - JD 있음 → scan_plan에서 reason=='jd_match'만 후보
    - JD 없음 → 전체 scan 후보
    - 후보 중 depth 최저 → weakness, 최고 → strength
    - 후보가 1개뿐 → 같은 프로젝트 2각도 (topic 라벨만 다르게)
    - scan_plan 비어있으면 []
    """
    if not scan_plan:
        return []

    skill_match = (fit_analysis or {}).get("skill_match")
    has_jd = bool(skill_match and skill_match.get("matched"))

    # 후보 인덱스 (scan_plan 기준)
    if has_jd:
        candidate_idx = [i for i, s in enumerate(scan_plan) if s["reason"] == "jd_match"]
        if not candidate_idx:
            candidate_idx = list(range(len(scan_plan)))
    else:
        candidate_idx = list(range(len(scan_plan)))

    def _depth(i: int) -> int:
        if i >= len(scan_evaluations):
            return 50
        ev = scan_evaluations[i] or {}
        scores = ev.get("scores") or {}
        try:
            return int(scores.get("depth", 50))
        except (TypeError, ValueError):
            return 50

    scored = [(i, _depth(i)) for i in candidate_idx]

    # 후보 1개 → 같은 프로젝트 2각도 (scan_plan 전체가 1개인 경우는 1주제)
    if len(scored) == 1:
        i = scored[0][0]
        s = scan_plan[i]
        # scan_plan 전체가 1개라면 1주제만 반환
        if len(scan_plan) == 1:
            return [{
                "topic": _topic_label(s["project_ref"], "strength"),
                "project_ref": s["project_ref"],
                "angle": "strength",
                "scan_question_idx": i,
                "query": s["query"],
            }]
        # JD 필터로 후보가 1개로 줄어든 경우 → 2각도
        return [
            {
                "topic": _topic_label(s["project_ref"], "weakness"),
                "project_ref": s["project_ref"],
                "angle": "weakness",
                "scan_question_idx": i,
                "query": s["query"],
            },
            {
                "topic": _topic_label(s["project_ref"], "strength"),
                "project_ref": s["project_ref"],
                "angle": "strength",
                "scan_question_idx": i,
                "query": s["query"],
            },
        ]

    weakness_i, _ = min(scored, key=lambda x: x[1])
    strength_i, _ = max(scored, key=lambda x: x[1])

    if weakness_i == strength_i:
        others = [s for s in scored if s[0] != weakness_i]
        if others:
            strength_i = max(others, key=lambda x: x[1])[0]

    if weakness_i == strength_i:
        # 후보 1개뿐 또는 모두 동점 → 같은 프로젝트 2각도
        s = scan_plan[weakness_i]
        return [
            {
                "topic": _topic_label(s["project_ref"], "weakness"),
                "project_ref": s["project_ref"],
                "angle": "weakness",
                "scan_question_idx": weakness_i,
                "query": s["query"],
            },
            {
                "topic": _topic_label(s["project_ref"], "strength"),
                "project_ref": s["project_ref"],
                "angle": "strength",
                "scan_question_idx": weakness_i,
                "query": s["query"],
            },
        ]

    w_s = scan_plan[weakness_i]
    s_s = scan_plan[strength_i]
    return [
        {
            "topic": _topic_label(w_s["project_ref"], "weakness"),
            "project_ref": w_s["project_ref"],
            "angle": "weakness",
            "scan_question_idx": weakness_i,
            "query": w_s["query"],
        },
        {
            "topic": _topic_label(s_s["project_ref"], "strength"),
            "project_ref": s_s["project_ref"],
            "angle": "strength",
            "scan_question_idx": strength_i,
            "query": s_s["query"],
        },
    ]
