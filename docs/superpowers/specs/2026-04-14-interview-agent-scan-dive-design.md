# AI 코치 면접 에이전트: Scan + Dive 재설계

**날짜**: 2026-04-14
**대상**: `backend/app/agent/` (interviewer_agent, nodes, fit_analyzer), `backend/app/prompts/agent.py`
**문제**: 현재 에이전트가 `focus_topics[i % len]` 방식으로 질문을 순환 생성. JD가 있으면 focus_topics가 JD 방향으로만 뽑혀 이력서의 JD 비매칭 영역은 한 번도 탐색되지 않음. 한 주제를 파고드는 "진짜 면접관" 행동 부재.

---

## 목표

실제 시니어 면접관의 행동을 흉내내는 2페이즈 구조로 재설계:

1. **Scan (훑기)**: 이력서의 서로 다른 프로젝트 3개를 훑어 각 1질문씩 열린 질문
2. **Dive (딥다이브)**: 훑기 답변 점수를 보고 주제 2개(약점 1 + 강점 1) 선정 → 주제별 1~3질문 적응형 파고들기

**질문 수 범위** (projects 개수에 따라 가변):
- projects ≥ 3: 총 5~9 (scan 3 + dive 2~6)
- projects = 2: 총 4~8 (scan 2 + dive 2~6)
- projects = 1: 총 3~7 (scan 1 + dive 2~6 — 단일 프로젝트의 다른 각도 2주제)
- projects = 0 (이력서에 projects 배열 없음): experience로 scan 대체. experience도 없으면 기존 FALLBACK 프롬프트로 1회 질문 후 종료 (degenerate 케이스).

---

## 설계 결정 (브레인스토밍 합의)

- **B 스타일**: 스캔+딥다이브 2페이즈 (A 딥다이브전용 / C 사전플랜전용 거부)
- **훑기 플랜**: A+C 하이브리드 — JD 있으면 `매칭 프로젝트 2 + 비매칭 1`, JD 없으면 `projects[0..2]`
- **딥다이브 주제 선택**: D 혼합 — `약점 1 + 강점 1` (JD 있으면 JD 매칭 프로젝트 내에서만)
- **딥다이브 깊이**: B 적응형 — depth 점수 기반 주제 내 1~3질문
- **JD 없을 때 fallback**: A 단순 품질 기반 — `depth 최저 + 최고` (JD 관련도 제거)

---

## 아키텍처

### 상태 기계 변경

**현재 노드 흐름**:
```
load_profile → fit_analysis → generate_question ⇄ evaluate ⇄ decide_next → (follow_up | next_question | end)
```

**새 노드 흐름**:
```
load_profile → fit_analysis → build_scan_plan → scan_ask ⇄ evaluate ⇄ scan_next
                                                                       ↓ (3개 완료)
                                                                  build_dive_plan → dive_ask ⇄ evaluate ⇄ decide_in_topic
                                                                                                         ↓ (2주제 완료)
                                                                                                       end
```

- `build_scan_plan` / `build_dive_plan`: **순수 코드 노드** (LLM 호출 없음). 이미 존재하는 `fit_analysis.skill_match` + `evaluation.scores.depth` 재활용.
- `scan_next`: 훑기 3개 남았으면 다음 훑기 질문, 다 끝났으면 `build_dive_plan`으로.
- `decide_in_topic`: 현재 주제의 마지막 답변 depth<70이고 주제 내 질문수<3이면 `dig_deeper`, 아니면 `next_topic`. 2주제 모두 소진되면 `end`.

### InterviewState 추가 필드

```python
phase: Literal["scan", "dive", "done"]      # 현재 페이즈
scan_plan: list[ScanItem]                   # 훑기 3질문 계획 (build_scan_plan에서 확정)
dive_plan: list[DiveTopic]                  # 딥다이브 2주제 (build_dive_plan에서 확정)
current_scan_idx: int                       # 훑기 진행도 (0~2)
current_dive_idx: int                       # 딥다이브 진행 주제 (0~1)
current_dive_depth: int                     # 현재 주제 내 질문 수 (1~3)
```

