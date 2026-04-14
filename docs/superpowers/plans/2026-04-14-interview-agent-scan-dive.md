# 면접 에이전트 Scan + Dive 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 코치 면접 에이전트를 "Scan 3질문 → Dive 2주제 × 1~3질문 적응형" 2페이즈 구조로 재설계하여 JD 필터 편향 제거 및 이력서 전반 탐색 보장.

**Architecture:** 기존 `focus_topics[i % len]` 단일 루프를 두 페이즈(`scan` / `dive`)로 분리. 플래너는 순수 코드(LLM 호출 없음)로 `fit_analysis.skill_match`와 `evaluation.scores.depth`를 재활용해 플랜 확정. nodes는 페이즈별로 분기(`scan_ask`/`dive_ask`/`scan_next`/`decide_in_topic`). 기존 FIT의 focus_topics는 제거, SLIM 프롬프트는 `current_topic_plan`으로 재설계.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy (asyncpg), Prisma, pytest + pytest-asyncio, Next.js 15, pgvector

**관련 스펙:** `docs/superpowers/specs/2026-04-14-interview-agent-scan-dive-design.md`

---

## 파일 구조

### 신규
- `backend/app/agent/planner.py` — `build_scan_plan()`, `build_dive_plan()` (순수 코드, LLM 없음)
- `backend/tests/__init__.py`, `backend/tests/conftest.py`, `backend/tests/test_planner.py` — 테스트 인프라 + 플래너 단위 테스트
- `backend/migrations/2026-04-14-agent-session-scan-dive.sql` — DB 마이그레이션
- `frontend/prisma/schema.prisma` 수정 (신규 컬럼)

### 수정
- `backend/app/agent/state.py` — InterviewState에 phase/scan_plan/dive_plan/current_scan_idx/current_dive_idx/current_dive_depth 추가
- `backend/app/prompts/agent.py` — FIT_ANALYSIS_PROMPT 축소, INTERVIEWER_QUESTION_PROMPT_SLIM 수정, INTERVIEWER_DECIDE_IN_TOPIC_PROMPT 신규, focus_topics 제거
- `backend/app/agent/fit_analyzer.py` — FitAnalysis TypedDict에서 focus_topics 제거, run_fit_analysis 반환값 축소
- `backend/app/agent/interviewer_agent.py` — generate_question 시그니처 변경 (current_topic_plan), decide_next_action → decide_in_topic
- `backend/app/agent/nodes.py` — generate_question 분리(scan_ask/dive_ask), decide_next 분리(scan_next/decide_in_topic_node), agent_loop의 `decide` 액션 라우팅 변경, build_scan_plan_node/build_dive_plan_node 신규
- `backend/app/api/agent_interview.py` — SSE phase_label 이벤트 추가, 세션 영속화에 phase/scan_plan/dive_plan 저장
- `frontend/src/components/agent-interview/` — phase 배지 UI (진행 표시)
- `frontend/src/lib/agent-interview-api.ts` — SSE 이벤트 타입에 phase 추가

### 삭제 대상 코드
- `backend/app/agent/nodes.py:158-164` (focus_topics 순환)
- `backend/app/agent/nodes.py:287` `MAX_FOLLOW_UP_ROUND`
- `backend/app/prompts/agent.py`의 focus_topics 관련 블록들

---

## Task 순서

TDD 순서로 내부 → 외부 진행:
1. 테스트 인프라 + 타입 정의
2. 플래너 TDD (build_scan_plan)
3. 플래너 TDD (build_dive_plan)
4. FIT 축소 (focus_topics 제거)
5. 프롬프트 파일 수정
6. interviewer_agent 리라이트
7. nodes 재구조화
8. DB 마이그레이션 + Prisma schema
9. API + 세션 영속화
10. in_progress 세션 마감 스크립트
11. 프론트 SSE 처리
12. 통합 수동 검증

---

### Task 1: 테스트 인프라 + 상태 타입 확장

**Files:**
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_state_types.py`
- Modify: `backend/app/agent/state.py`

- [ ] **Step 1: 테스트 디렉터리 생성**

```bash
mkdir -p backend/tests
touch backend/tests/__init__.py
```

- [ ] **Step 2: conftest.py 작성**

`backend/tests/conftest.py`:
```python
"""Pytest configuration for backend tests."""
import pytest

pytest_plugins = ["pytest_asyncio"]
```

- [ ] **Step 3: 상태 타입 테스트 작성 (실패 테스트)**

`backend/tests/test_state_types.py`:
```python
"""Verify new InterviewState fields for Scan+Dive structure."""
from app.agent.state import InterviewState, ScanItem, DiveTopic


def test_scan_item_shape():
    item: ScanItem = {
        "project_ref": "크롤링",
        "query": "웹 크롤링 Selenium",
        "reason": "jd_match",
    }
    assert item["project_ref"] == "크롤링"
    assert item["reason"] in ("jd_match", "jd_unmatched", "project_order")


def test_dive_topic_shape():
    topic: DiveTopic = {
        "topic": "크롤링 안정성",
        "project_ref": "크롤링",
        "angle": "weakness",
        "scan_question_idx": 0,
        "query": "크롤링 실패 대응",
    }
    assert topic["angle"] in ("weakness", "strength")


def test_interview_state_has_phase_fields():
    state: InterviewState = {
        "phase": "scan",
        "scan_plan": [],
        "dive_plan": [],
        "current_scan_idx": 0,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
    }
    assert state["phase"] == "scan"
    assert state["current_dive_depth"] == 0
```

- [ ] **Step 4: 테스트 실행해 실패 확인**

Run: `cd backend && python -m pytest tests/test_state_types.py -v`
Expected: ImportError — `ScanItem`, `DiveTopic` not in state.py

- [ ] **Step 5: state.py에 타입 추가**

`backend/app/agent/state.py` 전체 교체:
```python
# backend/app/agent/state.py
from __future__ import annotations

from typing import Literal, TypedDict


class ScanItem(TypedDict):
    project_ref: str
    query: str
    reason: Literal["jd_match", "jd_unmatched", "project_order"]


class DiveTopic(TypedDict):
    topic: str
    project_ref: str
    angle: Literal["weakness", "strength"]
    scan_question_idx: int
    query: str


class InterviewState(TypedDict, total=False):
    # 세션 기본 정보
    session_id: str
    user_id: str

    # 입력 컨텍스트
    resume: dict
    job_posting: dict | None

    # 프로필 에이전트가 채움
    user_profile: dict

    # 면접 진행 상태
    current_question: str
    current_answer: str
    question_count: int
    max_questions: int

    # 평가 에이전트가 채움
    current_evaluation: dict

    # 면접관 에이전트가 채움
    next_action: str

    # 대화 히스토리
    conversation_history: list[dict]

    # 최종 결과
    overall_report: dict | None

    # 에이전트 루프
    profile_context: list[dict]
    loop_count: int
    actions_taken: list[str]

    # SSE 이벤트 큐
    pending_events: list[dict]

    # Fit Analysis (skill_match + avoid_topics만)
    fit_analysis: dict | None

    # 이력서 RAG
    resume_id: str | None
    has_resume_embeddings: bool
    current_resume_chunks: list[dict]

    # Scan + Dive 페이즈 (신규)
    phase: Literal["scan", "dive", "done"]
    scan_plan: list[ScanItem]
    dive_plan: list[DiveTopic]
    scan_evaluations: list[dict]     # 훑기 중 누적된 evaluation (dive_plan 생성 입력)
    current_scan_idx: int             # 0~(len(scan_plan)-1)
    current_dive_idx: int             # 0~(len(dive_plan)-1)
    current_dive_depth: int           # 현재 주제 내 질문수 1~3
