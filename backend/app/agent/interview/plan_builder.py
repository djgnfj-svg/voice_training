"""Rubric Plan Builder — JD 요구역량을 평가 루브릭으로 추출 + 이력서 근거 매칭.

[설계 — JD 루브릭 커버리지(C안) 단일 루프]
질문의 축이 "이력서 프로젝트"가 아니라 "JD 요구역량(루브릭)"이다.
1. LLM 추출 (`_suggest_rubric_llm`): JD requirements/responsibilities → 루브릭 항목 3~6개
   (label / jd_requirement / importance).
2. 코드 근거 매칭 (`_build_items_from_llm`): skill_match.matched 키워드가 항목 텍스트에
   닿으면 has_evidence=True(근거 연결 질문 후보), 아니면 gap(근거 없음) 후보.
   RAG(resume_embeddings)는 매 질문 직전 그래프에서 query로 보강한다.
3. 정렬 (`_sort_and_cap`): must 우선 → 같은 importance 내에서는 evidence 우선(커버리지 극대화).
4. 폴백 (`_fallback_rubric`): LLM 실패 시 skill_match.matched/gap, 그것도 없으면 JD 문구로 구성.

gap 항목의 "1개까지만 질문" 규칙은 그래프 루프(coverage_next)에서 처리한다 — 여기서는
모든 항목을 보존(커버리지/리포트 미검증 표기용)하고, 정렬만 한다.

입력:
- resume: dict (parsedData)
- job_posting: dict | None (JD 필수화 후에는 항상 존재)
- fit_analysis: {skill_match: {matched, gap, coverage} | None, avoid_topics: list}

출력:
- (RubricItem 리스트, source)  source: "llm" | "rule_fallback"
"""
from __future__ import annotations

import logging

from app.agent.interview.fit_analysis import _summarize_jd, _summarize_resume
from app.agent.interview.state import RubricItem
from app.lib.llm_client import call_llm_json
from app.prompts.agent import RUBRIC_BUILDER_PROMPT

logger = logging.getLogger(__name__)

MIN_RUBRIC_ITEMS = 3
MAX_RUBRIC_ITEMS = 6


def _normalize(s: str) -> str:
    return str(s).lower().replace(".", "").replace("-", "").replace(" ", "").strip()


def _rubric_query(label: str, refs: list[str]) -> str:
    """RAG 검색용 쿼리. 루브릭 label + 매칭 스킬 결합."""
    extra = " ".join(refs[:3])
    return f"{label} {extra}".strip() or label or "직무 역량"


def _jd_phrases(jd: dict | None) -> list[str]:
    if not isinstance(jd, dict):
        return []
    out: list[str] = []
    for key in ("requirements", "responsibilities", "duties", "preferred"):
        v = jd.get(key)
        if isinstance(v, list):
            out.extend(str(x).strip() for x in v if str(x).strip())
    return out


async def _suggest_rubric_llm(
    resume: dict, job_posting: dict | None, matched: list[str], gap: list[str]
) -> list[dict]:
    """LLM으로 JD 루브릭 항목 추출. 실패/빈 결과 시 빈 리스트(호출자 폴백)."""
    try:
        prompt = RUBRIC_BUILDER_PROMPT.format(
            resume_brief=_summarize_resume(resume),
            jd_brief=_summarize_jd(job_posting),
            matched=", ".join(matched) or "(없음)",
            gap=", ".join(gap) or "(없음)",
        )
        result = await call_llm_json(
            prompt,
            temperature=0.3,
            max_tokens=1200,
            tag="rubric_builder",
        )
        raw = result.get("rubric") if isinstance(result, dict) else None
        items: list[dict] = []
        for r in raw or []:
            if not isinstance(r, dict):
                continue
            label = str(r.get("label") or "").strip()
            if not label:
                continue
            items.append(
                {
                    "label": label[:40],
                    "jd_requirement": str(r.get("jd_requirement") or label).strip()[:200],
                    "importance": "must"
                    if str(r.get("importance", "")).lower() == "must"
                    else "nice",
                }
            )
        return items
    except Exception as exc:
        logger.warning("rubric_builder LLM failed: %s", exc)
        return []