```python
class ScanItem(TypedDict):
    project_ref: str         # 이력서 프로젝트 식별자 (name)
    query: str               # RAG 검색 쿼리 (project_ref + techStack)
    reason: Literal["jd_match", "jd_unmatched", "project_order"]

class DiveTopic(TypedDict):
    topic: str               # 주제 라벨
    project_ref: str         # 어느 프로젝트 기반인지
    angle: Literal["weakness", "strength"]
    scan_question_idx: int   # 훑기의 몇 번째 답변을 기반으로 선정했는지
    query: str               # RAG 검색 쿼리
```

### DB 스키마 변경

`agent_interview_sessions` 테이블에 3개 JSONB 컬럼 추가 (세션 재개/디버깅/분석용):
- `phase` TEXT
- `scan_plan` JSONB
- `dive_plan` JSONB

Prisma schema 업데이트 + 마이그레이션 SQL 추가.

---

## 플래너 로직 (`backend/app/agent/planner.py` 신규)

### `build_scan_plan(resume, fit_analysis) -> list[ScanItem]`

```
projects = resume.projects (없거나 부족하면 experience로 보충)

if fit_analysis.skill_match is not None:
    # JD 있음: 각 프로젝트의 techStack ∩ matched 개수로 점수화
    scored = [(p, len(set(p.techStack) ∩ set(matched))) for p in projects]
    sorted = scored.sorted(desc)
    return [
        ScanItem(sorted[0], reason="jd_match"),
        ScanItem(sorted[1], reason="jd_match"),
        ScanItem(sorted[-1], reason="jd_unmatched"),   # 최하위 점수
    ]
else:
    return [ScanItem(projects[i], reason="project_order") for i in range(min(3, len(projects)))]
```

projects가 3개 미만이면 있는 만큼만 (훑기 2~3개 가변).

### `build_dive_plan(scan_plan, scan_evaluations, fit_analysis) -> list[DiveTopic]`

```
# 각 훑기 질문의 depth 점수
scored = [(idx, scan_plan[idx], eval.scores.depth) for idx, eval in enumerate(scan_evaluations)]

# JD 매칭 제약 (있으면)
if fit_analysis.skill_match:
    jd_matched_idx = {i for i in range(len(scan_plan)) if scan_plan[i].reason == "jd_match"}
    candidates = [s for s in scored if s[0] in jd_matched_idx]
    if len(candidates) < 2:
        candidates = scored   # fallback: JD 매칭이 1개뿐이면 전체 허용
else:
    candidates = scored

weakness = min(candidates, key=depth)
strength = max(candidates, key=depth)

# 두 주제가 동일 scan_idx(= 동일 프로젝트)를 가리키면:
# - DiveTopic 2개 모두 같은 project_ref 사용
# - angle만 "weakness"/"strength"로 구분
# - topic 라벨은 각각 "{project_ref} 한계/개선점", "{project_ref} 핵심 의사결정"으로 생성
# - 프롬프트가 "새 각도" 강제: weakness 주제는 "왜/트레이드오프/실패", strength 주제는 "핵심 결정/대안 비교"
# scan이 1개(projects=1)면 자동으로 이 경로가 유일한 선택

return [
    DiveTopic(angle="weakness", ...),
    DiveTopic(angle="strength", ...),
]
```

---

## 프롬프트 변경

### 삭제

- `FIT_ANALYSIS_PROMPT` 에서 `focus_topics` 필드 제거. `skill_match` + `avoid_topics`만 반환하도록 축소.
- `INTERVIEWER_QUESTION_PROMPT_FALLBACK` 유지 (임베딩 없는 이력서 fallback).

### 수정: `INTERVIEWER_QUESTION_PROMPT_SLIM`

`{current_focus_topic}` → `{current_topic_plan}` 로 변경. 페이즈별 블록 주입:

- **Scan 페이즈**: `"훑기 질문 {n}/3: '{project_ref}' 프로젝트에 대한 '핵심 기여/기술 결정' 성격의 열린 질문 1개. 한 프로젝트에만 초점."`
- **Dive 페이즈**: `"딥다이브 주제: '{topic}' (angle: {angle}, 질문 {n}/3). 이 주제만 파세요. 직전 답변에서 지원자가 언급한 구체 사실을 지목해 {what→why→tradeoff→실패} 사다리로 파고들기. 새 주제 도입 금지."`