```

주목: 기존 `follow_up_round` 필드 제거. state 사용처가 거부되면 Task 7에서 처리됨.

- [ ] **Step 6: 테스트 실행해 통과 확인**

Run: `cd backend && python -m pytest tests/test_state_types.py -v`
Expected: 3 passed

- [ ] **Step 7: 커밋**

```bash
git add backend/tests/__init__.py backend/tests/conftest.py backend/tests/test_state_types.py backend/app/agent/state.py
git commit -m "feat(agent): Scan+Dive 상태 타입 추가 (ScanItem/DiveTopic/phase)"
```

---

### Task 2: build_scan_plan 플래너 TDD

**Files:**
- Create: `backend/app/agent/planner.py`
- Create: `backend/tests/test_planner_scan.py`

- [ ] **Step 1: 테스트 작성 — JD 있음 케이스**

`backend/tests/test_planner_scan.py`:
```python
"""Tests for build_scan_plan."""
from app.agent.planner import build_scan_plan


def test_scan_plan_jd_matched_two_plus_unmatched_one():
    """JD 있고 projects 4개: 매칭 2 + 비매칭 1 총 3개."""
    resume = {
        "projects": [
            {"name": "크롤링", "techStack": ["Python", "Selenium"]},
            {"name": "AI투자", "techStack": ["LangGraph", "Redis"]},
            {"name": "로봇관제", "techStack": ["PyQt", "Vue"]},
            {"name": "QA자동화", "techStack": ["Python", "pytest"]},
        ]
    }
    fit_analysis = {
        "skill_match": {
            "matched": ["Python", "Selenium", "LangGraph", "Redis"],
            "gap": ["Kubernetes"],
            "coverage": 0.8,
        },
        "avoid_topics": [],
    }

    plan = build_scan_plan(resume, fit_analysis)

    assert len(plan) == 3
    assert plan[0]["reason"] == "jd_match"
    assert plan[1]["reason"] == "jd_match"
    assert plan[2]["reason"] == "jd_unmatched"
    # 매칭 상위 = 크롤링(2 matched), AI투자(2 matched)
    assert plan[0]["project_ref"] in ("크롤링", "AI투자")
    assert plan[1]["project_ref"] in ("크롤링", "AI투자")
    # 비매칭 = 로봇관제(0) or QA자동화(1 matched=Python). 최하위 점수
    assert plan[2]["project_ref"] == "로봇관제"


def test_scan_plan_no_jd_project_order():
    """JD 없음: projects[0..2] 순서."""
    resume = {
        "projects": [
            {"name": "P1", "techStack": ["X"]},
            {"name": "P2", "techStack": ["Y"]},
            {"name": "P3", "techStack": ["Z"]},
            {"name": "P4", "techStack": ["W"]},
        ]
    }
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)

    assert [p["project_ref"] for p in plan] == ["P1", "P2", "P3"]
    assert all(p["reason"] == "project_order" for p in plan)


def test_scan_plan_two_projects_only():
    """projects 2개만 있으면 scan 2개."""
    resume = {
        "projects": [
            {"name": "P1", "techStack": ["X"]},
            {"name": "P2", "techStack": ["Y"]},
        ]
    }
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert len(plan) == 2


def test_scan_plan_one_project_fills_with_experience():
    """projects 1개 + experience 1개 → 총 2 scan."""
    resume = {
        "projects": [{"name": "P1", "techStack": ["X"]}],
        "experience": [
            {"company": "A사", "position": "백엔드", "period": "2023-2024"},
        ],
    }
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert len(plan) == 2
    assert plan[0]["project_ref"] == "P1"
    assert "A사" in plan[1]["project_ref"]


def test_scan_plan_zero_projects_returns_empty():
    """projects도 experience도 없으면 빈 플랜."""
    resume = {}
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert plan == []


def test_scan_query_contains_techstack():
    """query에 project_ref + techStack 포함되어야 RAG가 해당 프로젝트 청크를 top-3로 가져옴."""
    resume = {"projects": [{"name": "크롤링", "techStack": ["Python", "Selenium"]}]}
    fit_analysis = {"skill_match": None, "avoid_topics": []}

    plan = build_scan_plan(resume, fit_analysis)
    assert "크롤링" in plan[0]["query"]
    assert "Selenium" in plan[0]["query"]
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `cd backend && python -m pytest tests/test_planner_scan.py -v`
Expected: ModuleNotFoundError — `app.agent.planner` 없음

- [ ] **Step 3: planner.py 구현**

`backend/app/agent/planner.py`:
```python
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
    scored_sorted = sorted(scored, key=lambda x: x[1], reverse=True)  # 점수 내림차순

    if max_scan >= 3 and len(scored_sorted) >= 3:
        top = scored_sorted[:2]       # 매칭 상위 2
        bottom = scored_sorted[-1]    # 최하위 1 (비매칭)
        plan: list[ScanItem] = []
        for p, _ in top:
            plan.append({
                "project_ref": p.get("name", "프로젝트"),
                "query": _project_query(p),
                "reason": "jd_match",
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
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `cd backend && python -m pytest tests/test_planner_scan.py -v`
Expected: 6 passed

- [ ] **Step 5: 커밋**

```bash
git add backend/app/agent/planner.py backend/tests/test_planner_scan.py
git commit -m "feat(agent): build_scan_plan — JD 매칭 기반 훑기 3항목 선정"
```

---

### Task 3: build_dive_plan 플래너 TDD

**Files:**
- Modify: `backend/app/agent/planner.py`
- Create: `backend/tests/test_planner_dive.py`

- [ ] **Step 1: 테스트 작성**

`backend/tests/test_planner_dive.py`:
```python
"""Tests for build_dive_plan."""
from app.agent.planner import build_dive_plan


def _scan(name: str, reason: str = "jd_match") -> dict:
    return {"project_ref": name, "query": f"{name} 쿼리", "reason": reason}


def _eval(depth: int, overall: int = 70) -> dict:
    return {"scores": {"depth": depth}, "overallScore": overall}


