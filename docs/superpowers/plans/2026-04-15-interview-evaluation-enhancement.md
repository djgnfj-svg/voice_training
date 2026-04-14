# AI 코치 면접 평가 고도화 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 코치 면접의 질문별 평가와 종합 리포트를 수치·페이즈·기술키워드 기반의 구체적 분석으로 고도화한다.

**Architecture:** (1) 평가 JSON에 `demonstratedKeywords`/`missingKeywords`와 `meta.phase/topic`을 추가해 구조화, (2) 리포트 생성 직전 순수 함수로 점수·phase·주제·키워드 집계를 만들어 프롬프트에 주입, (3) 리포트 스키마를 확장해 `questionRefs`/`questionHighlights`/`phaseInsight`/`technicalDiagnosis` 포함, (4) 프론트는 신 필드가 있을 때만 렌더 (기존 세션 호환).

**Tech Stack:** FastAPI · SQLAlchemy · OpenAI LLM JSON · Next.js 15 · TanStack Query · shadcn/ui · pytest

Spec: `docs/superpowers/specs/2026-04-15-interview-evaluation-enhancement-design.md`

---

## 파일 구조

**백엔드 — 수정:**
- `backend/app/prompts/agent.py` — `EVALUATOR_PROMPT`에 키워드 필드 추가, `REPORT_PROMPT` 재설계 (집계 주입 + 신 출력 스키마)
- `backend/app/agent/evaluator_agent.py` — `_normalize_evaluation` 키워드 clamp/dedupe + `generate_report` 집계 호출
- `backend/app/agent/nodes.py:388-427` — `evaluate_answer` 노드에서 `evaluation.meta`에 phase/topic/scanIdx/diveIdx 주입

**백엔드 — 생성:**
- `backend/app/agent/report_aggregator.py` — 순수 집계 함수
- `backend/tests/test_report_aggregator.py`
- `backend/tests/test_evaluator_normalize.py`

**프론트 — 수정:**
- `frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx` — 신 필드 방어적 렌더 (종합/질문별/개선점 탭 확장)

---

## Task 1: EVALUATOR_PROMPT 키워드 필드 추가 + 정규화 테스트

**Files:**
- Modify: `backend/app/prompts/agent.py:167-223`
- Modify: `backend/app/agent/evaluator_agent.py:22-81`
- Create: `backend/tests/test_evaluator_normalize.py`

- [ ] **Step 1: 테스트 파일 작성 (실패 테스트)**

Create `backend/tests/test_evaluator_normalize.py`:

```python
"""Tests for _normalize_evaluation keyword handling."""
from app.agent.evaluator_agent import _normalize_evaluation


def _base(scores: dict | None = None) -> dict:
    return {
        "scores": scores or {"clarity": 80, "accuracy": 70, "practicality": 60, "depth": 50, "completeness": 40},
        "briefFeedback": "",
        "detailedFeedback": "",
        "modelAnswer": "",
        "demonstratedKeywords": [],
        "missingKeywords": [],
    }


def test_keywords_preserved_for_normal_answer():
    ev = _base()
    ev["demonstratedKeywords"] = ["JWT", "refresh token rotation", "HttpOnly cookie"]
    ev["missingKeywords"] = ["CSRF 방어"]
    out = _normalize_evaluation(ev, "JWT와 refresh token rotation으로 세션을 관리합니다. HttpOnly 쿠키로 XSS 방어하고 토큰 만료 시 재발급합니다.")
    assert out["demonstratedKeywords"] == ["JWT", "refresh token rotation", "HttpOnly cookie"]
    assert out["missingKeywords"] == ["CSRF 방어"]


def test_keywords_cleared_on_quality_cap():
    """저품질 답변(반복/단답)은 키워드를 빈 배열로 강제."""
    ev = _base({"clarity": 90, "accuracy": 90, "practicality": 90, "depth": 90, "completeness": 90})
    ev["demonstratedKeywords"] = ["React", "상태관리"]
    ev["missingKeywords"] = ["useReducer"]
    # 10자 미만 → cap=15
    out = _normalize_evaluation(ev, "몰라요")
    assert out["demonstratedKeywords"] == []
    assert out["missingKeywords"] == []
    # 모든 점수가 15 이하여야 함
    assert max(out["scores"].values()) <= 15


def test_demonstrated_keywords_clamped_to_8():
    ev = _base()
    ev["demonstratedKeywords"] = [f"k{i}" for i in range(15)]
    out = _normalize_evaluation(ev, "충분히 긴 정상 답변입니다. " * 10)
    assert len(out["demonstratedKeywords"]) == 8


def test_missing_keywords_clamped_to_5():
    ev = _base()
    ev["missingKeywords"] = [f"m{i}" for i in range(9)]
    out = _normalize_evaluation(ev, "충분히 긴 정상 답변입니다. " * 10)
    assert len(out["missingKeywords"]) == 5


def test_keywords_dedup_case_insensitive():
    ev = _base()
    ev["demonstratedKeywords"] = ["JWT", "jwt", "  JWT  ", "React"]
    out = _normalize_evaluation(ev, "충분히 긴 정상 답변입니다. " * 10)
    # 소문자 키로 dedupe하되 첫 등장 원형 유지
    assert out["demonstratedKeywords"] == ["JWT", "React"]


def test_missing_missing_keywords_defaults_to_empty_list():
    ev = _base()
    # 필드가 아예 없는 경우
    ev.pop("demonstratedKeywords", None)
    ev.pop("missingKeywords", None)
    out = _normalize_evaluation(ev, "충분히 긴 정상 답변입니다. " * 10)
    assert out["demonstratedKeywords"] == []
    assert out["missingKeywords"] == []


def test_blank_and_non_string_filtered():
    ev = _base()
    ev["demonstratedKeywords"] = ["", "  ", None, 123, "React"]
    out = _normalize_evaluation(ev, "충분히 긴 정상 답변입니다. " * 10)
    assert out["demonstratedKeywords"] == ["React"]
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `docker compose exec backend pytest backend/tests/test_evaluator_normalize.py -v`
Expected: FAIL (키워드 후처리 로직 부재)

- [ ] **Step 3: `_normalize_evaluation`에 키워드 정규화 헬퍼 + 로직 추가**

Edit `backend/app/agent/evaluator_agent.py`, `_normalize_evaluation` 함수 바로 위에 헬퍼 추가:

```python
_DEMONSTRATED_MAX = 8
_MISSING_MAX = 5


