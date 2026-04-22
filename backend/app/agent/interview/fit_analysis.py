"""Fit Analysis: ?대젰?쒋넄JD 留ㅼ묶. skill_match??肄붾뱶, avoid_topics??LLM."""
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


class FitAnalysis(TypedDict):
    skill_match: SkillMatch | None
    avoid_topics: list[str]


def _normalize_skill(s: str) -> str:
    """??뚮Ц??援щ텇??李⑥씠 ?≪닔. 'Next.js'/'NextJS'/'next js' ??'nextjs'."""
    if not isinstance(s, str):
        return ""
    return s.lower().replace(".", "").replace("-", "").replace(" ", "").strip()


def _extract_jd_skills(jd: dict | None) -> list[str]:
    """JD parsedData?먯꽌 ?붽뎄 ?ㅽ궗 由ъ뒪??異붿텧. ?ㅼ뼇???ㅻ? ?쒕룄."""
    if not isinstance(jd, dict):
        return []
    for key in ("requiredSkills", "skills", "required", "techStack"):
        v = jd.get(key)
        if isinstance(v, list) and v:
            return [str(s) for s in v if s]
    return []


def compute_skill_match(resume_skills: list, jd_skills: list) -> SkillMatch | None:
    """JD媛 鍮꾩뼱?덉쑝硫?None. ?뺢퇋???ㅻ줈 鍮꾧탳, ?쒖떆??JD ?먮Ц ?곗꽑."""
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
    """LLM ?좏겙 ?덉빟???붿빟."""
    if not isinstance(resume, dict):
        return "?대젰???놁쓬"
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
        parts.append(f"- ?꾨줈?앺듃: {name} ({tech}) ??{desc}")
    experience = resume.get("experience") or []
    for e in experience[:3]:
        if not isinstance(e, dict):
            continue
        parts.append(f"- 寃쎈젰: {e.get('company','')} {e.get('position','')} ({e.get('period','')})")
    return "\n".join(parts) or "?대젰???뺣낫 ?놁쓬"


def _summarize_jd(jd: dict | None) -> str:
    if not isinstance(jd, dict):
        return "梨꾩슜怨듦퀬 ?놁쓬"
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
    return "\n".join(parts) or "梨꾩슜怨듦퀬 ?뺣낫 ?놁쓬"


async def run_fit_analysis(resume: dict | None, jd: dict | None) -> FitAnalysis:
    """?대젰?쒋넄JD Fit Analysis. skill_match??肄붾뱶, avoid_topics??LLM.

    LLM ?ㅽ뙣 ??avoid_topics留?鍮?諛곗뿴濡? skill_match??諛섑솚.
    """
    resume_skills = (resume or {}).get("skills") or []
    jd_skills = _extract_jd_skills(jd)
    skill_match = compute_skill_match(resume_skills, jd_skills)

    prompt = FIT_ANALYSIS_PROMPT.format(
        resume_brief=_summarize_resume(resume),
        jd_brief=_summarize_jd(jd),
        matched=", ".join(skill_match["matched"]) if skill_match else "(JD ?놁쓬)",
        gap=", ".join(skill_match["gap"]) if skill_match else "(JD ?놁쓬)",
    )

    avoid_topics: list[str] = []
    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.4)
        raw_avoid = result.get("avoid_topics") or []
        avoid_topics = [str(s).strip() for s in raw_avoid[:3] if str(s).strip()]
    except Exception:
        logger.exception("fit_analysis LLM call failed")

    return {
        "skill_match": skill_match,
        "avoid_topics": avoid_topics,
    }