def test_dive_plan_jd_match_picks_best_worst():
    """JD 있음 + 매칭 프로젝트 안에서 최고/최저 depth 2개."""
    scan_plan = [
        _scan("크롤링", "jd_match"),
        _scan("AI투자", "jd_match"),
        _scan("로봇관제", "jd_unmatched"),
    ]
    scan_evals = [_eval(85), _eval(40), _eval(60)]  # 크롤링=강, AI투자=약, 로봇=비매칭
    fa = {"skill_match": {"matched": ["Python"], "gap": [], "coverage": 0.5}, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    assert len(plan) == 2
    angles = {t["angle"] for t in plan}
    assert angles == {"weakness", "strength"}
    weakness = next(t for t in plan if t["angle"] == "weakness")
    strength = next(t for t in plan if t["angle"] == "strength")
    assert weakness["project_ref"] == "AI투자"       # 매칭 중 최저 depth
    assert strength["project_ref"] == "크롤링"       # 매칭 중 최고 depth
    # 로봇관제는 jd_unmatched라 dive에서 제외됨


def test_dive_plan_no_jd_uses_all_scans():
    """JD 없음 → 전체 scan 중 최고/최저."""
    scan_plan = [
        _scan("P1", "project_order"),
        _scan("P2", "project_order"),
        _scan("P3", "project_order"),
    ]
    scan_evals = [_eval(30), _eval(80), _eval(55)]
    fa = {"skill_match": None, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    assert len(plan) == 2
    weakness = next(t for t in plan if t["angle"] == "weakness")
    strength = next(t for t in plan if t["angle"] == "strength")
    assert weakness["project_ref"] == "P1"  # depth=30
    assert strength["project_ref"] == "P2"  # depth=80


def test_dive_plan_same_project_different_angles():
    """매칭 프로젝트가 1개뿐 → 같은 프로젝트를 두 각도로."""
    scan_plan = [
        _scan("크롤링", "jd_match"),
        _scan("로봇관제", "jd_unmatched"),
        _scan("QA", "jd_unmatched"),
    ]
    scan_evals = [_eval(60), _eval(70), _eval(50)]
    fa = {"skill_match": {"matched": ["X"], "gap": [], "coverage": 0.1}, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    assert len(plan) == 2
    assert all(t["project_ref"] == "크롤링" for t in plan)
    assert plan[0]["angle"] != plan[1]["angle"]
    # weakness / strength 모두 존재
    assert {t["angle"] for t in plan} == {"weakness", "strength"}


def test_dive_plan_query_matches_scan_plan():
    """dive query는 scan_plan의 query를 재사용해야 RAG가 같은 프로젝트 청크 가져옴."""
    scan_plan = [
        _scan("크롤링", "project_order"),
        _scan("AI투자", "project_order"),
    ]
    scan_evals = [_eval(40), _eval(80)]
    fa = {"skill_match": None, "avoid_topics": []}

    plan = build_dive_plan(scan_plan, scan_evals, fa)

    weakness = next(t for t in plan if t["angle"] == "weakness")
    assert weakness["query"] == "크롤링 쿼리"


def test_dive_plan_empty_when_no_scans():
    """scan_plan이 비어있으면 dive도 빈 배열."""
    plan = build_dive_plan([], [], {"skill_match": None, "avoid_topics": []})
    assert plan == []


def test_dive_plan_single_scan_returns_one_topic():
    """scan 1개면 dive도 1주제 (같은 프로젝트 2각도 불가 — scan 1개는 projects=1 케이스)."""
    scan_plan = [_scan("P1", "project_order")]
    scan_evals = [_eval(50)]
    plan = build_dive_plan(scan_plan, scan_evals, {"skill_match": None, "avoid_topics": []})

    # 1개 주제만 (strength/weakness 어느 쪽이든)
    assert len(plan) >= 1
    assert plan[0]["project_ref"] == "P1"
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && python -m pytest tests/test_planner_dive.py -v`
Expected: ImportError — `build_dive_plan` not defined

- [ ] **Step 3: planner.py에 build_dive_plan 추가**

`backend/app/agent/planner.py` 하단에 추가:
```python
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
        # jd_match가 비어있으면 fallback: 전체 허용
        if not candidate_idx:
            candidate_idx = list(range(len(scan_plan)))
    else:
        candidate_idx = list(range(len(scan_plan)))

    # 각 후보의 depth 점수
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

    # scan 1개뿐 → 1주제
    if len(scored) == 1:
        i = scored[0][0]
        s = scan_plan[i]
        return [{
            "topic": _topic_label(s["project_ref"], "strength"),
            "project_ref": s["project_ref"],
            "angle": "strength",
            "scan_question_idx": i,
            "query": s["query"],
        }]

    # 최저(weakness), 최고(strength)
    weakness_i, _ = min(scored, key=lambda x: x[1])
    strength_i, _ = max(scored, key=lambda x: x[1])

    # 같은 인덱스면 (후보가 1개거나 전부 동점) 같은 프로젝트 2각도
    if weakness_i == strength_i:
        # 같은 프로젝트 — 다른 후보 중 최고를 고르거나, 없으면 같은 프로젝트 2각도
        others = [s for s in scored if s[0] != weakness_i]
        if others:
            strength_i = max(others, key=lambda x: x[1])[0]

    if weakness_i == strength_i:
        # 진짜로 후보 1개뿐 — 같은 프로젝트 2각도
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
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `cd backend && python -m pytest tests/test_planner_dive.py -v`
Expected: 6 passed

- [ ] **Step 5: 커밋**

```bash
git add backend/app/agent/planner.py backend/tests/test_planner_dive.py
git commit -m "feat(agent): build_dive_plan — 약점 1 + 강점 1 딥다이브 주제 선정"
```

---

### Task 4: fit_analyzer 축소 (focus_topics 제거)

**Files:**
- Modify: `backend/app/agent/fit_analyzer.py`
- Modify: `backend/app/prompts/agent.py`
- Create: `backend/tests/test_fit_analyzer.py`

- [ ] **Step 1: 테스트 작성**

`backend/tests/test_fit_analyzer.py`:
```python
"""run_fit_analysis는 skill_match + avoid_topics만 반환 (focus_topics 제거)."""
import pytest
from app.agent.fit_analyzer import run_fit_analysis


@pytest.mark.asyncio
async def test_no_focus_topics_in_result():
    resume = {"skills": ["Python"]}
    jd = {"requiredSkills": ["Python"], "position": "Backend"}

    # LLM이 실패해도 skill_match는 반환되고 focus_topics 키는 아예 없어야 함
    result = await run_fit_analysis(resume, jd)
    assert "focus_topics" not in result
    assert "skill_match" in result
    assert "avoid_topics" in result


@pytest.mark.asyncio
async def test_no_jd_returns_none_skill_match():
    resume = {"skills": ["Python"]}
    result = await run_fit_analysis(resume, None)
    assert result["skill_match"] is None
    assert "focus_topics" not in result
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && python -m pytest tests/test_fit_analyzer.py -v`
Expected: 실패 — 현재 FitAnalysis에 focus_topics 포함됨

- [ ] **Step 3: FIT_ANALYSIS_PROMPT 축소**

`backend/app/prompts/agent.py` 내 `FIT_ANALYSIS_PROMPT` 블록(244~272줄) 전체 교체:
```python
FIT_ANALYSIS_PROMPT = """당신은 면접 설계 전문가입니다. 지원자 이력서와 채용공고를 비교하여 면접에서 피해야 할 주제(avoid_topics)만 선정하세요.

<resume>
{resume_brief}
</resume>

<job_posting>
{jd_brief}
</job_posting>

<skill_match>
matched(이력서·JD 둘 다 있음): {matched}
gap(JD 요구이나 이력서 미언급): {gap}
</skill_match>

다음 JSON 형식으로 반환하세요:
{{
  "avoid_topics": ["피할 주제 1"]
}}

규칙:
- avoid_topics는 0~3개. 이력서 수준 대비 너무 낮거나 본질에서 벗어난 주제
- focus_topics는 이 분석에서 결정하지 않음 (별도 플래너에서 처리)
"""
```

- [ ] **Step 4: fit_analyzer.py 축소**

`backend/app/agent/fit_analyzer.py` 내 `FocusTopic`, `FitAnalysis`, `run_fit_analysis` 수정:

- `FocusTopic` TypedDict 삭제
- `FitAnalysis`에서 `focus_topics` 필드 삭제:
```python
class FitAnalysis(TypedDict):
    skill_match: SkillMatch | None
    avoid_topics: list[str]
```

- `run_fit_analysis` 함수 내 `focus_topics` 파싱 블록 전체 삭제. 반환값에서도 제거:
```python
async def run_fit_analysis(resume: dict | None, jd: dict | None) -> FitAnalysis:
    resume_skills = (resume or {}).get("skills") or []
    jd_skills = _extract_jd_skills(jd)
    skill_match = compute_skill_match(resume_skills, jd_skills)

    prompt = FIT_ANALYSIS_PROMPT.format(
        resume_brief=_summarize_resume(resume),
        jd_brief=_summarize_jd(jd),
        matched=", ".join(skill_match["matched"]) if skill_match else "(JD 없음)",
        gap=", ".join(skill_match["gap"]) if skill_match else "(JD 없음)",
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
```

- [ ] **Step 5: 테스트 실행해 통과 확인**

Run: `cd backend && python -m pytest tests/test_fit_analyzer.py -v`
Expected: 2 passed (LLM 호출은 실제 OpenAI 사용하므로 API 키 필요. 실패 시 네트워크 없는 환경 고려해 try/except로 mock 가능하지만 일단 키 있는 상태 기준)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/agent/fit_analyzer.py backend/app/prompts/agent.py backend/tests/test_fit_analyzer.py
git commit -m "refactor(fit): focus_topics 제거 — skill_match + avoid_topics만 반환"
```

---

### Task 5: 프롬프트 전면 교체 (SLIM 수정, DECIDE_IN_TOPIC 신규)

**Files:**
- Modify: `backend/app/prompts/agent.py`

- [ ] **Step 1: INTERVIEWER_QUESTION_PROMPT_SLIM 교체**

`backend/app/prompts/agent.py` 65~106줄 `INTERVIEWER_QUESTION_PROMPT_SLIM` 전체 교체:

```python
INTERVIEWER_QUESTION_PROMPT_SLIM = """당신은 숙련된 기술 면접관입니다. 다음 정보를 바탕으로 다음 질문 1개를 생성하세요.

<지원자 요약>
{summary}
</지원자 요약>

<보유 기술>
{skills}
</보유 기술>

<관련 이력서 발췌 (RAG 검색 결과)>
{resume_chunks}
</관련 이력서 발췌>

<채용공고>
{job_posting}
</채용공고>

<현재 주제 플랜>
{current_topic_plan}
</현재 주제 플랜>

<누적 프로필 인사이트>
강점: {strengths}
약점: {weaknesses}
패턴: {patterns}
</누적 프로필 인사이트>

<현재까지 대화>
{conversation_history}
</현재까지 대화>

지시사항:
- "현재 주제 플랜" 블록을 엄격히 따르세요. 플랜이 지정한 프로젝트/각도에서 벗어나지 마세요.
- 질문은 반드시 "관련 이력서 발췌"의 구체 사실(프로젝트명, 기술, 역할)을 인용해 만드세요. 일반적 CS 지식 질문 금지.
- avoid_topics는 피하세요: {avoid_topics}
- 한 문장 또는 두 문장. 하나의 초점만.
- 다음 JSON 형식으로만 반환:
{{
  "question": "면접 질문 본문",
  "targetArea": "다루는 영역 (예: 크롤링 안정성, 데이터 파이프라인)",
  "difficulty": "easy|medium|hard"
}}
"""
```

**변수 정리:**
- 제거: `{current_focus_topic}`, `{fit_analysis}`
- 추가: `{current_topic_plan}`
- 유지: `{summary}`, `{skills}`, `{resume_chunks}`, `{job_posting}`, `{avoid_topics}`, `{strengths}`, `{weaknesses}`, `{patterns}`, `{conversation_history}`

- [ ] **Step 2: INTERVIEWER_DECIDE_PROMPT 교체 → DECIDE_IN_TOPIC**

`backend/app/prompts/agent.py` 108~134줄 `INTERVIEWER_DECIDE_PROMPT` 전체 삭제 후 다음으로 교체:

```python
INTERVIEWER_DECIDE_IN_TOPIC_PROMPT = """딥다이브 주제 진행 판정.

<주제>
프로젝트: {project_ref}
각도: {angle}  (weakness 또는 strength)
주제 내 질문수: {current_depth} / 최대 3
</주제>

<최근 평가>
{last_evaluation}
</최근 평가>

<남은 주제 수>
{remaining_topics}  (현재 포함)
</남은 주제 수>

규칙 (위에서부터 순차):
1. current_depth >= 3 → "next_topic" (같은 주제에서 3질문 초과 금지)
2. remaining_topics <= 1 AND current_depth >= 2 AND depth점수 >= 70 → "end" (마지막 주제, 충분히 팠음)
3. depth점수 < 70 → "dig_deeper" (주제 안에서 더 파기)
4. 그 외 → "next_topic"

반드시 다음 JSON만 반환:
{{
  "action": "dig_deeper" | "next_topic" | "end",
  "reason": "이 결정의 이유"
}}"""
```

- [ ] **Step 3: INTERVIEWER_FOLLOWUP_PROMPT는 유지**

`INTERVIEWER_FOLLOWUP_PROMPT`는 현재 구조(꼬리질문 1회)는 사라지지만 **딥다이브의 dig_deeper 질문 생성**에 재활용. 파일에서 삭제하지 말 것. 지시사항 1줄만 추가:

파일 136줄 시작 블록에 맨 앞에 주석 한 줄 추가:
```python
# 딥다이브 dig_deeper 시 사용. conversation_history의 직전 답변을 더 파고드는 꼬리질문 생성.
INTERVIEWER_FOLLOWUP_PROMPT = """지원자 컨텍스트:
...(기존 내용 그대로 유지)...
"""
```

- [ ] **Step 4: 변경 확인 (syntax check)**

Run: `cd backend && python -c "from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM, INTERVIEWER_DECIDE_IN_TOPIC_PROMPT, INTERVIEWER_FOLLOWUP_PROMPT, FIT_ANALYSIS_PROMPT; print('OK')"`
Expected: `OK`

Run: `cd backend && python -c "from app.prompts.agent import INTERVIEWER_DECIDE_PROMPT" 2>&1`
Expected: ImportError (삭제됨)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/prompts/agent.py
git commit -m "refactor(prompt): SLIM에 current_topic_plan 도입 + DECIDE_IN_TOPIC 신설"
```

---

### Task 6: interviewer_agent 리라이트

**Files:**
- Modify: `backend/app/agent/interviewer_agent.py`

- [ ] **Step 1: interviewer_agent.py 전체 교체**

`backend/app/agent/interviewer_agent.py`:
```python
# backend/app/agent/interviewer_agent.py
from __future__ import annotations

import json
import logging

from app.agent.state import DiveTopic, ScanItem
from app.config import settings
from app.lib.llm_client import call_llm_json
from app.prompts.agent import (
    INTERVIEWER_DECIDE_IN_TOPIC_PROMPT,
    INTERVIEWER_FOLLOWUP_PROMPT,
)

logger = logging.getLogger(__name__)


def _format_profile(profile: dict) -> dict[str, str]:
    return {
        "strengths": "\n".join(profile.get("strengths", [])) or "데이터 없음",
        "weaknesses": "\n".join(profile.get("weaknesses", [])) or "데이터 없음",
        "patterns": "\n".join(profile.get("patterns", [])) or "데이터 없음",
        "context": "\n".join(profile.get("context", [])) or "데이터 없음",
    }


def _format_history(history: list[dict]) -> str:
    if not history:
        return "첫 질문입니다."
    parts = []
    for entry in history:
        parts.append(f"[질문 {entry.get('question_number', '?')}] {entry.get('question', '')}")
        if entry.get("answer"):
            parts.append(f"[답변] {entry['answer']}")
        if entry.get("evaluation"):
            ev = entry["evaluation"]
            parts.append(f"[평가] 점수: {ev.get('overallScore', '?')}, 피드백: {ev.get('briefFeedback', '')}")
    return "\n".join(parts)


def _format_scan_plan(scan_item: ScanItem, scan_idx: int, total_scans: int) -> str:
    return (
        f"페이즈: SCAN ({scan_idx + 1}/{total_scans})\n"
        f"프로젝트: {scan_item['project_ref']}\n"
        f"선정 이유: {scan_item['reason']}\n"
        f"지시: 이 프로젝트에 대한 '핵심 기여 또는 기술 선택 이유' 성격의 열린 질문 1개. "
        f"딥다이브 전이므로 지원자 답변의 폭을 확인하는 단계."
    )


def _format_dive_plan(dive_topic: DiveTopic, depth: int) -> str:
    angle_hint = {
        "weakness": "직전 훑기 답변이 얕았거나 약점이 드러난 주제. what → why → 트레이드오프/실패 사다리로 파세요.",
        "strength": "직전 훑기 답변이 탄탄한 주제. 핵심 의사결정, 대안 비교, 심층 트레이드오프로 파세요.",
    }.get(dive_topic["angle"], "")
    return (
        f"페이즈: DIVE\n"
        f"주제: {dive_topic['topic']}\n"
        f"프로젝트: {dive_topic['project_ref']}\n"
        f"각도: {dive_topic['angle']}\n"
        f"주제 내 질문: {depth + 1} / 3\n"
        f"지시: {angle_hint} 새 주제 도입 금지. 같은 프로젝트 안에서만 파세요."
    )


async def generate_scan_question(
    resume: dict,
    job_posting: dict | None,
    user_profile: dict,
    conversation_history: list[dict],
    scan_item: ScanItem,
    scan_idx: int,
    total_scans: int,
    resume_chunks: list[dict],
    avoid_topics: list[str],
) -> dict:
    """훑기 페이즈 질문 생성."""
    from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM

    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)
    job_str = json.dumps(job_posting, ensure_ascii=False, indent=2) if job_posting else "채용공고 없음"
    chunks_str = "\n\n".join(c.get("content", "") for c in resume_chunks) or "(청크 없음)"
    plan_str = _format_scan_plan(scan_item, scan_idx, total_scans)
    avoid_str = ", ".join(avoid_topics) or "(없음)"

    prompt = INTERVIEWER_QUESTION_PROMPT_SLIM.format(
        summary=resume.get("summary", "") if isinstance(resume, dict) else "",
        skills=", ".join(str(s) for s in (resume.get("skills") or [])) if isinstance(resume, dict) else "",
        resume_chunks=chunks_str,
        job_posting=job_str,
        current_topic_plan=plan_str,
        strengths=profile_str["strengths"],
        weaknesses=profile_str["weaknesses"],
        patterns=profile_str["patterns"],
        conversation_history=history_str,
        avoid_topics=avoid_str,
    )

    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def generate_dive_question(
    resume: dict,
    job_posting: dict | None,
    user_profile: dict,
    conversation_history: list[dict],
    dive_topic: DiveTopic,
    current_depth: int,
    resume_chunks: list[dict],
    avoid_topics: list[str],
) -> dict:
    """딥다이브 페이즈 질문 생성 (depth=0일 때는 주제 시작 질문, >=1일 때는 파고드는 질문)."""
    from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM

    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)
    job_str = json.dumps(job_posting, ensure_ascii=False, indent=2) if job_posting else "채용공고 없음"
    chunks_str = "\n\n".join(c.get("content", "") for c in resume_chunks) or "(청크 없음)"
    plan_str = _format_dive_plan(dive_topic, current_depth)
    avoid_str = ", ".join(avoid_topics) or "(없음)"

    prompt = INTERVIEWER_QUESTION_PROMPT_SLIM.format(
        summary=resume.get("summary", "") if isinstance(resume, dict) else "",
        skills=", ".join(str(s) for s in (resume.get("skills") or [])) if isinstance(resume, dict) else "",
        resume_chunks=chunks_str,
        job_posting=job_str,
        current_topic_plan=plan_str,
        strengths=profile_str["strengths"],
        weaknesses=profile_str["weaknesses"],
        patterns=profile_str["patterns"],
        conversation_history=history_str,
        avoid_topics=avoid_str,
    )

    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def decide_in_topic(
    project_ref: str,
    angle: str,
    current_depth: int,
    last_evaluation: dict,
    remaining_topics: int,
) -> dict:
    """현재 주제를 더 팔지, 다음 주제로 갈지, 끝낼지 결정."""
    prompt = INTERVIEWER_DECIDE_IN_TOPIC_PROMPT.format(
        project_ref=project_ref,
        angle=angle,
        current_depth=current_depth,
        last_evaluation=json.dumps(last_evaluation, ensure_ascii=False),
        remaining_topics=remaining_topics,
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)


async def generate_dig_deeper(
    conversation_history: list[dict],
    last_evaluation: dict,
) -> dict:
    """주제 안에서 파고드는 꼬리질문. INTERVIEWER_FOLLOWUP_PROMPT 재활용."""
    prompt = INTERVIEWER_FOLLOWUP_PROMPT.format(
        conversation_history=_format_history(conversation_history),
        last_evaluation=json.dumps(last_evaluation, ensure_ascii=False),
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)
```

**제거된 함수:** `generate_question` (scan/dive로 분리), `generate_followup` (dig_deeper로 이름 변경), `decide_next_action` (decide_in_topic으로 대체)

- [ ] **Step 2: import 체크**

Run: `cd backend && python -c "from app.agent import interviewer_agent; print(dir(interviewer_agent))" | tr ',' '\n' | grep -E "generate_scan|generate_dive|decide_in_topic|generate_dig_deeper"`
Expected: 4줄 출력

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/interviewer_agent.py
git commit -m "refactor(interviewer): scan/dive 질문 분리 + decide_in_topic"
```

---

### Task 7: nodes.py 재구조화

**Files:**
- Modify: `backend/app/agent/nodes.py`

이 태스크는 큰 변경이라 3단계로 쪼갭니다.

- [ ] **Step 1: nodes.py 상단 import + build_scan_plan_node + build_dive_plan_node 추가**

`backend/app/agent/nodes.py` 상단 import 영역:
```python
# backend/app/agent/nodes.py
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.state import InterviewState
from app.agent import profile_agent, interviewer_agent, evaluator_agent, interview_planner, resume_rag, fit_analyzer
from app.agent import planner  # 신규

logger = logging.getLogger(__name__)

MAX_ACTIONS = 3
MAX_DIVE_DEPTH = 3
```

`MAX_FOLLOW_UP_ROUND = 1` 상수 삭제 (287줄).

노드 추가 (파일 적당한 위치에):
```python
async def build_scan_plan_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """훑기 플랜 확정. fit_analysis_node 직후 호출."""
    scan_plan = planner.build_scan_plan(state["resume"], state.get("fit_analysis") or {})
    events = list(state.get("pending_events", []))
    events.append({
        "event": "status",
        "data": {
            "phase": "scan_plan_ready",
            "scan_count": len(scan_plan),
            "max_questions": len(scan_plan) + 6,  # scan + dive 2주제*3질문
        },
    })
    return {
        **state,
        "phase": "scan",
        "scan_plan": scan_plan,
        "scan_evaluations": [],
        "current_scan_idx": 0,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
        "pending_events": events,
    }


async def build_dive_plan_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """딥다이브 플랜 확정. 훑기 3답변 끝난 직후 호출."""
    dive_plan = planner.build_dive_plan(
        state.get("scan_plan", []),
        state.get("scan_evaluations", []),
        state.get("fit_analysis") or {},
    )
    events = list(state.get("pending_events", []))
    events.append({
        "event": "status",
        "data": {
            "phase": "dive_plan_ready",
            "dive_topics": [
                {"topic": t["topic"], "angle": t["angle"], "project_ref": t["project_ref"]}
                for t in dive_plan
            ],
        },
    })
    return {
        **state,
        "phase": "dive",
        "dive_plan": dive_plan,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
        "pending_events": events,
    }
```

- [ ] **Step 2: generate_question을 scan_ask + dive_ask로 분리**

기존 `generate_question` (151~210줄) 삭제하고 다음 두 함수로 교체:

```python
async def scan_ask(state: InterviewState, db: AsyncSession) -> InterviewState:
    """훑기 페이즈 질문 생성."""
    events = list(state.get("pending_events", []))
    scan_plan = state.get("scan_plan", [])
    idx = state.get("current_scan_idx", 0)

    if idx >= len(scan_plan):
        # 훑기 소진 → dive_plan으로 전환해야 함 (호출자가 build_dive_plan_node 호출)
        logger.warning("scan_ask called with exhausted scan_plan")
        return state

    scan_item = scan_plan[idx]
    events.append({"event": "status", "data": {"phase": "generating_question", "phaseKind": "scan"}})

    # RAG 검색
    chunks: list[dict] = []
    has_emb = state.get("has_resume_embeddings", False)
    rid = state.get("resume_id")
    if has_emb and rid:
        try:
            chunks = await resume_rag.search_resume(db, state["user_id"], rid, scan_item["query"], top_k=3)
        except Exception:
            logger.exception("search_resume failed in scan_ask")
            chunks = []

    avoid_topics = (state.get("fit_analysis") or {}).get("avoid_topics") or []

    result = await interviewer_agent.generate_scan_question(
        resume=state["resume"],
        job_posting=state.get("job_posting"),
        user_profile=state.get("user_profile", {}),
        conversation_history=state.get("conversation_history", []),
        scan_item=scan_item,
        scan_idx=idx,
        total_scans=len(scan_plan),
        resume_chunks=chunks,
        avoid_topics=avoid_topics,
    )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "phase": "scan",
            "phaseLabel": f"훑기 {idx + 1}/{len(scan_plan)} · {scan_item['project_ref']}",
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    })

    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
        "pending_events": events,
    }