def _normalize_keywords(raw, limit: int) -> list[str]:
    """문자열만, trim, 빈값 제거, 대소문자 무시 dedupe, 최대 limit개."""
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        stripped = item.strip()
        if not stripped:
            continue
        key = stripped.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(stripped)
        if len(out) >= limit:
            break
    return out
```

그리고 `_normalize_evaluation` 마지막 부분에 키워드 처리를 추가:

```python
def _normalize_evaluation(evaluation: dict, answer: str = "") -> dict:
    """LLM 출력 후처리: scores 0~100 clamp + 저품질 답변 cap + overallScore 가중 평균 강제
    + 기술 키워드 배열 clamp/dedupe."""
    raw_scores = evaluation.get("scores") or {}
    scores: dict[str, int] = {}
    for key in SCORE_WEIGHTS:
        scores[key] = _clamp_score(raw_scores.get(key))

    cap = _quality_cap(answer)
    if cap is not None:
        for key in scores:
            if scores[key] > cap:
                scores[key] = cap
        logger.info("Applied quality cap=%d to scores (answer_len=%d)", cap, len(answer or ""))

    overall = sum(scores[k] * w for k, w in SCORE_WEIGHTS.items())
    evaluation["scores"] = scores
    evaluation["overallScore"] = int(round(overall))

    # 기술 키워드 정규화
    if cap is not None:
        # 저품질 답변은 키워드 배열도 신뢰할 수 없음 → 비움
        evaluation["demonstratedKeywords"] = []
        evaluation["missingKeywords"] = []
    else:
        evaluation["demonstratedKeywords"] = _normalize_keywords(
            evaluation.get("demonstratedKeywords"), _DEMONSTRATED_MAX
        )
        evaluation["missingKeywords"] = _normalize_keywords(
            evaluation.get("missingKeywords"), _MISSING_MAX
        )

    return evaluation
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `docker compose exec backend pytest backend/tests/test_evaluator_normalize.py -v`
Expected: 모든 테스트 PASS (7 passed)

- [ ] **Step 5: `EVALUATOR_PROMPT` 출력 스키마 + 지시사항 확장**

Edit `backend/app/prompts/agent.py` — `EVALUATOR_PROMPT` 문자열의 `## 저품질 답변 규칙` 섹션 바로 다음, `overallScore는 넣지 마세요 —` 라인 위에 추가:

```
## 기술 키워드 추출 (필수)
답변을 읽고 아래 두 배열을 채우세요.

- `demonstratedKeywords`: 답변에서 실제로 "설명·경험·결정근거"와 함께 다룬 기술 개념 3~8개
  - 원문 표현 또는 정식 명칭 사용 (예: "JWT", "refresh token rotation", "HttpOnly cookie", "React fiber")
  - 일반 단어 금지 — 식별 가능한 기술·패턴·개념·도구명만 (예: "서버", "데이터", "코드" X)
  - 단순 언급만 하고 설명 없는 키워드는 제외

- `missingKeywords`: 이 질문과 이력서 기술스택을 고려할 때 **언급됐어야 하나 빠진** 핵심 개념 0~5개
  - 추상 표현 금지 (예: "이해 부족", "설명 부족" X)
  - 반드시 구체적 기술 용어 (예: "CSRF 방어", "토큰 만료 처리", "Saga 패턴", "인덱스 전략")
  - 해당 질문에서 자연스럽게 기대되는 개념일 때만. 과장·추측 금지

저품질 답변(반복·단답·포기)일 경우 두 배열 모두 빈 배열 `[]`로 반환하세요.
```

그리고 JSON 스키마 부분을 다음으로 교체:

```
반드시 다음 JSON만 반환하세요:
{{
  "scores": {{
    "clarity": 0,
    "accuracy": 0,
    "practicality": 0,
    "depth": 0,
    "completeness": 0
  }},
  "briefFeedback": "잘한 점 1가지 + 개선할 점 1가지, 2문장 이내",
  "detailedFeedback": "상세 피드백 3-5문장. 구체적 개선 제안 1개 이상 포함",
  "modelAnswer": "모범 답안 (150-300자, 구어체 존댓말)",
  "demonstratedKeywords": ["답변에서 다룬 기술 개념"],
  "missingKeywords": ["답변에서 빠진 핵심 개념"],
  "weaknessDetected": "새로 발견된 약점 (없으면 null)"
}}
```

- [ ] **Step 6: 커밋**

```bash
git add backend/app/prompts/agent.py backend/app/agent/evaluator_agent.py backend/tests/test_evaluator_normalize.py
git commit -m "feat(evaluator): demonstrated/missing 기술 키워드 필드 + 정규화"
```

---

## Task 2: evaluate_answer 노드에서 evaluation.meta 주입

**Files:**
- Modify: `backend/app/agent/nodes.py:388-427`

질문별 메시지 저장 시 phase/scanIdx/diveIdx/topicLabel/angle이 이후 집계 함수에서 필요. 현재 `AgentInterviewMessage.evaluation` JSON은 자유 구조이므로 `evaluation["meta"]`에 주입한다.

- [ ] **Step 1: `evaluate_answer` 함수에 meta 주입 로직 추가**

Edit `backend/app/agent/nodes.py` — `evaluate_answer` 함수 내부에서 `evaluator_agent.evaluate_answer(...)` 호출 직후, `history.append(...)` 전에 meta 삽입:

```python
    evaluation = await evaluator_agent.evaluate_answer(
        state["current_question"],
        state["current_answer"],
        state.get("user_profile", {}),
        state.get("conversation_history", []),
    )

    # 집계용 메타 주입: 리포트 생성 시 phase/주제별로 묶기 위함
    phase = state.get("phase", "scan")
    meta: dict = {"phase": phase}
    if phase == "scan":
        scan_idx = state.get("current_scan_idx", 0)
        scan_plan = state.get("scan_plan") or []
        if 0 <= scan_idx < len(scan_plan):
            meta["scanIdx"] = scan_idx
            meta["projectRef"] = scan_plan[scan_idx].get("project_ref", "")
    elif phase == "dive":
        dive_idx = state.get("current_dive_idx", 0)
        dive_plan = state.get("dive_plan") or []
        if 0 <= dive_idx < len(dive_plan):
            topic = dive_plan[dive_idx]
            meta["diveIdx"] = dive_idx
            meta["topicLabel"] = topic.get("topic", "")
            meta["angle"] = topic.get("angle", "")
            meta["projectRef"] = topic.get("project_ref", "")
            meta["diveDepth"] = state.get("current_dive_depth", 0)
    evaluation["meta"] = meta

    history = list(state.get("conversation_history", []))
```

- [ ] **Step 2: 통합 테스트 — dev에서 면접 1턴 진행해 meta 저장 확인**

Run: dev 브라우저에서 면접 시작 → scan 1답변 → DB 확인:

```bash
docker compose exec backend python -c "
import asyncio, json
from sqlalchemy import select
from app.db.session import async_session_maker
from app.db.models import AgentInterviewMessage
async def main():
    async with async_session_maker() as db:
        r = await db.execute(select(AgentInterviewMessage).where(AgentInterviewMessage.role=='user_answer').order_by(AgentInterviewMessage.id.desc()).limit(1))
        m = r.scalar_one_or_none()
        if m and m.evaluation:
            print(json.dumps(m.evaluation.get('meta'), ensure_ascii=False, indent=2))
asyncio.run(main())
"
```

Expected: `{"phase": "scan", "scanIdx": 0, "projectRef": "..."}` 출력

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/nodes.py
git commit -m "feat(agent): 답변 평가에 phase/주제 meta 주입"
```

---

## Task 3: report_aggregator 순수 함수 작성

**Files:**
- Create: `backend/app/agent/report_aggregator.py`
- Create: `backend/tests/test_report_aggregator.py`

- [ ] **Step 1: 테스트 파일 작성**

Create `backend/tests/test_report_aggregator.py`:

```python
"""Tests for aggregate_evaluations."""
from app.agent.report_aggregator import aggregate_evaluations


def _turn(q: str, score: int, *, scores: dict | None = None, meta: dict | None = None,
          demo: list[str] | None = None, miss: list[str] | None = None) -> dict:
    return {
        "question": q,
        "answer": "답변",
        "evaluation": {
            "scores": scores or {"clarity": score, "accuracy": score, "practicality": score, "depth": score, "completeness": score},
            "overallScore": score,
            "demonstratedKeywords": demo or [],
            "missingKeywords": miss or [],
            "meta": meta or {"phase": "scan"},
        },
    }


