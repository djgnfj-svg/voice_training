"""Fit Analysis: 이력서와 JD 매칭. skill_match는 코드, avoid_topics는 LLM."""

from __future__ import annotations

import logging
from typing import TypedDict

from app.config import settings
from app.lib.llm_client import call_llm_json
from app.prompts.agent import build_fit_messages

logger = logging.getLogger(__name__)


class SkillMatch(TypedDict):
    matched: list[str]
    gap: list[str]
    coverage: float


class FitAnalysis(TypedDict):
    skill_match: SkillMatch | None
    avoid_topics: list[str]


def _normalize_skill(s: str) -> str:
    """대소문자/구분자 차이를 흡수한다. 'Next.js'/'NextJS'/'next js' -> 'nextjs'."""
    if not isinstance(s, str):
        return ""
    return s.lower().replace(".", "").replace("-", "").replace(" ", "").strip()


def _extract_jd_skills(jd: dict | None) -> list[str]:
    """JD parsedData에서 요구 스킬 리스트를 추출한다. 다양한 키 이름을 시도한다."""
    if not isinstance(jd, dict):
        return []
    for key in ("requiredSkills", "skills", "required", "techStack"):
        v = jd.get(key)
        if isinstance(v, list) and v:
            return [str(s) for s in v if s]
    return []


def compute_skill_match(resume_skills: list, jd_skills: list) -> SkillMatch | None:
    """JD가 비어 있으면 None. 정규화 키로 비교하고 표시는 JD 원문을 우선한다."""
    if not jd_skills:
        return None

    resume_keys = {_normalize_skill(s): str(s) for s in (resume_skills or []) if s}
    matched_display: list[str] = []
    gap_display: list[str] = []
    for s in jd_skills:
        k = _normalize_skill(s)
        if not k:
            continue
        if k in resume_keys:
            matched_display.append(str(s))
        else:
            gap_display.append(str(s))

    total = len(matched_display) + len(gap_display)
    coverage = (len(matched_display) / total) if total else 0.0
    return {
        "matched": matched_display,
        "gap": gap_display,
        "coverage": round(coverage, 3),
    }


def _summarize_resume(resume: dict | None) -> str:
    """LLM 토큰 절약용 요약."""
    if not isinstance(resume, dict):
        return "이력서 없음"
    parts = []
    if s := resume.get("summary"):
        parts.append(f"summary: {s}")
    if skills := resume.get("skills"):
        parts.append(f"skills: {', '.join(str(x) for x in skills[:20])}")
    projects = resume.get("projects") or []
    for p in projects[:5]:
        if not isinstance(p, dict):
            continue
        name = p.get("name", "")
        tech = ", ".join(str(t) for t in (p.get("techStack") or [])[:5])
        desc = (p.get("description") or "")[:80]
        parts.append(f"- 프로젝트: {name} ({tech}) - {desc}")
    experience = resume.get("experience") or []
    for e in experience[:3]:
        if not isinstance(e, dict):
            continue
        parts.append(
            f"- 경력: {e.get('company', '')} {e.get('position', '')} ({e.get('period', '')})"
        )
    return "\n".join(parts) or "이력서 정보 없음"


def _summarize_jd(jd: dict | None) -> str:
    if not isinstance(jd, dict):
        return "채용공고 없음"
    parts = []
    if pos := jd.get("position"):
        parts.append(f"position: {pos}")
    if comp := jd.get("company"):
        parts.append(f"company: {comp}")
    if reqs := jd.get("requirements"):
        if isinstance(reqs, list):
            parts.append("requirements:\n" + "\n".join(f"- {r}" for r in reqs[:10]))
        else:
            parts.append(f"requirements: {reqs}")
    # responsibilities/duties는 JD 파서가 'duties'로 내보내기도 한다 — 둘 다 수용.
    for key in ("responsibilities", "duties"):
        resp = jd.get(key)
        if isinstance(resp, list) and resp:
            parts.append(f"{key}:\n" + "\n".join(f"- {r}" for r in resp[:10]))
    if pref := jd.get("preferred"):
        if isinstance(pref, list) and pref:
            parts.append("preferred:\n" + "\n".join(f"- {r}" for r in pref[:6]))
    return "\n".join(parts) or "채용공고 정보 없음"


async def run_fit_analysis(resume: dict | None, jd: dict | None) -> FitAnalysis:
    """이력서와 JD Fit Analysis. skill_match는 코드, avoid_topics는 LLM.

    LLM 실패 시 avoid_topics만 빈 배열로 두고 skill_match는 반환한다.
    """
    resume_skills = (resume or {}).get("skills") or []
    jd_skills = _extract_jd_skills(jd)
    skill_match = compute_skill_match(resume_skills, jd_skills)

    stable, variable = build_fit_messages(
        resume_brief=_summarize_resume(resume),
        jd_brief=_summarize_jd(jd),
        matched=", ".join(skill_match["matched"]) if skill_match else "(JD 없음)",
        gap=", ".join(skill_match["gap"]) if skill_match else "(JD 없음)",
    )

    avoid_topics: list[str] = []
    try:
        result = await call_llm_json(
            cached_context=stable,
            variable=variable,
            model=settings.AGENT_MODEL,
            temperature=0.4,
            tag="interview.fit_analysis",
        )
        raw_avoid = result.get("avoid_topics") or []
        avoid_topics = [str(s).strip() for s in raw_avoid[:3] if str(s).strip()]
    except Exception:
        logger.exception("fit_analysis LLM call failed")

    return {
        "skill_match": skill_match,
        "avoid_topics": avoid_topics,
    }