async def dive_ask(state: InterviewState, db: AsyncSession) -> InterviewState:
    """딥다이브 페이즈 질문 생성. current_dive_depth가 0이면 주제 시작, >=1이면 파고들기."""
    events = list(state.get("pending_events", []))
    dive_plan = state.get("dive_plan", [])
    idx = state.get("current_dive_idx", 0)
    depth = state.get("current_dive_depth", 0)

    if idx >= len(dive_plan):
        logger.warning("dive_ask called with exhausted dive_plan")
        return state

    topic = dive_plan[idx]
    events.append({"event": "status", "data": {"phase": "generating_question", "phaseKind": "dive"}})

    # RAG (주제의 query 사용)
    chunks: list[dict] = []
    has_emb = state.get("has_resume_embeddings", False)
    rid = state.get("resume_id")
    if has_emb and rid:
        try:
            chunks = await resume_rag.search_resume(db, state["user_id"], rid, topic["query"], top_k=3)
        except Exception:
            logger.exception("search_resume failed in dive_ask")
            chunks = []

    avoid_topics = (state.get("fit_analysis") or {}).get("avoid_topics") or []

    # depth==0이면 주제 시작 질문, depth>=1이면 dig_deeper (꼬리질문 스타일)
    if depth == 0:
        result = await interviewer_agent.generate_dive_question(
            resume=state["resume"],
            job_posting=state.get("job_posting"),
            user_profile=state.get("user_profile", {}),
            conversation_history=state.get("conversation_history", []),
            dive_topic=topic,
            current_depth=depth,
            resume_chunks=chunks,
            avoid_topics=avoid_topics,
        )
    else:
        # 같은 주제 안에서 파고들기 — 직전 평가 기반 꼬리질문
        result = await interviewer_agent.generate_dig_deeper(
            state.get("conversation_history", []),
            state.get("current_evaluation", {}),
        )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1
    new_depth = depth + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "phase": "dive",
            "phaseLabel": f"딥다이브 · {topic['topic']} ({new_depth}/{MAX_DIVE_DEPTH})",
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    })

    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
        "current_dive_depth": new_depth,
        "pending_events": events,
    }