def test_empty_history_returns_safe_defaults():
    out = aggregate_evaluations([])
    assert out["overallStats"]["count"] == 0
    assert out["categoryBreakdown"] == {}
    assert out["phaseAnalysis"] == {"scan": {"avg": 0, "count": 0, "qIndices": []}, "dive": {"avg": 0, "count": 0, "qIndices": []}}
    assert out["diveTopicAnalysis"] == []
    assert out["keywordStats"] == {"demonstrated": [], "missing": []}
    assert out["extremes"]["best"] is None
    assert out["extremes"]["worst"] is None


def test_category_breakdown_avg_min_max():
    history = [
        _turn("Q1", 80, scores={"clarity": 80, "accuracy": 70, "practicality": 60, "depth": 50, "completeness": 40}),
        _turn("Q2", 60, scores={"clarity": 60, "accuracy": 90, "practicality": 40, "depth": 70, "completeness": 60}),
    ]
    out = aggregate_evaluations(history)
    assert out["categoryBreakdown"]["clarity"] == {"avg": 70, "min": 60, "max": 80}
    assert out["categoryBreakdown"]["accuracy"] == {"avg": 80, "min": 70, "max": 90}


def test_phase_analysis_splits_scan_and_dive():
    history = [
        _turn("Q1", 80, meta={"phase": "scan", "scanIdx": 0, "projectRef": "P1"}),
        _turn("Q2", 60, meta={"phase": "scan", "scanIdx": 1, "projectRef": "P2"}),
        _turn("Q3", 40, meta={"phase": "dive", "diveIdx": 0, "topicLabel": "T", "angle": "weakness", "projectRef": "P1"}),
    ]
    out = aggregate_evaluations(history)
    assert out["phaseAnalysis"]["scan"] == {"avg": 70, "count": 2, "qIndices": [1, 2]}
    assert out["phaseAnalysis"]["dive"] == {"avg": 40, "count": 1, "qIndices": [3]}


def test_extremes_best_and_worst():
    history = [
        _turn("왜 React를 썼나요", 80),
        _turn("DB 설계 설명", 40),
        _turn("배포 파이프라인", 90),
    ]
    out = aggregate_evaluations(history)
    assert out["extremes"]["best"]["qIdx"] == 3
    assert out["extremes"]["best"]["score"] == 90
    assert out["extremes"]["worst"]["qIdx"] == 2
    assert out["extremes"]["worst"]["score"] == 40


def test_dive_topic_analysis_groups_by_topic_and_angle():
    history = [
        _turn("Q1", 50, meta={"phase": "dive", "diveIdx": 0, "topicLabel": "분산 TX", "angle": "weakness", "projectRef": "P1"}),
        _turn("Q2", 60, meta={"phase": "dive", "diveIdx": 0, "topicLabel": "분산 TX", "angle": "weakness", "projectRef": "P1"}),
        _turn("Q3", 85, meta={"phase": "dive", "diveIdx": 1, "topicLabel": "React 최적화", "angle": "strength", "projectRef": "P2"}),
    ]
    out = aggregate_evaluations(history)
    # 2개 주제 그룹, 각 avg/qIndices
    topics = {(t["topicLabel"], t["angle"]): t for t in out["diveTopicAnalysis"]}
    assert topics[("분산 TX", "weakness")]["avg"] == 55
    assert topics[("분산 TX", "weakness")]["qIndices"] == [1, 2]
    assert topics[("React 최적화", "strength")]["avg"] == 85


def test_keyword_stats_count_and_indices():
    history = [
        _turn("Q1", 70, demo=["JWT", "refresh token"], miss=["CSRF"]),
        _turn("Q2", 60, demo=["JWT", "React"], miss=["CSRF", "XSS"]),
        _turn("Q3", 80, demo=["React"], miss=[]),
    ]
    out = aggregate_evaluations(history)
    demo = {k["keyword"]: k for k in out["keywordStats"]["demonstrated"]}
    assert demo["JWT"]["count"] == 2
    assert demo["JWT"]["qIndices"] == [1, 2]
    assert demo["React"]["count"] == 2
    miss = {k["keyword"]: k for k in out["keywordStats"]["missing"]}
    assert miss["CSRF"]["count"] == 2
    assert miss["XSS"]["count"] == 1


def test_keyword_stats_top_10_only():
    history = [_turn("Q1", 70, demo=[f"k{i}" for i in range(15)])]
    out = aggregate_evaluations(history)
    assert len(out["keywordStats"]["demonstrated"]) <= 10


def test_skipped_answers_excluded():
    """'(건너뜀)' 답변이나 evaluation 없는 턴은 제외."""
    history = [
        _turn("Q1", 80),
        {"question": "Q2", "answer": "(건너뜀)", "evaluation": None},
        {"question": "Q3", "answer": "답", "evaluation": {}},  # 빈 평가
    ]
    out = aggregate_evaluations(history)
    assert out["overallStats"]["count"] == 1
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `docker compose exec backend pytest backend/tests/test_report_aggregator.py -v`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: `report_aggregator.py` 작성**

Create `backend/app/agent/report_aggregator.py`:

```python
# backend/app/agent/report_aggregator.py
"""리포트 생성 직전 conversation_history를 집계하는 순수 함수.

LLM이 원문을 "느낌"으로 판단하지 않도록 점수/phase/주제/키워드를 구조화해 프롬프트에 주입한다.
"""
from __future__ import annotations

from collections import defaultdict

_CATEGORY_KEYS = ("clarity", "accuracy", "practicality", "depth", "completeness")
_KEYWORD_TOP = 10


def _iter_valid_turns(conversation_history: list[dict]):
    """유효 평가가 있는 턴만 (qIdx, turn) yield. qIdx는 1부터."""
    for i, turn in enumerate(conversation_history, start=1):
        if turn.get("answer") == "(건너뜀)":
            continue
        ev = turn.get("evaluation")
        if not ev or not isinstance(ev, dict):
            continue
        scores = ev.get("scores")
        if not isinstance(scores, dict) or not scores:
            continue
        yield i, turn


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


def _aggregate_phase(turns: list[tuple[int, dict]]) -> dict:
    buckets = {"scan": [], "dive": []}
    indices = {"scan": [], "dive": []}
    for q_idx, turn in turns:
        meta = turn["evaluation"].get("meta") or {}
        phase = meta.get("phase")
        if phase not in buckets:
            continue
        overall = turn["evaluation"].get("overallScore")
        if isinstance(overall, (int, float)):
            buckets[phase].append(float(overall))
            indices[phase].append(q_idx)
    return {
        "scan": {"avg": _avg(buckets["scan"]), "count": len(buckets["scan"]), "qIndices": indices["scan"]},
        "dive": {"avg": _avg(buckets["dive"]), "count": len(buckets["dive"]), "qIndices": indices["dive"]},
    }


def _aggregate_dive_topics(turns: list[tuple[int, dict]]) -> list[dict]:
    groups: dict[tuple[str, str], dict] = defaultdict(lambda: {"scores": [], "qIndices": [], "projectRef": ""})
    for q_idx, turn in turns:
        meta = turn["evaluation"].get("meta") or {}
        if meta.get("phase") != "dive":
            continue
        label = meta.get("topicLabel") or ""
        angle = meta.get("angle") or ""
        if not label:
            continue
        key = (label, angle)
        overall = turn["evaluation"].get("overallScore")
        if isinstance(overall, (int, float)):
            groups[key]["scores"].append(float(overall))
        groups[key]["qIndices"].append(q_idx)
        if not groups[key]["projectRef"]:
            groups[key]["projectRef"] = meta.get("projectRef", "")
    return [
        {
            "topicLabel": label,
            "angle": angle,
            "projectRef": g["projectRef"],
            "avg": _avg(g["scores"]),
            "qIndices": g["qIndices"],
        }
        for (label, angle), g in groups.items()
    ]


def _aggregate_keywords(turns: list[tuple[int, dict]], field: str) -> list[dict]:
    order: list[str] = []  # 첫 등장 순서 보존
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
        "phaseAnalysis": _aggregate_phase(turns),
        "diveTopicAnalysis": _aggregate_dive_topics(turns),
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

    phase = agg.get("phaseAnalysis") or {}
    if phase.get("scan", {}).get("count") or phase.get("dive", {}).get("count"):
        lines.append("")
        lines.append("[페이즈별 성과]")
        s = phase.get("scan", {})
        d = phase.get("dive", {})
        lines.append(f"- 훑기(scan): {s.get('count', 0)}개, 평균 {s.get('avg', 0)}점, Q{','.join(map(str, s.get('qIndices', [])))}")
        lines.append(f"- 딥다이브(dive): {d.get('count', 0)}개, 평균 {d.get('avg', 0)}점, Q{','.join(map(str, d.get('qIndices', [])))}")

    dives = agg.get("diveTopicAnalysis") or []
    if dives:
        lines.append("")
        lines.append("[딥다이브 주제별]")
        for t in dives:
            lines.append(f"- '{t['topicLabel']}' ({t['angle']}, {t['projectRef']}): 평균 {t['avg']}점, Q{','.join(map(str, t['qIndices']))}")

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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `docker compose exec backend pytest backend/tests/test_report_aggregator.py -v`
Expected: 8 passed

- [ ] **Step 5: 커밋**

```bash
git add backend/app/agent/report_aggregator.py backend/tests/test_report_aggregator.py
git commit -m "feat(agent): report_aggregator 집계 함수 + format 헬퍼"
```

---

## Task 4: REPORT_PROMPT 재설계 + generate_report 집계 주입

**Files:**
- Modify: `backend/app/prompts/agent.py:225-244`
- Modify: `backend/app/agent/evaluator_agent.py:118-143`

- [ ] **Step 1: `REPORT_PROMPT` 교체**

Edit `backend/app/prompts/agent.py` — `REPORT_PROMPT`를 다음으로 전체 교체:

```python
REPORT_PROMPT = """다음 면접 세션의 대화와 **집계 수치**를 분석하여 종합 리포트를 생성하세요.

<집계 수치>
{aggregate_block}
</집계 수치>

<conversation_history>
{conversation_history}
</conversation_history>

<user_profile>
강점: {strengths}
약점: {weaknesses}
</user_profile>

분석 원칙 (반드시 준수):
1. 강점/개선점은 반드시 **구체적 질문 번호(Q1, Q3 등)와 기술 키워드**로 근거를 대세요. 추상 표현 금지 ("이해 부족" X → "분산 트랜잭션에서 Saga/2PC 미언급" O).
2. `technicalDiagnosis.weakTopics[].studyHint`에는 학습 키워드를 구체적으로 제시하세요 (예: "Saga 패턴 + 보상 트랜잭션의 실패 시나리오").
3. `questionHighlights.best/worst`는 집계의 "최고/최저 답변"과 일치해야 하며, reason에 해당 답변의 구체적 강약점을 인용하세요.
4. `phaseInsight`는 훑기 vs 딥다이브 성과 비교를 1~2문장으로. 둘 중 하나만 있으면 그쪽만 언급.
5. `strengths[]`와 `improvements[]`의 각 항목은 반드시 `questionRefs`에 해당 Q번호를 1개 이상 포함.

overallScore는 집계의 전체 평균(소수점 반올림)과 일치시키세요.

반드시 다음 JSON만 반환하세요:
{{
  "overallScore": 0,
  "summary": "전체 면접 종합 평가 3-5문장. 점수 근거와 기술 키워드 포함",
  "strengths": [
    {{ "text": "강점 서술 (기술 키워드 인용)", "questionRefs": [1, 2] }}
  ],
  "improvements": [
    {{ "text": "개선점 서술 (구체적 기술 개념 지적)", "questionRefs": [3] }}
  ],
  "growthNotes": "이전 프로필 대비 성장한 부분 (프로필 데이터가 없으면 null)",
  "recommendations": ["다음 면접을 위한 구체적 학습 키워드 1", "키워드 2"],
  "questionHighlights": {{
    "best": {{ "qIdx": 0, "reason": "해당 답변이 강했던 구체적 이유" }},
    "worst": {{ "qIdx": 0, "reason": "해당 답변이 약했던 구체적 이유" }}
  }},
  "phaseInsight": "훑기 vs 딥다이브 성과 비교 1-2문장 (둘 중 하나만이면 그것만)",
  "technicalDiagnosis": {{
    "strongTopics": [
      {{ "keyword": "잘 다룬 기술", "evidence": "Q2, Q4" }}
    ],
    "weakTopics": [
      {{ "keyword": "빠진 기술 개념", "reason": "어느 Q에서 어떻게 빠졌는지", "studyHint": "구체적 학습 키워드" }}
    ]
  }}
}}"""
```

- [ ] **Step 2: `generate_report` 집계 주입**

Edit `backend/app/agent/evaluator_agent.py` — 파일 상단 import에 추가:

```python
from app.agent.report_aggregator import aggregate_evaluations, format_aggregate_for_prompt
```

그리고 `generate_report` 함수를 다음으로 교체:

```python
async def generate_report(
    conversation_history: list[dict],
    user_profile: dict,
) -> dict:
    """Generate overall interview report with aggregated metrics injected."""
    aggregate = aggregate_evaluations(conversation_history)
    aggregate_block = format_aggregate_for_prompt(aggregate)

    history_parts = []
    for i, entry in enumerate(conversation_history, start=1):
        history_parts.append(f"[Q{i}] {entry.get('question', '')}")
        if entry.get("answer"):
            history_parts.append(f"A: {entry['answer']}")
        ev = entry.get("evaluation") or {}
        if ev:
            demo = ev.get("demonstratedKeywords") or []
            miss = ev.get("missingKeywords") or []
            extra = []
            if demo:
                extra.append(f"다룸: {', '.join(demo)}")
            if miss:
                extra.append(f"누락: {', '.join(miss)}")
            kw_str = " | ".join(extra)
            history_parts.append(
                f"점수: {ev.get('overallScore', '?')}" + (f" | {kw_str}" if kw_str else "")
            )
        history_parts.append("---")

    prompt = REPORT_PROMPT.format(
        aggregate_block=aggregate_block,
        conversation_history="\n".join(history_parts),
        strengths="\n".join(user_profile.get("strengths", [])) or "데이터 없음",
        weaknesses="\n".join(user_profile.get("weaknesses", [])) or "데이터 없음",
    )

    report = await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )

    # 서버 계산 집계를 리포트에 병합 (프론트에서 시각화 재계산 없도록)
    report["categoryBreakdown"] = aggregate["categoryBreakdown"]
    report["phaseAnalysis"] = aggregate["phaseAnalysis"]
    report["diveTopicAnalysis"] = aggregate["diveTopicAnalysis"]
    report["keywordStats"] = aggregate["keywordStats"]

    return report
