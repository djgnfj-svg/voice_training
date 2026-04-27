# 면접관 아바타 + 속마음 UX 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 코치 면접 화면에 면접관 캐릭터(좌측 표정 6종) + 속마음 풍선(우측, 답변 평가 후 표시)을 추가한다. evaluation LLM 출력에 `innerThought` 필드 1개만 추가하여 별도 호출 없이 작동.

**Architecture:** 기존 SSE evaluation 이벤트에 `innerThought` 필드 추가 → 프론트가 phase + 최근 evaluation으로 표정과 속마음을 파생 → 새 `InterviewerStage` 컴포넌트가 `AgentInterviewPanel` 상단에 렌더.

**Tech Stack:** Python (FastAPI, LangGraph), React/Next.js, Framer Motion(이미 설치됨이면 사용, 아니면 CSS transition).

**Spec:** `docs/superpowers/specs/2026-04-27-interviewer-avatar-thought-design.md`

---

## File Structure

신규:
- `frontend/public/interviewer/{neutral,listening,thinking,impressed,skeptical,disappointed}.svg` — 면접관 표정 6종 (MVP는 임시 SVG, 후속 PR로 일러스트 교체)
- `frontend/src/components/agent-interview/interviewer-stage.tsx` — 캐릭터 + 속마음 풍선 컴포넌트

수정:
- `backend/app/prompts/agent.py` — `EVALUATOR_PROMPT`에 `innerThought` 필드 추가
- `backend/app/agent/interview/evaluation.py` — `_normalize_evaluation`에 innerThought fallback + trim
- `backend/app/agent/interview/graph.py` — evaluation SSE 페이로드에 `innerThought` 포함
- `frontend/src/hooks/useAgentInterview.ts` — SSE evaluation에서 `innerThought` 보존
- `frontend/src/components/agent-interview/agent-interview-panel.tsx` — Stage 삽입 + expression/thought 파생

---

### Task 1: 백엔드 — EVALUATOR_PROMPT에 innerThought 필드 추가

**Files:**
- Modify: `backend/app/prompts/agent.py:170-243`

- [ ] **Step 1: EVALUATOR_PROMPT JSON 스키마에 innerThought 추가**

`backend/app/prompts/agent.py` 의 EVALUATOR_PROMPT 마지막 JSON 블록을 다음으로 수정:

```python
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
  "weaknessDetected": "새로 발견된 약점 (없으면 null)",
  "innerThought": "면접관이 이 답변을 들으며 떠올린 속마음 한 줄 (1인칭, 반말 가능, 30~50자, 캐릭터성 있는 한국어). 점수가 높으면 호의적/감탄 톤, 낮으면 미묘한 실망/의심 톤. 예: '오, 트레이드오프 분석은 좋은데 수치가 빠졌네...', '음... 추상적이군', '흥미롭군. 더 파볼까?'"
}}
```

- [ ] **Step 2: 커밋**

```bash
git add backend/app/prompts/agent.py
git commit -m "feat(prompt): add innerThought field to EVALUATOR_PROMPT"
```

---

### Task 2: 백엔드 — _normalize_evaluation에 innerThought 정규화 추가

**Files:**
- Modify: `backend/app/agent/interview/evaluation.py:91-127`

- [ ] **Step 1: 실패 테스트 작성**

`backend/tests/agent/test_evaluation_inner_thought.py` 신규 (없으면 디렉토리 포함 생성):