```

- [ ] **Step 3: decide_next → scan_next + decide_in_topic_node 분리**

기존 `decide_next` (290~323줄) + `generate_followup` (213~240줄) 전체 삭제 후 교체:

```python
async def scan_next(state: InterviewState, db: AsyncSession) -> InterviewState:
    """훑기 페이즈에서 답변 평가 후: 다음 scan 질문 or dive로 전환."""
    # evaluate_answer가 conversation_history에 답변 추가했고, current_evaluation에 결과 저장함.
    # 그 evaluation을 scan_evaluations에 누적.
    scan_evals = list(state.get("scan_evaluations", []))
    scan_evals.append(state.get("current_evaluation") or {})

    scan_plan = state.get("scan_plan", [])
    new_scan_idx = state.get("current_scan_idx", 0) + 1

    if new_scan_idx >= len(scan_plan):
        # 훑기 완료 — build_dive_plan_node로 전환 신호
        return {
            **state,
            "scan_evaluations": scan_evals,
            "current_scan_idx": new_scan_idx,
            "next_action": "build_dive_plan",
        }
    else:
        # 다음 훑기 질문
        return {
            **state,
            "scan_evaluations": scan_evals,
            "current_scan_idx": new_scan_idx,
            "next_action": "scan_ask",
        }