```

- [ ] **Step 3: 기존 평가 테스트가 깨지지 않는지 확인**

Run: `docker compose exec backend pytest backend/tests/ -v --ignore=backend/tests/test_report_aggregator.py --ignore=backend/tests/test_evaluator_normalize.py`
Expected: 기존 테스트 모두 PASS (planner/fit_analyzer/state_types/job_posting_image)

- [ ] **Step 4: dev 통합 점검 — 실제 면접 1회 완주해 리포트 구조 확인**

dev 환경에서 로그인 → AI 코치 면접 시작 → 3~5개 질문 답변 → 종료 → 리포트 세션 DB 확인:

```bash
docker compose exec backend python -c "
import asyncio, json
from sqlalchemy import select
from app.db.session import async_session_maker
from app.db.models import AgentInterviewSession
async def main():
    async with async_session_maker() as db:
        r = await db.execute(select(AgentInterviewSession).order_by(AgentInterviewSession.id.desc()).limit(1))
        s = r.scalar_one_or_none()
        if s and s.report_data:
            print(json.dumps(s.report_data, ensure_ascii=False, indent=2))
asyncio.run(main())
"
```

Expected: `categoryBreakdown`, `phaseAnalysis`, `questionHighlights`, `technicalDiagnosis`, `keywordStats` 필드가 출력에 포함.

- [ ] **Step 5: 커밋**

```bash
git add backend/app/prompts/agent.py backend/app/agent/evaluator_agent.py
git commit -m "feat(report): 집계 주입 + 기술키워드/페이즈/주제 근거 기반 리포트"
```

---

## Task 5: 프론트 — 질문별 탭에 키워드 배지

**Files:**
- Modify: `frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx`

현재 질문별 상세 탭은 score 세부만 표시. `demonstratedKeywords`(녹색) / `missingKeywords`(빨강) 배지를 각 QA 카드에 추가.

- [ ] **Step 1: 질문별 탭에서 evaluation 렌더 부분 찾아 키워드 배지 추가**

Edit `frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx` — 질문별 상세 탭의 각 `qaPairs.map` 내부, 점수 세부 표시 직후에 삽입:

```tsx
{Array.isArray((qa.evaluation as any)?.demonstratedKeywords) && (qa.evaluation as any).demonstratedKeywords.length > 0 && (
  <div className="mt-3">
    <div className="text-xs font-medium text-muted-foreground">답변에서 다룬 기술</div>
    <div className="mt-1 flex flex-wrap gap-1">
      {((qa.evaluation as any).demonstratedKeywords as string[]).map((kw, i) => (
        <Badge key={i} variant="outline" className="border-green-500/40 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300">
          {kw}
        </Badge>
      ))}
    </div>
  </div>
)}
{Array.isArray((qa.evaluation as any)?.missingKeywords) && (qa.evaluation as any).missingKeywords.length > 0 && (
  <div className="mt-2">
    <div className="text-xs font-medium text-muted-foreground">빠진 핵심 개념</div>
    <div className="mt-1 flex flex-wrap gap-1">
      {((qa.evaluation as any).missingKeywords as string[]).map((kw, i) => (
        <Badge key={i} variant="outline" className="border-red-500/40 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300">
          {kw}
        </Badge>
      ))}
    </div>
  </div>
)}
```

배지 위치: "detailedFeedback" 카드 내부 또는 그 직전. 정확한 삽입 지점은 `qaPairs.map` 내에서 기존 점수 렌더 아래.

- [ ] **Step 2: 프론트 빌드 확인**

Run: `docker compose exec frontend npm run typecheck` (또는 루트에서 `cd frontend && npm run typecheck`)
Expected: 에러 0

- [ ] **Step 3: 브라우저 확인**

dev URL `http://localhost:81/agent-interview/session/<완료세션ID>` 접속 → 질문별 상세 탭 → 신 세션이면 배지 표시, 구 세션이면 렌더 안 됨(방어).

