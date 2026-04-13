"""Fit Analysis: 이력서↔JD 매칭. skill_match는 코드, focus_topics는 LLM."""
from __future__ import annotations

import logging
from typing import TypedDict

from app.config import settings
from app.lib.llm_client import call_llm_json
from app.prompts.agent import FIT_ANALYSIS_PROMPT

logger = logging.getLogger(__name__)


class SkillMatch(TypedDict):
    matched: list[str]
    gap: list[str]
    coverage: float


class FocusTopic(TypedDict):
    topic: str
    why: str
    priority: str  # 'high' | 'medium' | 'low'


class FitAnalysis(TypedDict):
    skill_match: SkillMatch | None
    focus_topics: list[FocusTopic]
    avoid_topics: list[str]


def _normalize_skill(s: str) -> str:
    """대소문자/구분자 차이 흡수. 'Next.js'/'NextJS'/'next js' → 'nextjs'."""
    if not isinstance(s, str):
        return ""
    return s.lower().replace(".", "").replace("-", "").replace(" ", "").strip()


def _extract_jd_skills(jd: dict | None) -> list[str]:
    """JD parsedData에서 요구 스킬 리스트 추출. 다양한 키를 시도."""
    if not isinstance(jd, dict):
        return []
    for key in ("requiredSkills", "skills", "required", "techStack"):
        v = jd.get(key)
        if isinstance(v, list) and v:
            return [str(s) for s in v if s]
    return []


def compute_skill_match(resume_skills: list, jd_skills: list) -> SkillMatch | None:
    """JD가 비어있으면 None. 정규화 키로 비교, 표시는 JD 원문 우선."""
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
        parts.append(f"- 프로젝트: {name} ({tech}) — {desc}")
    experience = resume.get("experience") or []
    for e in experience[:3]:
        if not isinstance(e, dict):
            continue
        parts.append(f"- 경력: {e.get('company','')} {e.get('position','')} ({e.get('period','')})")
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
    if resp := jd.get("responsibilities"):
        if isinstance(resp, list):
            parts.append("responsibilities:\n" + "\n".join(f"- {r}" for r in resp[:10]))
    return "\n".join(parts) or "채용공고 정보 없음"


async def run_fit_analysis(resume: dict | None, jd: dict | None) -> FitAnalysis:
    """이력서↔JD Fit Analysis. skill_match는 코드, focus/avoid는 LLM.

    LLM 실패 시 focus_topics/avoid_topics만 빈 배열로, skill_match는 반환.
    """
    resume_skills = (resume or {}).get("skills") or []
    jd_skills = _extract_jd_skills(jd)
    skill_match = compute_skill_match(resume_skills, jd_skills)

    prompt = FIT_ANALYSIS_PROMPT.format(
        resume_brief=_summarize_resume(resume),
        jd_brief=_summarize_jd(jd),
        matched=", ".join(skill_match["matched"]) if skill_match else "(JD 없음)",
        gap=", ".join(skill_match["gap"]) if skill_match else "(JD 없음)",
    )

    focus_topics: list[FocusTopic] = []
    avoid_topics: list[str] = []
    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.4)
        raw_topics = result.get("focus_topics") or []
        for t in raw_topics[:5]:
            if not isinstance(t, dict):
                continue
            topic = (t.get("topic") or "").strip()
            if not topic:
                continue
            focus_topics.append({
                "topic": topic,
                "why": (t.get("why") or "").strip(),
                "priority": t.get("priority") if t.get("priority") in ("high", "medium", "low") else "medium",
            })
        raw_avoid = result.get("avoid_topics") or []
        avoid_topics = [str(s).strip() for s in raw_avoid[:3] if str(s).strip()]
    except Exception:
        logger.exception("fit_analysis LLM call failed")

    return {
        "skill_match": skill_match,
        "focus_topics": focus_topics,
        "avoid_topics": avoid_topics,
    }