async def decide_in_topic_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """딥다이브 중 결정: dig_deeper / next_topic / end."""
    dive_plan = state.get("dive_plan", [])
    dive_idx = state.get("current_dive_idx", 0)
    depth = state.get("current_dive_depth", 0)

    if dive_idx >= len(dive_plan):
        return {**state, "next_action": "end"}

    topic = dive_plan[dive_idx]
    remaining = len(dive_plan) - dive_idx

    # LLM 결정
    result = await interviewer_agent.decide_in_topic(
        project_ref=topic["project_ref"],
        angle=topic["angle"],
        current_depth=depth,
        last_evaluation=state.get("current_evaluation") or {},
        remaining_topics=remaining,
    )
    action = result.get("action", "next_topic")

    # 한계치 강제
    if depth >= MAX_DIVE_DEPTH:
        action = "next_topic"
    if action == "dig_deeper" and depth >= MAX_DIVE_DEPTH:
        action = "next_topic"
    if action == "next_topic" and dive_idx + 1 >= len(dive_plan):
        action = "end"
    if action == "end" and dive_idx + 1 < len(dive_plan):
        # 마지막 주제가 아닌데 end면 next_topic으로 강제
        action = "next_topic"

    # 상태 업데이트
    if action == "next_topic":
        return {
            **state,
            "next_action": "dive_ask",
            "current_dive_idx": dive_idx + 1,
            "current_dive_depth": 0,
        }
    elif action == "dig_deeper":
        return {**state, "next_action": "dive_ask"}  # depth는 dive_ask 안에서 +1
    else:  # end
        return {**state, "next_action": "end", "phase": "done"}
```

- [ ] **Step 4: agent_loop 흐름 수정**

`agent_loop` 함수의 `decide` 분기(47~56줄)를 페이즈 기반으로 교체:

```python
async def agent_loop(state: InterviewState, db: AsyncSession) -> InterviewState:
    """답변 처리 루프: 평가 → 페이즈별 결정 → 다음 질문 생성 또는 종료."""
    state = {
        **state,
        "loop_count": 0,
        "actions_taken": list(state.get("actions_taken", [])),
        "profile_context": list(state.get("profile_context", [])),
    }

    # 단순화된 흐름 (기존 plan_next_action 기반 루프 축소)
    # 1) 평가
    if not state.get("current_evaluation"):
        state = await evaluate_answer(state, db)

    # 2) 페이즈별 결정
    phase = state.get("phase", "scan")
    if phase == "scan":
        state = await scan_next(state, db)
    elif phase == "dive":
        state = await decide_in_topic_node(state, db)
    else:
        state = {**state, "next_action": "end"}

    # 3) 다음 액션 실행
    next_action = state.get("next_action", "end")
    if next_action == "scan_ask":
        state = await scan_ask(state, db)
    elif next_action == "build_dive_plan":
        state = await build_dive_plan_node(state, db)
        state = await dive_ask(state, db)
    elif next_action == "dive_ask":
        state = await dive_ask(state, db)
    elif next_action == "end":
        state = await update_profile(state, db)
        state = await generate_report(state, db)

    return state