```python
from app.agent.interview.evaluation import _normalize_evaluation


def test_inner_thought_preserved_when_present():
    raw = {
        "scores": {"clarity": 80, "accuracy": 80, "practicality": 80, "depth": 80, "completeness": 80},
        "innerThought": "오 좋은 답변인데?",
    }
    result = _normalize_evaluation(raw, answer="실제 답변 내용입니다 충분히 길어요 키워드 다양성도 OK")
    assert result["innerThought"] == "오 좋은 답변인데?"


def test_inner_thought_trimmed_to_80_chars():
    long_thought = "가" * 200
    raw = {
        "scores": {"clarity": 80, "accuracy": 80, "practicality": 80, "depth": 80, "completeness": 80},
        "innerThought": long_thought,
    }
    result = _normalize_evaluation(raw, answer="답변 내용 충분히 길어요 키워드 다양해요 OK")
    assert len(result["innerThought"]) <= 80


def test_inner_thought_fallback_when_missing_high_score():
    raw = {
        "scores": {"clarity": 90, "accuracy": 90, "practicality": 90, "depth": 90, "completeness": 90},
    }
    result = _normalize_evaluation(raw, answer="좋은 답변 내용 충분히 길어요 키워드 다양해요 OK")
    assert result["innerThought"]
    assert isinstance(result["innerThought"], str)


def test_inner_thought_fallback_when_low_quality():
    raw = {"scores": {"clarity": 0, "accuracy": 0, "practicality": 0, "depth": 0, "completeness": 0}}
    result = _normalize_evaluation(raw, answer="아아아아아아아아아아아아아아아아아아아아아아")
    assert result["innerThought"]


def test_inner_thought_blank_falls_back():
    raw = {
        "scores": {"clarity": 80, "accuracy": 80, "practicality": 80, "depth": 80, "completeness": 80},
        "innerThought": "   ",
    }
    result = _normalize_evaluation(raw, answer="답변 내용 충분 키워드 다양 OK 길이 충분합니다")
    assert result["innerThought"].strip()
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
docker compose exec backend pytest tests/agent/test_evaluation_inner_thought.py -v
```
Expected: FAIL (innerThought 키 없음 또는 None)

- [ ] **Step 3: `_normalize_evaluation` 수정**

`backend/app/agent/interview/evaluation.py` 에서 `_normalize_evaluation` 함수 본문 마지막 `return evaluation` 직전에 추가:

```python
    # innerThought 정규화: 빈 값/누락 시 점수 기반 fallback, 80자 trim
    raw_thought = evaluation.get("innerThought")
    thought = (raw_thought or "").strip() if isinstance(raw_thought, str) else ""
    if not thought:
        overall = evaluation["overallScore"]
        if overall >= 80:
            thought = "오, 좋은데?"
        elif overall >= 60:
            thought = "음... 애매하네"
        else:
            thought = "아쉽다..."
    if len(thought) > 80:
        thought = thought[:80]
    evaluation["innerThought"] = thought
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
docker compose exec backend pytest tests/agent/test_evaluation_inner_thought.py -v
```
Expected: 5 passed

- [ ] **Step 5: 커밋**

```bash
git add backend/app/agent/interview/evaluation.py backend/tests/agent/test_evaluation_inner_thought.py
git commit -m "feat(eval): normalize and fallback innerThought field"
```

---

### Task 3: 백엔드 — SSE evaluation 이벤트에 innerThought 추가

**Files:**
- Modify: `backend/app/agent/interview/graph.py:281-290`

- [ ] **Step 1: SSE 페이로드에 필드 추가**

`backend/app/agent/interview/graph.py` 의 evaluation 이벤트 빌드 부분을 다음으로 변경:

```python
    events.append({
        "event": "evaluation",
        "data": {
            "overallScore": answer_evaluation.get("overallScore", 0),
            "briefFeedback": answer_evaluation.get("briefFeedback", ""),
            "detailedFeedback": answer_evaluation.get("detailedFeedback", ""),
            "modelAnswer": answer_evaluation.get("modelAnswer", ""),
            "scores": answer_evaluation.get("scores", {}),
            "innerThought": answer_evaluation.get("innerThought", ""),
        },
    })
```

- [ ] **Step 2: dev 백엔드 자동 reload 확인**

```bash
docker compose logs --tail=10 backend
```
Expected: "Reloading..." 또는 reload 메시지

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/interview/graph.py
git commit -m "feat(graph): emit innerThought in evaluation SSE event"
```

---

### Task 4: 프론트엔드 — useAgentInterview에서 innerThought 보존

**Files:**
- Modify: `frontend/src/hooks/useAgentInterview.ts:11-19,94-104`

- [ ] **Step 1: AgentMessage evaluation 타입은 이미 `Record<string, unknown>` 이라 추가 작업 불필요. SSE handler 검증**

`useAgentInterview.ts` 의 evaluation 핸들러는 이미 `data` 전체를 `evaluation` 필드에 저장한다(94-104줄). `data.innerThought` 가 자동으로 들어가므로 코드 변경 없음.

- [ ] **Step 2: 별도 헬퍼 추가 — 가장 최근 innerThought 추출**

`frontend/src/hooks/useAgentInterview.ts` 의 `useAgentInterview` 반환 직전에:

```typescript
  const lastInnerThought = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "agent_evaluation") {
        const t = (m.evaluation as { innerThought?: string } | undefined)?.innerThought;
        return typeof t === "string" && t.trim() ? t : null;
      }
      if (m.role === "agent_question" || m.role === "agent_followup") {
        // 새 질문이 도착했으면 이전 속마음은 더 이상 표시 안 함
        return null;
      }
    }
    return null;
  })();
