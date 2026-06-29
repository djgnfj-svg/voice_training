# backend/app/agent/report_aggregator.py
"""리포트 생성 직전 conversation_history를 집계하는 순수 함수.

LLM이 원문을 "느낌"으로 판단하지 않도록 점수/phase/주제/키워드를 구조화해 프롬프트에 주입한다.
"""
from __future__ import annotations

from collections import defaultdict

_CATEGORY_KEYS = ("clarity", "accuracy", "practicality", "depth", "completeness")
_KEYWORD_TOP = 10


def _iter_valid_turns(conversation_history: list[dict]):
    """유효 평가가 있는 턴만 (qIdx, turn) yield.

    qIdx는 저장된 question_number 우선, 없으면 순서 인덱스.
    스킵된 질문이 히스토리에서 빠져도 프론트의 Q번호와 일치하도록 보장.
    """
    for i, turn in enumerate(conversation_history, start=1):
        if turn.get("answer") == "(건너뜀)":
            continue
        ev = turn.get("evaluation")
        if not ev or not isinstance(ev, dict):
            continue
        scores = ev.get("scores")
        if not isinstance(scores, dict) or not scores:
            continue
        q_num = turn.get("question_number")
        q_idx = q_num if isinstance(q_num, int) and q_num > 0 else i
        yield q_idx, turn


def _avg(values: list[float]) -> int:
    return int(round(sum(values) / len(values))) if values else 0


def _aggregate_categories(turns: list[tuple[int, dict]]) -> dict:
    out: dict[str, dict] = {}
    for key in _CATEGORY_KEYS:
        vals = []
        for _, turn in turns:
            v = turn["evaluation"]["scores"].get(key)
            if isinstance(v, (int, float)):
                vals.append(float(v))
        if not vals:
            continue
        out[key] = {
            "avg": int(round(sum(vals) / len(vals))),
            "min": int(round(min(vals))),
            "max": int(round(max(vals))),
        }
    return out


def _aggregate_coverage(turns: list[tuple[int, dict]]) -> list[dict]:
    """JD 루브릭 항목(rubricLabel)별로 검증 성과를 집계. meta.rubricLabel 기준."""
    groups: dict[str, dict] = {}
    order: list[str] = []
    for q_idx, turn in turns:
        meta = turn["evaluation"].get("meta") or {}
        label = meta.get("rubricLabel")
        if not label:
            continue
        if label not in groups:
            groups[label] = {
                "scores": [],
                "qIndices": [],
                "hasEvidence": bool(meta.get("hasEvidence")),
                "importance": meta.get("importance") or "",
            }
            order.append(label)
        overall = turn["evaluation"].get("overallScore")
        if isinstance(overall, (int, float)):
            groups[label]["scores"].append(float(overall))
        groups[label]["qIndices"].append(q_idx)
    return [
        {
            "label": label,
            "hasEvidence": groups[label]["hasEvidence"],
            "importance": groups[label]["importance"],
            "avg": _avg(groups[label]["scores"]),
            "qIndices": groups[label]["qIndices"],
        }
        for label in order
    ]


def _aggregate_keywords(turns: list[tuple[int, dict]], field: str) -> list[dict]:
    order: list[str] = []  # 첫 등장 순서 보존 (lowercase 키)
    display: dict[str, str] = {}  # lowercase → 원형
    counts: dict[str, int] = defaultdict(int)
    indices: dict[str, list[int]] = defaultdict(list)
    for q_idx, turn in turns:
        kws = turn["evaluation"].get(field) or []
        if not isinstance(kws, list):
            continue
        for kw in kws:
            if not isinstance(kw, str):
                continue
            stripped = kw.strip()
            if not stripped:
                continue
            key = stripped.lower()
            if key not in display:
                display[key] = stripped
                order.append(key)
            counts[key] += 1
            indices[key].append(q_idx)
    # 빈도 내림차순, 동률은 첫 등장 순
    ordered = sorted(order, key=lambda k: (-counts[k], order.index(k)))
    return [
        {"keyword": display[k], "count": counts[k], "qIndices": indices[k]}
        for k in ordered[:_KEYWORD_TOP]
    ]