```

**주의:** 기존 `search_profile` 루프(plan_next_action 기반)는 이번 재설계에서 축소됨. 필요 시 별도 태스크에서 재도입 가능하나 지금 스펙 상으론 제외.

- [ ] **Step 5: 기존 generate_question / generate_followup / decide_next 참조 체크**

Run: `cd backend && grep -n "generate_question\|generate_followup\|decide_next\b" app/agent/nodes.py app/api/agent_interview.py 2>&1`
Expected: 모든 참조 제거됨 (있으면 해당 파일 수정 필요)

- [ ] **Step 6: 모듈 import 검증**

Run: `cd backend && python -c "from app.agent.nodes import scan_ask, dive_ask, scan_next, decide_in_topic_node, build_scan_plan_node, build_dive_plan_node, agent_loop; print('OK')"`
Expected: `OK`

- [ ] **Step 7: 단위 테스트 기존 플래너 유지 확인**

Run: `cd backend && python -m pytest tests/ -v`
Expected: 모든 테스트 (state_types + planner_scan + planner_dive + fit_analyzer) 통과

- [ ] **Step 8: 커밋**

```bash
git add backend/app/agent/nodes.py
git commit -m "refactor(agent): nodes를 scan/dive 2페이즈 흐름으로 재구조화"
```

---

### Task 8: API + 세션 영속화

**Files:**
- Modify: `backend/app/api/agent_interview.py`
- Modify: `frontend/prisma/schema.prisma`
- Create: `backend/migrations/2026-04-14-agent-session-scan-dive.sql`

- [ ] **Step 1: 현재 agent_interview.py 구조 확인**

Run: `cd backend && grep -n "agent_loop\|fit_analysis_node\|load_profile\|generate_question" app/api/agent_interview.py | head -20`

세션 시작 시점의 노드 호출 순서를 파악해야 함. 다음 단계에서 fit_analysis_node 직후에 build_scan_plan_node를 추가하고 첫 scan_ask 호출.

- [ ] **Step 2: 세션 시작 핸들러 수정**

`backend/app/api/agent_interview.py`에서 `/start` 엔드포인트의 초기 노드 호출 순서를:

기존:
```
load_profile → fit_analysis_node → generate_question → (SSE 스트림)
```

변경:
```
load_profile → fit_analysis_node → build_scan_plan_node → scan_ask → (SSE 스트림)
```

구체 변경 위치는 현재 파일을 읽고 확정. 일반적 패턴:
```python
from app.agent.nodes import (
    load_profile,
    fit_analysis_node,
    build_scan_plan_node,
    scan_ask,
    agent_loop,
)

# /start 내부
state = await load_profile(state, db)
state = await fit_analysis_node(state, db)
state = await build_scan_plan_node(state, db)
state = await scan_ask(state, db)
```

- [ ] **Step 3: /answer 핸들러 수정**

기존에는 `agent_loop`가 `plan_next_action` 기반 복잡한 루프였음. 새 `agent_loop`는 단순화된 2페이즈 흐름.

`/answer` 핸들러에서 `current_answer` 세팅 후 `agent_loop` 호출하면 Task 7 Step 4의 새 흐름이 작동.

**단, state에 `phase`/`scan_plan`/`dive_plan`/`current_scan_idx`/`current_dive_idx`/`current_dive_depth`/`scan_evaluations`가 누적되어야 함.** 세션이 요청 간 유지되는 구조를 확인 — DB 저장 기반이면 JSONB 컬럼 추가 필요 (Step 5).

- [ ] **Step 4: SSE 이벤트에 maxQuestions 전달**

`build_scan_plan_node`가 emit한 `{"phase": "scan_plan_ready", "max_questions": N}` 이벤트를 프론트가 받아 진행 바 계산. 프론트 핸들러는 Task 11에서 처리.

- [ ] **Step 5: Prisma schema 컬럼 추가**

`frontend/prisma/schema.prisma`의 `AgentInterviewSession` 모델에 3개 필드 추가:

```prisma
model AgentInterviewSession {
  // 기존 필드들 ...
  phase        String?   // "scan" | "dive" | "done"
  scanPlan     Json?     @map("scan_plan")
  divePlan     Json?     @map("dive_plan")
  // ... rest
}
```

- [ ] **Step 6: SQL 마이그레이션 작성**

`backend/migrations/2026-04-14-agent-session-scan-dive.sql`:
```sql
-- Scan+Dive 2페이즈 구조를 위한 세션 테이블 확장
ALTER TABLE agent_interview_sessions
  ADD COLUMN IF NOT EXISTS phase TEXT,
  ADD COLUMN IF NOT EXISTS scan_plan JSONB,
  ADD COLUMN IF NOT EXISTS dive_plan JSONB;

-- 기존 focus_topics 필드는 fit_analysis JSONB 안에 있으므로 별도 마이그레이션 불필요.
-- fit_analysis에서 focus_topics 키가 있어도 코드가 무시하므로 기존 데이터는 그대로 둠.
```

- [ ] **Step 7: Prisma migrate**

```bash
cd frontend && set -a && source .env && set +a && npx prisma db push --skip-generate && npx prisma generate
```

또는 raw SQL 실행:
```bash
MSYS_NO_PATHCONV=1 docker exec -i voice_training-backend-1 python -c "
import os, asyncio, asyncpg
async def main():
    url = os.environ['DATABASE_URL'].replace('postgresql+asyncpg://','postgresql://').replace('postgresql+psycopg://','postgresql://')
    c = await asyncpg.connect(url, statement_cache_size=0)
    await c.execute('''
      ALTER TABLE agent_interview_sessions
        ADD COLUMN IF NOT EXISTS phase TEXT,
        ADD COLUMN IF NOT EXISTS scan_plan JSONB,
        ADD COLUMN IF NOT EXISTS dive_plan JSONB;
    ''')
    print('migrated')
    await c.close()
asyncio.run(main())
"
```

Expected: `migrated`

- [ ] **Step 8: agent_interview.py 세션 저장 로직에 phase/scan_plan/dive_plan 추가**

세션 upsert 로직 찾아 3개 필드 추가 저장. 구체 위치는 기존 코드 읽고 판단. 패턴:
```python
await db.execute(
    update(AgentInterviewSession)
    .where(AgentInterviewSession.id == session_id)
    .values(
        phase=state.get("phase"),
        scan_plan=json.dumps(state.get("scan_plan", [])) if state.get("scan_plan") else None,
        dive_plan=json.dumps(state.get("dive_plan", [])) if state.get("dive_plan") else None,
        # ... 기존 필드
    )
)
```

- [ ] **Step 9: 종단 검증 — docker 재기동 후 backend import smoke test**

```bash
docker compose restart backend
docker compose logs backend --tail=50
```

Expected: 서버가 올라오고 import 에러 없음.

- [ ] **Step 10: 커밋**

```bash
git add backend/app/api/agent_interview.py backend/migrations/2026-04-14-agent-session-scan-dive.sql frontend/prisma/schema.prisma
git commit -m "feat(api): scan+dive 세션 영속화 + DB 마이그레이션"
```

---

### Task 9: in_progress 세션 마감

**Files:**
- Create: `backend/scripts/close_in_progress_sessions.py`

- [ ] **Step 1: 마감 스크립트 작성**

`backend/scripts/close_in_progress_sessions.py`:
```python
"""기존 in_progress 상태의 agent_interview_sessions를 강제 마감.

새 Scan+Dive 구조와 호환 안 되므로 기존 진행 중 세션은 abandoned 처리.
"""
import asyncio
import os

import asyncpg


async def main() -> None:
    url = os.environ["DATABASE_URL"]
    url = url.replace("postgresql+asyncpg://", "postgresql://").replace("postgresql+psycopg://", "postgresql://")
    conn = await asyncpg.connect(url, statement_cache_size=0)

    # 마감 대상 세션 수
    count = await conn.fetchval(
        "SELECT COUNT(*) FROM agent_interview_sessions WHERE status = 'in_progress'"
    )
    print(f"in_progress sessions to close: {count}")

    if count:
        await conn.execute("""
            UPDATE agent_interview_sessions
            SET status = 'abandoned', "updatedAt" = NOW()
            WHERE status = 'in_progress'
        """)
        print("done")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: 스크립트 실행**

```bash
MSYS_NO_PATHCONV=1 docker cp backend/scripts/close_in_progress_sessions.py voice_training-backend-1:/tmp/close.py
MSYS_NO_PATHCONV=1 docker exec voice_training-backend-1 python /tmp/close.py
```

Expected: `in_progress sessions to close: N` + `done`

- [ ] **Step 3: 커밋**