```

그리고 return 객체에 `lastInnerThought` 추가.

- [ ] **Step 3: 타입 체크**

```bash
docker compose exec frontend npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/hooks/useAgentInterview.ts
git commit -m "feat(hook): expose lastInnerThought from agent interview"
```

---

### Task 5: 프론트엔드 — 임시 SVG 아바타 6종 추가

**Files:**
- Create: `frontend/public/interviewer/neutral.svg`
- Create: `frontend/public/interviewer/listening.svg`
- Create: `frontend/public/interviewer/thinking.svg`
- Create: `frontend/public/interviewer/impressed.svg`
- Create: `frontend/public/interviewer/skeptical.svg`
- Create: `frontend/public/interviewer/disappointed.svg`

각 SVG는 200×240 viewbox, 정장 캐릭터 단순 일러스트 + 표정만 다름. 후속 PR에서 일러스트로 교체 예정.

- [ ] **Step 1: 임시 SVG 6장 생성**

각 파일 동일 베이스 + 입/눈썹만 다르게. 예시 `neutral.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240" width="200" height="240">
  <rect width="200" height="240" fill="#e8eef3"/>
  <!-- 정장 -->
  <path d="M40 240 L40 180 Q100 150 160 180 L160 240 Z" fill="#2c3e50"/>
  <rect x="92" y="180" width="16" height="60" fill="#fff"/>
  <!-- 머리 -->
  <ellipse cx="100" cy="100" rx="55" ry="65" fill="#f4d4b0"/>
  <path d="M50 80 Q100 30 150 80 L150 60 Q100 20 50 60 Z" fill="#3a2618"/>
  <!-- 눈 -->
  <ellipse cx="80" cy="100" rx="4" ry="6" fill="#222"/>
  <ellipse cx="120" cy="100" rx="4" ry="6" fill="#222"/>
  <!-- 입 (neutral: 일자) -->
  <line x1="85" y1="135" x2="115" y2="135" stroke="#5a3a2a" stroke-width="3" stroke-linecap="round"/>
</svg>
```

표정별 입/눈썹 차이:
- `listening.svg`: 입 `<path d="M85 135 Q100 132 115 135" stroke="#5a3a2a" stroke-width="3" fill="none" stroke-linecap="round"/>` (살짝 미소)
- `thinking.svg`: 눈썹 추가 `<line x1="70" y1="85" x2="90" y2="82" stroke="#3a2618" stroke-width="3"/>` `<line x1="110" y1="82" x2="130" y2="85" stroke="#3a2618" stroke-width="3"/>` + 입 `<circle cx="100" cy="135" r="3" fill="#5a3a2a"/>`
- `impressed.svg`: 눈썹 위로 + 입 `<path d="M80 130 Q100 145 120 130" stroke="#5a3a2a" stroke-width="3" fill="none"/>` (웃음)
- `skeptical.svg`: 한쪽 눈썹만 위 `<line x1="110" y1="78" x2="130" y2="85" stroke="#3a2618" stroke-width="3"/>` + 입 `<line x1="85" y1="138" x2="115" y2="132" stroke="#5a3a2a" stroke-width="3"/>` (비대칭)
- `disappointed.svg`: 눈썹 처짐 `<line x1="70" y1="90" x2="90" y2="85" stroke="#3a2618" stroke-width="3"/>` + 입 `<path d="M80 140 Q100 130 120 140" stroke="#5a3a2a" stroke-width="3" fill="none"/>` (역U)

각각 위 베이스에서 입·눈썹 line만 교체해 6 파일 작성.

- [ ] **Step 2: 파일 6개 존재 확인**

```bash
ls frontend/public/interviewer/
```
Expected: 6 SVG 파일

- [ ] **Step 3: 커밋**

```bash
git add frontend/public/interviewer/
git commit -m "feat(asset): add 6 placeholder interviewer expression SVGs"
```

---

### Task 6: 프론트엔드 — InterviewerStage 컴포넌트 작성

**Files:**
- Create: `frontend/src/components/agent-interview/interviewer-stage.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`frontend/src/components/agent-interview/interviewer-stage.tsx`:

```tsx
'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';

export type InterviewerExpression =
  | 'neutral'
  | 'listening'
  | 'thinking'
  | 'impressed'
  | 'skeptical'
  | 'disappointed';

interface InterviewerStageProps {
  expression: InterviewerExpression;
  innerThought: string | null;
  className?: string;
}

export function InterviewerStage({
  expression,
  innerThought,
  className,
}: InterviewerStageProps) {
  return (
    <div
      data-testid="interviewer-stage"
      className={cn(
        'relative flex aspect-[5/3] w-full items-center overflow-hidden rounded-2xl',
        'bg-gradient-to-br from-slate-200 via-slate-300 to-slate-400',
        'dark:from-slate-700 dark:via-slate-800 dark:to-slate-900',
        className,
      )}
    >
      {/* 좌측 캐릭터 (45%) */}
      <div className="relative h-full w-[45%] flex-shrink-0">
        <Image
          src={`/interviewer/${expression}.svg`}
          alt={`면접관 표정: ${expression}`}
          fill
          priority
          sizes="(max-width: 768px) 45vw, 300px"
          className="object-contain object-bottom"
          data-testid={`interviewer-expression-${expression}`}
        />
      </div>

      {/* 우측 속마음 영역 (55%) */}
      <div className="flex flex-1 items-center pr-4">
        {innerThought ? (
          <div
            data-testid="inner-thought-bubble"
            className={cn(
              'relative rounded-2xl rounded-bl-sm border-[1.5px] border-dashed px-3 py-2',
              'border-amber-600 bg-amber-100/95 italic text-amber-900',
              'dark:border-amber-500 dark:bg-amber-950/80 dark:text-amber-200',
              'text-sm leading-snug shadow-sm',
              'animate-in fade-in slide-in-from-left-2 duration-300',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute -left-2 top-1/2 -translate-y-1/2',
                'h-0 w-0 border-y-[6px] border-r-[8px] border-y-transparent',
                'border-r-amber-100/95 dark:border-r-amber-950/80',
              )}
            />
            <span
              aria-hidden
              className={cn(
                'absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center',
                'rounded-full border border-dashed border-amber-600 bg-white text-[11px] not-italic',
                'dark:border-amber-500 dark:bg-slate-900',
              )}
            >
              💭
            </span>
            {innerThought}
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

```bash
docker compose exec frontend npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/agent-interview/interviewer-stage.tsx
git commit -m "feat(ui): add InterviewerStage component"
```

---

### Task 7: 프론트엔드 — AgentInterviewPanel에 Stage 통합

**Files:**
- Modify: `frontend/src/components/agent-interview/agent-interview-panel.tsx`

- [ ] **Step 1: import 추가**

`agent-interview-panel.tsx` 상단 import 블록에 추가:

```tsx
import { InterviewerStage, type InterviewerExpression } from './interviewer-stage';
```

- [ ] **Step 2: hook 반환에서 lastInnerThought 구조분해**

`useAgentInterview()` 반환 구조분해(38-49줄)에 `lastInnerThought` 추가:

```tsx
  const {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions: maxQ,
    error,
    start,
    submitAnswer,
    skip,
    endEarly,
    lastInnerThought,
  } = useAgentInterview();