공통 지시사항 추가:
- "이력서 발췌(resume_chunks)의 구체 사실만 인용해서 질문 구성. 일반적 CS 질문 금지."

### 신규: `INTERVIEWER_DECIDE_IN_TOPIC_PROMPT`

기존 `INTERVIEWER_DECIDE_PROMPT` 대체. 규칙:
1. `current_dive_depth >= 3` → `next_topic`
2. `current_dive_idx == len(dive_plan) - 1 && current_dive_depth >= 2 && depth >= 70` → `end`
3. `last_evaluation.depth < 70` → `dig_deeper`
4. 그 외 → `next_topic`

출력: `{ "action": "dig_deeper" | "next_topic" | "end", "reason": "..." }`

---

## RAG 쿼리 변경

현재 `nodes.py:164`:
```python
query = current_focus_topic or current_answer or summary or "주요 경험"
```

새 구조:
```python
# Scan 페이즈
query = scan_plan[current_scan_idx].query     # 예: "웹 크롤링 Selenium Playwright"
# Dive 페이즈
query = dive_plan[current_dive_idx].query     # 같은 프로젝트 이름 기반
```

결과: RAG가 반드시 **해당 프로젝트의 청크**를 top-3로 반환 → LLM이 다른 주제로 이탈 불가.

---

## 레거시 정리

- `nodes.py:158-164` (focus_topics 순환) 삭제
- `nodes.py` 의 `generate_question`을 `scan_ask` / `dive_ask` 2개로 분리
- `nodes.py` `decide_next` → `scan_next` / `decide_in_topic` 2개로 분리
- `MAX_FOLLOW_UP_ROUND` 상수 삭제. 대신 `MAX_DIVE_DEPTH = 3`.
- 기존 `follow_up_round` 상태 필드 제거. `current_dive_depth`가 대체.

---

## 프론트 영향

- SSE 이벤트에 `phase: "scan" | "dive"` 추가.
- `generating_question` 이벤트에 `phaseLabel` (예: `"훑기 2/3"`, `"딥다이브 — 크롤링 (2/3)"`) 포함 → 진행 배지 표시.
- 기존 `questionNumber` 필드는 전체 질문 누적 번호로 유지 (프론트 변경 최소화).
- 총 질문 수 가변: 프론트는 `"{currentQ} / 최대 {maxQ}"` 식으로 표시. `maxQ`는 세션 시작 시 `scan_plan` 확정 후 계산(`len(scan_plan) + 6`)해서 SSE `session_info` 이벤트로 1회 전달. 기존 `max_questions` 파라미터는 deprecated.

---

## 마이그레이션 전략

1. 코드 새 구조 구현 (기존 로직 삭제하면서 동시에)
2. Prisma schema + SQL 마이그레이션 배포
3. 진행 중 세션(status=in_progress)은 새 구조 호환 안 됨 → 마이그레이션 시점에 전부 `completed` 마감 처리 (or 강제 종료)
4. 프론트는 SSE 이벤트 추가 필드만 받으면 무시해도 동작 (backward compatible)

---

## 테스트 전략

- **단위 테스트**: `build_scan_plan`, `build_dive_plan` — JD 있음/없음, projects 0/1/2/3+ 개, skill_match 빈/가득 케이스
- **통합 테스트**: 세션 1개 돌려서 `phase` 전환, `scan_plan`/`dive_plan` DB 저장, 5~9질문 범위 확인
- **회귀**: 기존 세션 리포트 생성, 프로필 업데이트 정상 작동 (evaluator_agent는 변경 없음)

---

## Out of Scope (이번 변경 아님)

- 평가 프롬프트 (`EVALUATOR_PROMPT`) 변경 없음
- 모범답안 학습 시스템 변경 없음
- 저널/학습 에이전트 무관
- Prod 세션 재개 (in_progress 세션은 강제 종료로 처리)
- UI 대대적 리디자인 (phase 배지만 소규모 추가)
