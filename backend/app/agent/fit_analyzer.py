"""Fit Analysis: 이력서↔JD 매칭. skill_match는 코드, focus_topics는 LLM."""
from __future__ import annotations

import logging
from typing import TypedDict

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