- [ ] **Step 4: 커밋**

```bash
git add "frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx"
git commit -m "feat(ui): 질문별 상세 탭에 기술 키워드 배지"
```

---

## Task 6: 프론트 — 종합 탭에 questionHighlights / phaseInsight / technicalDiagnosis

**Files:**
- Modify: `frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx`

- [ ] **Step 1: 종합 분석 탭(Summary 카드 아래, 평균 점수 카드 위)에 신 섹션 추가**

Edit 같은 파일, `<TabsContent value="overview" ...>` 내부 Summary 카드 바로 아래에 삽입:

```tsx
{/* Technical Diagnosis */}
{(report?.technicalDiagnosis?.strongTopics?.length > 0 || report?.technicalDiagnosis?.weakTopics?.length > 0) && (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Target className="h-5 w-5" />
        기술 진단
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-4">
      {report.technicalDiagnosis.strongTopics?.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-green-600 dark:text-green-400">잘 다룬 기술</div>
          <div className="flex flex-wrap gap-2">
            {report.technicalDiagnosis.strongTopics.map((t: { keyword: string; evidence?: string }, i: number) => (
              <Badge key={i} variant="outline" className="border-green-500/40 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300">
                {t.keyword}{t.evidence ? ` · ${t.evidence}` : ''}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {report.technicalDiagnosis.weakTopics?.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-red-600 dark:text-red-400">보완이 필요한 기술</div>
          <ul className="space-y-3">
            {report.technicalDiagnosis.weakTopics.map((t: { keyword: string; reason?: string; studyHint?: string }, i: number) => (
              <li key={i} className="rounded-md border border-red-500/20 bg-red-50/50 p-3 dark:bg-red-950/20">
                <div className="font-medium text-red-700 dark:text-red-300">{t.keyword}</div>
                {t.reason && <div className="mt-1 text-sm text-muted-foreground">{t.reason}</div>}
                {t.studyHint && <div className="mt-1 text-xs text-muted-foreground">학습: {t.studyHint}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardContent>
  </Card>
)}

{/* Question Highlights */}
{(report?.questionHighlights?.best || report?.questionHighlights?.worst) && (
  <Card>
    <CardHeader>
      <CardTitle>질문별 하이라이트</CardTitle>
    </CardHeader>
    <CardContent className="grid gap-3 sm:grid-cols-2">
      {report.questionHighlights.best && (
        <div className="rounded-md border border-green-500/30 bg-green-50/50 p-3 dark:bg-green-950/20">
          <div className="text-xs font-medium text-green-600 dark:text-green-400">최고 답변 · Q{report.questionHighlights.best.qIdx}</div>
          <div className="mt-1 text-sm">{report.questionHighlights.best.reason}</div>
        </div>
      )}
      {report.questionHighlights.worst && (
        <div className="rounded-md border border-red-500/30 bg-red-50/50 p-3 dark:bg-red-950/20">
          <div className="text-xs font-medium text-red-600 dark:text-red-400">개선 필요 · Q{report.questionHighlights.worst.qIdx}</div>
          <div className="mt-1 text-sm">{report.questionHighlights.worst.reason}</div>
        </div>
      )}
    </CardContent>
  </Card>
)}

{/* Phase Insight */}
{report?.phaseInsight && (
  <Card>
    <CardHeader>
      <CardTitle>페이즈별 분석</CardTitle>
    </CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm leading-relaxed">{report.phaseInsight}</p>
      {report.phaseAnalysis && (
        <div className="grid grid-cols-2 gap-3">
          {['scan', 'dive'].map((k) => {
            const p = (report.phaseAnalysis as Record<string, { avg: number; count: number }>)[k];
            if (!p || p.count === 0) return null;
            return (
              <div key={k} className="rounded-md border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">{k === 'scan' ? '훑기' : '딥다이브'}</div>
                <div className={cn('text-2xl font-bold', scoreText(p.avg))}>{p.avg}</div>
                <div className="text-xs text-muted-foreground">{p.count}개 답변</div>
              </div>
            );
          })}
        </div>
      )}
    </CardContent>
  </Card>
)}
```