def _extremes(turns: list[tuple[int, dict]]) -> dict:
    if not turns:
        return {"best": None, "worst": None}
    scored = []
    for q_idx, turn in turns:
        overall = turn["evaluation"].get("overallScore")
        if isinstance(overall, (int, float)):
            scored.append((q_idx, float(overall), turn.get("question", "")))
    if not scored:
        return {"best": None, "worst": None}
    best = max(scored, key=lambda x: x[1])
    worst = min(scored, key=lambda x: x[1])
    return {
        "best": {"qIdx": best[0], "score": int(round(best[1])), "question": best[2]},
        "worst": {"qIdx": worst[0], "score": int(round(worst[1])), "question": worst[2]},
    }


def aggregate_evaluations(conversation_history: list[dict]) -> dict:
    """전체 집계 엔트리 포인트."""
    turns = list(_iter_valid_turns(conversation_history))
    overalls = [
        t[1]["evaluation"].get("overallScore")
        for t in turns
        if isinstance(t[1]["evaluation"].get("overallScore"), (int, float))
    ]
    overall_stats = {
        "count": len(overalls),
        "avg": _avg([float(x) for x in overalls]),
        "min": int(round(min(overalls))) if overalls else 0,
        "max": int(round(max(overalls))) if overalls else 0,
    }
    return {
        "overallStats": overall_stats,
        "categoryBreakdown": _aggregate_categories(turns),
        "coverageAnalysis": _aggregate_coverage(turns),
        "keywordStats": {
            "demonstrated": _aggregate_keywords(turns, "demonstratedKeywords"),
            "missing": _aggregate_keywords(turns, "missingKeywords"),
        },
        "extremes": _extremes(turns),
    }


def format_aggregate_for_prompt(agg: dict) -> str:
    """집계 결과를 LLM 프롬프트에 넣을 사람이 읽기 좋은 텍스트로 변환."""
    lines: list[str] = []
    stats = agg.get("overallStats", {})
    lines.append(f"전체: {stats.get('count', 0)}개 답변, 평균 {stats.get('avg', 0)}점 (최저 {stats.get('min', 0)} / 최고 {stats.get('max', 0)})")

    cat = agg.get("categoryBreakdown") or {}
    if cat:
        labels = {"clarity": "전달력", "accuracy": "정확성", "practicality": "실무력", "depth": "깊이", "completeness": "완성도"}
        lines.append("")
        lines.append("[역량별 평균/최저/최고]")
        for key in ("clarity", "accuracy", "practicality", "depth", "completeness"):
            if key in cat:
                c = cat[key]
                lines.append(f"- {labels[key]}: 평균 {c['avg']} (최저 {c['min']} / 최고 {c['max']})")

    coverage = agg.get("coverageAnalysis") or []
    if coverage:
        lines.append("")
        lines.append("[JD 루브릭 커버리지 — 검증된 요구역량별 성과]")
        for c in coverage:
            mode = "근거 있음" if c.get("hasEvidence") else "근거 없음(gap)"
            imp = c.get("importance") or ""
            lines.append(
                f"- '{c['label']}' ({mode}{', ' + imp if imp else ''}): "
                f"평균 {c['avg']}점, Q{','.join(map(str, c['qIndices']))}"
            )

    ext = agg.get("extremes") or {}
    if ext.get("best") or ext.get("worst"):
        lines.append("")
        lines.append("[최고/최저 답변]")
        if ext.get("best"):
            b = ext["best"]
            lines.append(f"- 최고 Q{b['qIdx']} ({b['score']}점): {b['question']}")
        if ext.get("worst"):
            w = ext["worst"]
            lines.append(f"- 최저 Q{w['qIdx']} ({w['score']}점): {w['question']}")

    kws = agg.get("keywordStats") or {}
    demo = kws.get("demonstrated") or []
    miss = kws.get("missing") or []
    if demo:
        lines.append("")
        lines.append("[답변에서 잘 다룬 기술 키워드 (빈도순)]")
        for k in demo:
            lines.append(f"- {k['keyword']} ×{k['count']} (Q{','.join(map(str, k['qIndices']))})")
    if miss:
        lines.append("")
        lines.append("[답변에서 빠진 핵심 기술 키워드 (빈도순)]")
        for k in miss:
            lines.append(f"- {k['keyword']} ×{k['count']} (Q{','.join(map(str, k['qIndices']))})")

    return "\n".join(lines) if lines else "집계 데이터 없음"