```bash
git add backend/scripts/close_in_progress_sessions.py
git commit -m "chore(migration): Scan+Dive 전환 위해 in_progress 세션 강제 마감"
```

---

### Task 10: 프론트 SSE 이벤트 처리

**Files:**
- Modify: `frontend/src/lib/agent-interview-api.ts`
- Modify: `frontend/src/components/agent-interview/` (정확한 파일은 탐색 후 결정)

- [ ] **Step 1: SSE 이벤트 타입 확장**

`frontend/src/lib/agent-interview-api.ts` 내 SSE 이벤트 타입에 `phase`/`phaseLabel` 필드 추가:

```typescript
export type AgentInterviewQuestionEvent = {
  question: string;
  questionNumber: number;
  phase?: "scan" | "dive";
  phaseLabel?: string;          // 예: "훑기 2/3 · 크롤링", "딥다이브 · 크롤링 안정성 (2/3)"
  targetArea?: string;
  difficulty?: string;
};

export type AgentInterviewStatusEvent = {
  phase: string;                 // 기존 string 유지
  max_questions?: number;        // build_scan_plan_node에서 emit
  phaseKind?: "scan" | "dive";
  scan_count?: number;
  dive_topics?: Array<{ topic: string; angle: string; project_ref: string }>;
  // ... 기존 필드
};
```

- [ ] **Step 2: 세션 페이지에서 maxQuestions 상태 관리**

`frontend/src/components/agent-interview/` 내 메인 세션 컴포넌트(이름은 탐색):

```typescript
const [maxQuestions, setMaxQuestions] = useState<number>(9);  // 기본 상한

// SSE status 이벤트 처리
if (event.phase === "scan_plan_ready" && event.max_questions) {
  setMaxQuestions(event.max_questions);
}
```

- [ ] **Step 3: 질문 카드에 phase 배지 추가**

질문 렌더 컴포넌트에서:

```tsx
{question.phaseLabel && (
  <Badge variant={question.phase === "dive" ? "default" : "secondary"}>
    {question.phaseLabel}
  </Badge>
)}
```

- [ ] **Step 4: 진행 바 문구 변경**

`"질문 N/M"` 표시에서 `M`을 state의 `maxQuestions`로. 고정 `max_questions` 파라미터 참조하던 곳 모두 교체.

- [ ] **Step 5: 프론트 rebuild**

```bash
docker compose build frontend && docker compose up -d frontend
```

Expected: 컨테이너 정상 기동.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/agent-interview-api.ts frontend/src/components/agent-interview/
git commit -m "feat(ui): scan/dive 페이즈 배지 + 동적 maxQuestions 표시"
```

---

### Task 11: 통합 수동 검증

**Files:**
- 변경 없음 (수동 QA)

- [ ] **Step 1: 로컬 dev 환경 준비**

```bash
docker compose up -d
```

Expected: 모든 컨테이너 Up.

- [ ] **Step 2: 테스트 계정으로 면접 시작 (JD 있음)**

1. `http://localhost:81` 접속 → `test@voiceprep.kr` / `test1234` 로그인
2. 면접 연습 → 이력서(여러 프로젝트 포함) + JD(매칭 2 + 비매칭 1 구성 가능한 것) 선택
3. AI 코치 면접 시작

- [ ] **Step 3: 훑기 페이즈 검증 체크리스트**

- [ ] Q1 = 이력서 프로젝트 중 JD 매칭 상위 1번 (배지: "훑기 1/3 · {프로젝트}")
- [ ] Q2 = JD 매칭 상위 2번 (배지: "훑기 2/3 · {다른 프로젝트}")
- [ ] Q3 = JD 비매칭 프로젝트 (배지: "훑기 3/3 · {비매칭 프로젝트}")
- [ ] 각 질문이 해당 프로젝트의 이력서 청크 인용 확인 (개발자 도구 네트워크 탭 SSE 로그)

- [ ] **Step 4: 딥다이브 페이즈 검증**

- [ ] Q3 답변 제출 후 `dive_plan_ready` SSE 이벤트 발생 확인
- [ ] Q4 = 약점 주제 (배지: "딥다이브 · {약점 프로젝트} 한계/개선점 (1/3)")
- [ ] Q4에 얕게 답변 → Q5가 같은 주제 계속 파고듦 (배지: "... (2/3)")
- [ ] Q5에 깊게 답변 → Q6 = 강점 주제로 전환 (배지: "딥다이브 · {강점 프로젝트} 핵심 의사결정 (1/3)")
- [ ] 강점 주제도 적응형 1~3질문 진행 후 자동 종료

- [ ] **Step 5: 리포트 생성 정상 확인**

- [ ] 세션 종료 시 리포트 생성
- [ ] history 페이지에서 해당 세션 열림 (status=completed)

- [ ] **Step 6: JD 없는 면접 시나리오**

1. 이력서만 선택, JD 없이 면접 시작
2. 훑기 3질문이 projects[0..2] 순서대로 나오는지 확인
3. 딥다이브 주제 선정이 단순 depth 점수 기반으로 동작하는지 확인

- [ ] **Step 7: projects 0개 이력서 (edge case)**

수동으로 experience만 있는 이력서 생성 → 면접 시작 → experience 기반 scan 동작 확인.

- [ ] **Step 8: DB 상태 확인**

```bash
MSYS_NO_PATHCONV=1 docker exec voice_training-backend-1 python -c "
import os, asyncio, asyncpg
async def m():
    u=os.environ['DATABASE_URL'].replace('postgresql+asyncpg://','postgresql://').replace('postgresql+psycopg://','postgresql://')
    c=await asyncpg.connect(u, statement_cache_size=0)
    r=await c.fetch('SELECT id, phase, scan_plan, dive_plan FROM agent_interview_sessions ORDER BY \"createdAt\" DESC LIMIT 3')
    for row in r: print(dict(row))
    await c.close()
asyncio.run(m())
"
```

Expected: 최근 세션이 phase="done", scan_plan/dive_plan 채워진 JSONB.

- [ ] **Step 9: 검증 완료 커밋 (검증 노트 추가 시)**

수동 테스트라 코드 변경 없음. 문제 발견되면 역추적해 해당 태스크로 돌아가기.

---

## Self-Review 체크리스트 (작성자 확인용 — 최종 제출 전)

1. **Spec 커버리지 확인:**
   - [x] Scan 3질문 플래너 → Task 2
   - [x] Dive 2주제 플래너 → Task 3
   - [x] FIT 축소 (focus_topics 제거) → Task 4
   - [x] SLIM 프롬프트 재작성 → Task 5
   - [x] DECIDE_IN_TOPIC 신설 → Task 5
   - [x] interviewer_agent scan/dive 분리 → Task 6
   - [x] nodes 재구조화 → Task 7
   - [x] InterviewState 필드 추가 → Task 1
   - [x] DB JSONB 컬럼 추가 → Task 8
   - [x] API 세션 저장 로직 → Task 8
   - [x] 프론트 SSE 이벤트 → Task 10
   - [x] in_progress 세션 마감 → Task 9
   - [x] 통합 검증 → Task 11

2. **Placeholder 스캔:** 완료. "TBD" / "later" / "appropriate handling" 없음.

3. **타입 일관성:**
   - `ScanItem.project_ref` / `DiveTopic.project_ref` 일관
   - `phase` 값: `"scan" | "dive" | "done"` 일관
   - `reason` 값: `"jd_match" | "jd_unmatched" | "project_order"` 일관
   - `angle` 값: `"weakness" | "strength"` 일관

4. **SSE 이벤트 이름 일관:** `phase` 필드는 status 이벤트에서는 라이프사이클 단계 (scan_plan_ready 등), question 이벤트에서는 페이즈 종류 (scan/dive)로 구분됨. 프론트에서 `phase` 키 이름 충돌 있음 — `question.phase` vs `status.phase`. 의미가 다르므로 수용 가능하나 Task 10에서 주의.