- [ ] **Step 2: `strengths` / `improvements` 렌더에 `questionRefs` 지원 (string과 object 둘 다 처리)**

기존 `report.strengths.map((s: string, i: number) => (...))` 부분을 다음으로 교체:

```tsx
{report.strengths.map((s: string | { text: string; questionRefs?: number[] }, i: number) => {
  const text = typeof s === 'string' ? s : s.text;
  const refs = typeof s === 'string' ? [] : (s.questionRefs || []);
  return (
    <li key={i} className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
        {i + 1}
      </span>
      <div className="flex-1">
        <span>{text}</span>
        {refs.length > 0 && (
          <span className="ml-2 text-xs text-muted-foreground">(Q{refs.join(', Q')})</span>
        )}
      </div>
    </li>
  );
})}
```

improvements 탭의 map도 동일 패턴으로 변경(개선점 탭 섹션 찾아서 같은 구조 적용).

- [ ] **Step 3: 프론트 타입체크**

Run: `cd frontend && npm run typecheck`
Expected: 에러 0

- [ ] **Step 4: 브라우저 확인**

새 면접 1회 완주 → 종합 분석 탭에 기술 진단 / 하이라이트 / 페이즈 분석 카드 표시 확인. 강점/개선점 항목 옆 `(Q1, Q3)` 표시 확인. 구 세션은 신 섹션 미표시.

- [ ] **Step 5: 커밋**

```bash
git add "frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx"
git commit -m "feat(ui): 종합 탭 기술진단/하이라이트/페이즈 섹션 + questionRefs"
```

---

## 완료 조건

- [ ] 모든 신규 테스트 통과 (`test_evaluator_normalize.py`, `test_report_aggregator.py`)
- [ ] 기존 테스트(planner/fit_analyzer 등) 깨짐 없음
- [ ] dev에서 면접 1회 완주 시 DB의 `reportData`에 신 필드 전부 존재
- [ ] 프론트 종합 탭에 기술 진단 카드 표시, 질문별 탭에 키워드 배지 표시
- [ ] 기존 완료 세션 접근 시 에러 없이 신 섹션만 숨김 처리

## 알려진 미구현 / YAGNI 제외 (Spec 대비)

- 심화면접 전용 평가 프롬프트(`DEEP_TECHNICAL_EVALUATION_PROMPT`) 분기: 별도 이슈. 본 플랜은 `EVALUATOR_PROMPT` 단일 경로만 확장.
- 프로젝트별 평균 집계: brainstorm에서 옵션 3(풀)로 분류되어 제외됨.
- 마이그레이션: 기존 세션 소급 적용 안 함. 프론트 방어적 렌더로 대응.
