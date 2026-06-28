"""Hybrid Plan Builder — LLM Suggester + Rule Validator.

Planner-Executor 패턴의 Planner 역할. Scan 단계는 하이브리드, Dive 단계는 순수 rule-based.

[Scan — Hybrid]
1. LLM Suggester (`suggest_scan_candidates_llm`): 실제 면접관이 보는 7가지 신호
   (impact/complexity/ownership/scope/jd_match/red_flag/measurable)로 후보 5개 선정.
2. Rule Validator (`enforce_scan_rules`): top2(jd_match) + bottom1(jd_unmatched) 구조 강제.
3. Fallback (`build_scan_plan`): LLM 실패/부족 시 기존 rule-based로 보충.

[Dive — Rule-based]
- `build_dive_plan`: scan 답변의 depth 점수로 약점(min) + 강점(max) 2주제. LLM 미사용.

[설계 의도]
- rule-only는 JD 매칭 1개 신호만 봤음 → 7개 신호로 확장하기 위해 LLM Suggester 도입.
- 단, 재현성/디버깅을 위해 마지막 구조 강제는 코드에 남김.
- LLM 실패 폴백을 명시해 가용성 보장.

[한계 (정직)]
- LLM Suggester는 비결정적 (같은 이력서에 다른 후보 셋이 나올 수 있음).
- Dive 주제 선정이 depth 점수 1축 휴리스틱 — 다축 종합은 다음 후보.

입력:
- resume: dict (parsedData 형태. projects / experience 포함)
- fit_analysis: {skill_match: {matched, gap, coverage} | None, avoid_topics: list}
- scan_plan + scan_evaluations (dive 시점)

출력:
- ScanItem / DiveTopic 리스트
"""
from __future__ import annotations

import json
import logging

from app.agent.interview.state import DiveTopic, ScanItem
from app.lib.llm_client import call_llm_json
from app.prompts.agent import SCAN_SUGGESTER_PROMPT

logger = logging.getLogger(__name__)


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


async def suggest_scan_candidates_llm(resume: dict, fit_analysis: dict | None) -> list[dict]:
    """LLM Suggester — 7가지 신호로 후보 5개 선정.

    실패 시 빈 리스트 반환 (호출자가 rule-based 폴백 처리).
    """
    try:
        prompt = SCAN_SUGGESTER_PROMPT.format(
            resume_json=json.dumps(resume or {}, ensure_ascii=False)[:8000],
            fit_json=json.dumps(fit_analysis or None, ensure_ascii=False),
        )
        result = await call_llm_json(
            prompt,
            temperature=0.2,
            max_tokens=1500,
            tag="scan_suggester",
        )
        if isinstance(result, dict):
            candidates = result.get("candidates") or []
        else:
            candidates = []
        # 최소 필드 검증
        valid: list[dict] = []
        for c in candidates:
            if not isinstance(c, dict):
                continue
            if not c.get("project_ref"):
                continue
            valid.append(c)
        return valid[:5]
    except Exception as exc:
        logger.warning("scan_suggester LLM failed: %s", exc)
        return []


def enforce_scan_rules(
    candidates: list[dict],
    has_jd: bool,
) -> list[ScanItem]:
    """Rule Validator — LLM 후보 5개 중 top2 + bottom1 구조 강제.

    - has_jd=True: jd_match 신호 가진 후보 중 score 상위 2 + jd_unmatched 신호 후보 1
    - has_jd=False: score 상위 3
    - 부족하면 남은 후보로 채움
    - 후보 부족 시 가능한 만큼만 반환 (호출자가 rule-based로 보충)
    """
    if not candidates:
        return []

    def _score(c: dict) -> int:
        try:
            return int(c.get("score", 50))
        except (TypeError, ValueError):
            return 50

    def _to_item(c: dict, reason: str) -> ScanItem:
        return {
            "project_ref": str(c.get("project_ref", "프로젝트")),
            "query": str(c.get("query") or c.get("project_ref") or "프로젝트"),
            "reason": reason,  # type: ignore[typeddict-item]
        }

    sorted_cands = sorted(candidates, key=_score, reverse=True)

    if not has_jd:
        return [_to_item(c, "project_order") for c in sorted_cands[:3]]

    jd_match = [c for c in sorted_cands if "jd_match" in (c.get("signals") or [])]
    jd_unmatched = [c for c in sorted_cands if "jd_unmatched" in (c.get("signals") or [])]
    others = [
        c for c in sorted_cands
        if c not in jd_match and c not in jd_unmatched
    ]

    plan: list[ScanItem] = []
    seen: set[str] = set()

    for c in jd_match[:2]:
        ref = c.get("project_ref", "")
        if ref not in seen:
            plan.append(_to_item(c, "jd_match"))
            seen.add(ref)

    for c in jd_unmatched[:1]:
        ref = c.get("project_ref", "")
        if ref not in seen:
            plan.append(_to_item(c, "jd_unmatched"))
            seen.add(ref)

    # 부족분은 others에서 보충
    for c in others:
        if len(plan) >= 3:
            break
        ref = c.get("project_ref", "")
        if ref not in seen:
            plan.append(_to_item(c, "jd_unmatched"))
            seen.add(ref)

    return plan[:3]


async def build_scan_plan_hybrid(
    resume: dict,
    fit_analysis: dict | None,
) -> tuple[list[ScanItem], str]:
    """하이브리드: LLM Suggester → Rule Validator → 폴백.

    반환: (scan_plan, source)
    source: "llm" | "llm+rule_fill" | "rule_fallback"
    """
    fa = fit_analysis or {}
    has_jd = bool((fa.get("skill_match") or {}).get("matched"))

    candidates = await suggest_scan_candidates_llm(resume, fa)
    llm_plan = enforce_scan_rules(candidates, has_jd) if candidates else []

    if len(llm_plan) >= 3:
        return llm_plan[:3], "llm"

    # 부족분을 기존 rule-based로 채움 (중복 ref 제외)
    rule_plan = build_scan_plan(resume, fa)
    if not llm_plan:
        return rule_plan, "rule_fallback"

    seen = {item["project_ref"] for item in llm_plan}
    for item in rule_plan:
        if len(llm_plan) >= 3:
            break
        if item["project_ref"] not in seen:
            llm_plan.append(item)
            seen.add(item["project_ref"])
    return llm_plan[:3], "llm+rule_fill"


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