def _make_item(
    *,
    label: str,
    jd_requirement: str,
    importance: str,
    has_evidence: bool,
    refs: list[str],
) -> RubricItem:
    imp = "must" if importance == "must" else "nice"
    return {
        "id": "",  # _assign_ids에서 채움
        "label": label,
        "jd_requirement": jd_requirement,
        "importance": imp,  # type: ignore[typeddict-item]
        "has_evidence": has_evidence,
        "evidence_refs": refs,
        "query": _rubric_query(label, refs),
    }


def _build_items_from_llm(raw_items: list[dict], matched: list[str]) -> list[RubricItem]:
    matched_keys = {_normalize(s): str(s) for s in matched if s}
    items: list[RubricItem] = []
    for r in raw_items:
        text_norm = _normalize(f"{r['label']} {r['jd_requirement']}")
        # len(k)>=2: 단음절 스킬("C","R")이 루브릭 텍스트에 우연히 서브스트링
        # 매칭되어 false-positive evidence가 잡히는 것을 방지.
        refs = [orig for k, orig in matched_keys.items() if len(k) >= 2 and k in text_norm]
        items.append(
            _make_item(
                label=r["label"],
                jd_requirement=r["jd_requirement"],
                importance=r["importance"],
                has_evidence=bool(refs),
                refs=refs,
            )
        )
    return items


def _fallback_rubric(
    job_posting: dict | None, matched: list[str], gap: list[str]
) -> list[RubricItem]:
    """LLM 실패 폴백: matched(근거 있음) + gap(근거 없음) → 부족 시 JD 문구."""
    items: list[RubricItem] = []
    for s in matched[:4]:
        items.append(
            _make_item(
                label=str(s),
                jd_requirement=f"JD 요구 기술: {s}",
                importance="must",
                has_evidence=True,
                refs=[str(s)],
            )
        )
    for s in gap[:3]:
        items.append(
            _make_item(
                label=str(s),
                jd_requirement=f"JD 요구 기술(이력서 미언급): {s}",
                importance="must",
                has_evidence=False,
                refs=[],
            )
        )
    if not items:
        for phrase in _jd_phrases(job_posting)[:4]:
            items.append(
                _make_item(
                    label=phrase[:25],
                    jd_requirement=phrase,
                    importance="must",
                    has_evidence=False,
                    refs=[],
                )
            )
    if not items:
        items.append(
            _make_item(
                label="핵심 직무 역량",
                jd_requirement="채용공고 핵심 요구역량",
                importance="must",
                has_evidence=False,
                refs=[],
            )
        )
    return items


def _sort_and_cap(items: list[RubricItem]) -> list[RubricItem]:
    """must 우선 → 같은 importance 내에서는 evidence(근거 있음) 우선. 최대 6개."""

    def _key(it: RubricItem) -> tuple[int, int]:
        return (0 if it["importance"] == "must" else 1, 0 if it["has_evidence"] else 1)

    ordered = sorted(items, key=_key)
    return _assign_ids(ordered[:MAX_RUBRIC_ITEMS])


def _assign_ids(items: list[RubricItem]) -> list[RubricItem]:
    for i, it in enumerate(items):
        it["id"] = f"r{i + 1}"
    return items


async def build_rubric_plan(
    resume: dict,
    job_posting: dict | None,
    fit_analysis: dict | None,
) -> tuple[list[RubricItem], str]:
    """JD 루브릭 플랜 생성. 반환: (rubric_plan, source)."""
    fa = fit_analysis or {}
    skill_match = fa.get("skill_match") or {}
    matched = [str(s) for s in (skill_match.get("matched") or []) if s]
    gap = [str(s) for s in (skill_match.get("gap") or []) if s]

    raw_items = await _suggest_rubric_llm(resume, job_posting, matched, gap)
    if raw_items:
        items = _build_items_from_llm(raw_items, matched)
        source = "llm"
    else:
        items = _fallback_rubric(job_posting, matched, gap)
        source = "rule_fallback"

    # LLM이 항목을 너무 적게 냈고 폴백 재료가 있으면 보충
    if source == "llm" and len(items) < MIN_RUBRIC_ITEMS:
        seen = {_normalize(it["label"]) for it in items}
        for extra in _fallback_rubric(job_posting, matched, gap):
            if _normalize(extra["label"]) not in seen:
                items.append(extra)
                seen.add(_normalize(extra["label"]))

    return _sort_and_cap(items), source