```

- [ ] **Step 3: expression 파생 헬퍼**

`return (` 직전에 추가:

```tsx
  const expression: InterviewerExpression = (() => {
    if (phase === 'evaluating' || phase === 'generating_followup') return 'thinking';
    if (speech.isListening) return 'listening';
    const ev = lastEvaluation?.evaluation as { overallScore?: number } | undefined;
    if (ev && phase === 'waiting_answer' && typeof ev.overallScore === 'number') {
      if (ev.overallScore >= 80) return 'impressed';
      if (ev.overallScore >= 60) return 'skeptical';
      return 'disappointed';
    }
    return 'neutral';
  })();

  const stageThought: string | null = (() => {
    if (phase === 'evaluating') return '흠... 잠깐 보자';
    if (speech.isListening) return null;
    return lastInnerThought ?? null;
  })();
```

- [ ] **Step 4: Stage를 progress 위/Header 아래에 삽입**

`agent-interview-panel.tsx` 의 `{/* Progress + Volume */}` 블록 직전에 추가:

```tsx
      {/* Interviewer Stage */}
      {phase !== 'completed' && (
        <InterviewerStage
          expression={expression}
          innerThought={stageThought}
        />
      )}
```

- [ ] **Step 5: TypeScript & 시각 확인**

```bash
docker compose exec frontend npx tsc --noEmit
```
Expected: no errors

브라우저 `http://localhost:81/agent-interview/setup` → 이력서 선택 → 면접 시작 → 캐릭터 + 표정 변화 + 속마음 풍선 직접 확인 (질문 ↔ 답변 ↔ 평가 사이클).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/components/agent-interview/agent-interview-panel.tsx
git commit -m "feat(ui): integrate InterviewerStage into agent interview panel"
```

---

### Task 8: E2E 시각 베이스라인 갱신 (사용자 승인 후)

**Files:**
- Modify: `tests/e2e/specs/agent-interview.spec.ts-snapshots/*` (자동 생성)

- [ ] **Step 1: 기존 시각 회귀 실행으로 diff 확인**

```bash
cd tests/e2e && set -a && source .env && set +a && npx playwright test specs/visual.spec.ts specs/agent-interview.spec.ts --project=desktop
```
Expected: 시각 diff (Stage가 추가됐으므로). 실패는 정상.

- [ ] **Step 2: 사용자에게 베이스라인 갱신 승인 요청**

> "Stage 추가로 시각 회귀 baseline이 깨졌습니다. `--update-snapshots` 로 갱신할까요?"

- [ ] **Step 3: (사용자 승인 시) 베이스라인 갱신**

```bash
cd tests/e2e && set -a && source .env && set +a && npx playwright test specs/agent-interview.spec.ts specs/visual.spec.ts --update-snapshots
```

- [ ] **Step 4: 갱신된 스크린샷 검토 후 커밋**

```bash
git add tests/e2e/specs/*.spec.ts-snapshots/
git commit -m "test(e2e): update visual baselines for InterviewerStage"
```

---

### Task 9: voiceprep-feature 측정 마무리

- [ ] **Step 1: measurer 에이전트 호출**

before/after 메트릭 비교 + 포트폴리오 어필 카피 생성 (LLM 토큰 증가량, 번들 크기, TS 에러, 시각 변화).

- [ ] **Step 2: 측정 결과를 PR 설명에 포함**

---

## Self-Review

**Spec 커버리지:**
- ✅ 6 표정 (Task 5)
- ✅ InterviewerStage 좌측 캐릭터 + 우측 풍선 (Task 6)
- ✅ Panel 통합 + expression/thought 파생 로직 (Task 7)
- ✅ EVALUATOR_PROMPT innerThought (Task 1)
- ✅ normalize fallback + trim (Task 2)
- ✅ SSE 페이로드 (Task 3)
- ✅ hook 보존 (Task 4)
- ✅ E2E baseline (Task 8)
- ✅ 측정 (Task 9)

**Placeholder 스캔:** 없음. 코드/명령 모두 구체.

**타입 일관성:** `InterviewerExpression` 타입은 Task 6에서 정의되어 Task 7에서 import. `lastInnerThought` 는 Task 4에서 추가, Task 7에서 사용. 일치.

**미해결 의존성:** spec에서 언급한 "fitting agent 평가 프롬프트" 는 본 플랜이 EVALUATOR_PROMPT 한 곳만 다룸 — agent.py의 EVALUATOR_PROMPT만이 코치 면접 평가에서 실제 사용됨(`build_evaluation_messages`). `prompts/evaluation.py`의 다른 프롬프트들은 레거시 면접에서만 쓰이므로 범위 밖. 의도된 선택.
