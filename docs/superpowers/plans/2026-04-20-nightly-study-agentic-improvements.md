# CS 학습 어시스트 — 에이전트 동작 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CS 학습 어시스트를 "진짜 에이전트처럼" 동작하도록 세 가지 개선을 한 스펙으로 반영. ① SSE phase 이벤트 + 프론트 진행 인디케이터, ② 재방문 세션에서 RAG 기반 이어가기 인사, ③ 세션 중 목표 변경 감지 + 확인 후 curriculum swap.

**Architecture:**
- 백엔드: 기존 `ns_orchestrator.run_turn` + `ns_planner.run_planner` 파이프라인에 phase emit hook + 목표 변경 툴 2개 추가. `nightly_study.start_session`에 재방문 분기.
- 프론트: `useNightlyStudyStream` 훅에 `onPhase` 콜백 추가, `session-view`의 footer Status Card에 단계별 문구 주입.
- DB: `learning_sessions.pending_action JSONB NULL` 컬럼 1개 추가 (raw SQL, Prisma 미관여).

**Tech Stack:** FastAPI + SQLAlchemy (async) + sse-starlette, Next.js 15 + SSE fetch reader, OpenAI Chat Completions via `backend/app/lib/llm_client.py`, PostgreSQL (Supabase).

**Spec:** `docs/superpowers/specs/2026-04-20-nightly-study-agentic-improvements-design.md`

**관련 설정 — 테스트 정책:**
이 기능 영역(`backend/app/agent/ns_*`, `nightly-study` 라우터/UI)에는 기존에 자동 테스트가 없고, 스펙의 비목표 섹션에서 자동 테스트 인프라 신설을 제외함. 따라서 각 커밋 단계에서 **수동 검증 체크리스트**로 대체하고, TDD 단계는 플랜에 포함하지 않음. 대신 각 Task 끝에 실제 dev 환경(`http://localhost:81`)에서 확인할 구체적 시나리오를 명시.

---

## File Structure

**Backend (수정):**
- `backend/app/agent/ns_orchestrator.py` — emit_phase helper, pending_action 로드/소비, phase emit 포인트 3개
- `backend/app/agent/ns_planner.py` — PlannerOutput 타입 확장(change_goal intent), _validate_planner_output 업데이트
- `backend/app/agent/ns_state.py` — PlannerOutput 타입 확장
- `backend/app/agent/ns_tools.py` — `tool_propose_goal_change`, `tool_confirm_goal_change` 추가
- `backend/app/agent/ns_seed.py` — (그대로 사용, 변경 없음)
- `backend/app/prompts/nightly_study.py` — PLANNER_SYSTEM_PROMPT에 change_goal 분기 추가, CONTINUATION_GREETING_PROMPT 신규
- `backend/app/routers/nightly_study.py` — `start_session` 분기 로직, `end_session`에서 `pending_action` clear
- `backend/app/agent/ns_greeting.py` **(신규)** — `generate_continuation_greeting()` 헬퍼. 독립 파일로 분리해서 `start_session`과 orchestrator가 각각 import하기 쉽게.

**Backend (신규 마이그레이션):**
- `backend/migrations/2026-04-20-nightly-study-pending-action.sql`

**Frontend (수정):**
- `frontend/src/hooks/useNightlyStudyStream.ts` — `PhaseEvent` 타입, `onPhase` 옵션, phase 파서
- `frontend/src/components/nightly-study/session-view.tsx` — `phase` state, footer Status Card에 phase별 문구
- `frontend/src/lib/nightly-study-api.ts` — `StartResponse`에 `headlineSource` 같은 신규 필드 (목표 변경 후 headline 갱신용, 필요 시)

---

# 커밋 1: SSE phase 이벤트 + 프론트 진행 인디케이터 (C)

## Task 1-1: 백엔드 `emit_phase` helper + run_turn phase 지점 3곳

**Files:**
- Modify: `backend/app/agent/ns_orchestrator.py`

- [ ] **Step 1-1-1: `run_turn` 최상단에 phase emit 헬퍼 타입 추가하고 3곳에 이벤트 yield**

기존 `run_turn`은 `AsyncGenerator[dict, None]`. phase 타입은 기존 event type system(`text/meta/error/end`)에 `phase` 하나 추가. 별도 helper 함수보다 inline yield가 가독성 좋음.

`backend/app/agent/ns_orchestrator.py` 수정 — 세 지점에 yield 추가:

**지점 A: planner 호출 직전** (기존 라인 45-46 `# 3. Run planner` 바로 앞)

```python
    # 3. Run planner
    yield {"type": "phase", "data": {"phase": "thinking", "label": "생각하는 중"}}
    try:
        planner_out = await run_planner(
            ...
        )
    except Exception as e:
        ...
```

**지점 B: `retrieve_memory` 툴 실행 직전** (기존 라인 85 `if tool == "retrieve_memory":` 블록 내부)

```python
            if tool == "retrieve_memory":
                yield {"type": "phase", "data": {"phase": "retrieving", "label": "지난 대화 살펴보는 중"}}
                rag_hits = await tool_retrieve_memory(
                    db, user_id, args.get("query", ""),
                    state["current_node"]["id"] if state["current_node"] else None,
                )
```

**지점 C: 최종 응답 텍스트 yield 직전** (기존 라인 183-188 `# 6. Stream assistant reply` 바로 앞)

```python
    # 6. Stream assistant reply
    yield {"type": "phase", "data": {"phase": "generating", "label": "답변 준비 중"}}
    final_reply = " ".join(p for p in assistant_reply_parts if p).strip()
    if not final_reply:
        final_reply = "네, 계속 해볼까요?"

    yield {"type": "text", "data": final_reply}
```

- [ ] **Step 1-1-2: 라우터 `turn` 엔드포인트에서 `phase` 이벤트도 SSE로 통과시키는지 확인**

`backend/app/routers/nightly_study.py`의 `event_stream()` (라인 235-249)은 이미 모든 `ev["type"]`을 SSE event name으로 그대로 넘김:

```python
yield {"event": ev["type"], "data": json.dumps(ev["data"], ensure_ascii=False)}
```

따라서 `type: 'phase'`도 자동으로 `event: phase`로 발행됨. 추가 변경 **없음**.

- [ ] **Step 1-1-3: dev 백엔드 reload 확인**

`docker compose` dev는 `./backend` 볼륨 마운트 + `--reload`이므로 자동 반영. 수동 검증은 다음 Task에서 프론트와 함께.

---

## Task 1-2: 프론트 `useNightlyStudyStream`에 phase 파싱 + 콜백

**Files:**
- Modify: `frontend/src/hooks/useNightlyStudyStream.ts`

- [ ] **Step 1-2-1: 훅에 `PhaseEvent` 타입 + `onPhase` 옵션 추가**

`frontend/src/hooks/useNightlyStudyStream.ts` 상단 타입 블록에 추가:

```typescript
export type StreamPhase = 'thinking' | 'retrieving' | 'generating';

export interface PhaseEvent {
  phase: StreamPhase;
  label: string;
}

export interface UseNightlyStudyStreamOptions {
  sessionId: string;
  onText: (text: string) => void;
  onMeta: (meta: TurnMeta) => void;
  onPhase: (phase: PhaseEvent) => void;
  onError: (msg: string) => void;
  onEnd: (turnCount: number) => void;
}
```

- [ ] **Step 1-2-2: ref 보관 + 이벤트 파서 분기 추가**

기존 ref 블록(라인 24-33)에 `onPhaseRef` 추가:

```typescript
  const onTextRef = useRef(opts.onText);
  const onMetaRef = useRef(opts.onMeta);
  const onPhaseRef = useRef(opts.onPhase);
  const onErrorRef = useRef(opts.onError);
  const onEndRef = useRef(opts.onEnd);
  useEffect(() => {
    onTextRef.current = opts.onText;
    onMetaRef.current = opts.onMeta;
    onPhaseRef.current = opts.onPhase;
    onErrorRef.current = opts.onError;
    onEndRef.current = opts.onEnd;
  });
```

기존 이벤트 파서 if-else 체인(라인 79-87)에 `phase` 분기 추가:

```typescript
          if (event === 'text') {
            onTextRef.current(typeof payload === 'string' ? payload : (payload as { text?: string }).text || String(payload));
          } else if (event === 'meta') {
            onMetaRef.current(payload as TurnMeta);
          } else if (event === 'phase') {
            onPhaseRef.current(payload as PhaseEvent);
          } else if (event === 'error') {
            onErrorRef.current((payload as { error?: string })?.error || '에러');
          } else if (event === 'end') {
            onEndRef.current((payload as { turnCount?: number })?.turnCount ?? 0);
          }
```

---

## Task 1-3: `session-view`에 phase state + 인디케이터 문구

**Files:**
- Modify: `frontend/src/components/nightly-study/session-view.tsx`

- [ ] **Step 1-3-1: phase state 추가 + onPhase 콜백 배선**

`session-view.tsx` 내부 state 블록(라인 33-44) 아래에 추가:

```typescript
  const [phase, setPhase] = useState<{ phase: string; label: string } | null>(null);
```

`useNightlyStudyStream` 호출(라인 77-90)에 `onPhase` 추가 + `onText`에 phase clear 추가:

```typescript
  const { isStreaming, sendTurn } = useNightlyStudyStream({
    sessionId,
    onText: (text) => {
      setPhase(null);
      setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
    },
    onMeta: (meta) => {
      if (meta.nodeChangedTo) setCurrentTopicLabel(meta.nodeChangedTo.title);
      if (meta.shouldSuggestEnd) setShouldSuggestEnd(true);
    },
    onPhase: (p) => {
      setPhase({ phase: p.phase, label: p.label });
    },
    onError: (msg) => {
      setPhase(null);
      setMessages((prev) => [...prev, { role: 'assistant', content: `⚠ ${msg}` }]);
    },
    onEnd: () => {
      setPhase(null);
    },
  });
```

- [ ] **Step 1-3-2: footer Status Card의 "생각 중..." 카피를 phase 기반으로 교체**

기존 footer(라인 317-363)의 `isStreaming` 분기(라인 336-340)를 phase에 따라 다른 문구를 보여주도록 교체:

```typescript
              ) : isStreaming ? (
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">
                    {phase?.label ?? '생각 중…'}
                  </span>
                </div>
              ) : isListening ? (
                ...
```

phase가 아직 도착 안 한 구간(요청 보내고 첫 phase 이벤트 전)엔 fallback으로 "생각 중..." 유지.

---

## Task 1-4: 수동 검증 + 커밋 1

- [ ] **Step 1-4-1: dev 환경에서 수동 검증**

```bash
# Dev는 이미 기동 중 가정. nginx는 :81에서 리버스 프록시 중.
# backend reload, frontend는 코드 수정 후 자동 HMR.
```

검증 시나리오(`http://localhost:81`):
1. 로그인 → `/nightly-study` → "시작하기"
2. 한 턴 응답 (아무 발화) → footer Card 문구가 "생각 중…" → "답변 준비 중"으로 바뀌는 것 확인 (RAG 호출 턴이면 "지난 대화 살펴보는 중"도 등장)
3. 브라우저 devtools Network 탭에서 `turn` SSE 스트림에 `event: phase` 라인이 실제 포함되어 있는지 raw 확인

실패 시 체크포인트:
- `event: phase`가 안 오면 → `run_turn` yield 지점 확인 + 라우터가 그대로 통과시키는지 확인
- 오는데 UI 안 바뀌면 → `useNightlyStudyStream` 파서의 `event === 'phase'` 분기 확인
- HMR 반영 안 되면 `docker compose up -d --force-recreate frontend`

- [ ] **Step 1-4-2: 커밋**

```bash
git add backend/app/agent/ns_orchestrator.py \
        frontend/src/hooks/useNightlyStudyStream.ts \
        frontend/src/components/nightly-study/session-view.tsx
git commit -m "$(cat <<'EOF'
feat(nightly-study): SSE phase 이벤트 + 프론트 진행 인디케이터

- run_turn에 thinking/retrieving/generating 세 지점 phase emit
- useNightlyStudyStream에 onPhase 콜백 + PhaseEvent 타입
- session-view footer Status Card가 phase.label로 단계별 문구 표시

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# 커밋 2: 재방문 세션 RAG 기반 이어가기 인사 (B)

## Task 2-1: CONTINUATION_GREETING_PROMPT 추가

**Files:**
- Modify: `backend/app/prompts/nightly_study.py`

- [ ] **Step 2-1-1: 파일 말미에 신규 프롬프트 상수 추가**

`backend/app/prompts/nightly_study.py` 끝에 append:

```python
# ------------------------------ 재방문 이어가기 ------------------------------

CONTINUATION_GREETING_PROMPT = """당신은 CS 학습 코치입니다. 유저가 다시 방문했습니다. 아래 맥락을 참고해 자연스러운 음성 인사 1~2문장을 생성하세요.

[지난 세션 요약] {last_session_summary}
[최근 약했던 개념] {weak_nodes}
[관련 기억] {rag_snippets}
[오늘 제안 주제] {target_node}

규칙:
- 반말 + 친근한 톤
- 최대 2문장, 총 60자 내외
- 코드/리스트/마크다운 금지
- "안녕하세요"같은 첫 인사말 금지 (이미 재방문)
- 오늘 제안 주제를 자연스럽게 포함
- 지난 주제나 약점을 한 번만 언급

응답은 순수 텍스트만. JSON이나 따옴표 없이.
"""
```

---

## Task 2-2: `generate_continuation_greeting` 헬퍼 신규 파일

**Files:**
- Create: `backend/app/agent/ns_greeting.py`

- [ ] **Step 2-2-1: 파일 생성 + context 수집 쿼리 + LLM 호출**

`backend/app/agent/ns_greeting.py` 신규 파일:

```python
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm
from app.prompts.nightly_study import CONTINUATION_GREETING_PROMPT
from app.agent.ns_rag import get_query_embedding

logger = logging.getLogger(__name__)

_GREETING_TIMEOUT_SEC = 3.0


async def generate_continuation_greeting(
    db: AsyncSession,
    user_id: str,
    goal_id: str | None,
    target_node: dict | None,
    fallback: str,
) -> str:
    """
    Build a LLM-generated "이어가기" greeting based on past sessions, weak nodes, and RAG hits.
    Returns `fallback` string on any failure / timeout / empty context.
    """
    try:
        ctx = await _collect_context(db, user_id, goal_id, target_node)
        if not ctx["has_anything"]:
            return fallback

        prompt = (
            CONTINUATION_GREETING_PROMPT
            .replace("{last_session_summary}", ctx["last_session_summary"] or "(없음)")
            .replace("{weak_nodes}", ", ".join(ctx["weak_nodes"]) or "(없음)")
            .replace("{rag_snippets}", " / ".join(ctx["rag_snippets"]) or "(없음)")
            .replace("{target_node}", (target_node or {}).get("title") or "(미정)")
        )

        text_out = await asyncio.wait_for(call_llm(prompt), timeout=_GREETING_TIMEOUT_SEC)
        text_out = (text_out or "").strip()
        if not text_out:
            return fallback
        # 한 줄 최대 200자 안전 컷 (프롬프트 위반 시 방어)
        return text_out[:200]
    except asyncio.TimeoutError:
        logger.warning("continuation greeting LLM timed out, using fallback")
        return fallback
    except Exception:
        logger.exception("continuation greeting failed, using fallback")
        return fallback


async def _collect_context(
    db: AsyncSession,
    user_id: str,
    goal_id: str | None,
    target_node: dict | None,
) -> dict:
    # 1) 직전 세션 요약
    last_row = (await db.execute(
        text("""
            SELECT summary FROM learning_sessions
            WHERE user_id=:u AND status='completed' AND summary IS NOT NULL
            ORDER BY ended_at DESC NULLS LAST LIMIT 1
        """),
        {"u": user_id},
    )).one_or_none()
    last_session_summary = last_row.summary if last_row else None

    # 2) 약점 top-3 노드 (최근 7일 중 proficiency 낮은 순)
    weak_rows = (await db.execute(
        text("""
            SELECT cn.title
            FROM node_mastery nm
            JOIN curriculum_nodes cn ON cn.id = nm.node_id
            WHERE nm.user_id=:u
              AND nm.updated_at >= NOW() - INTERVAL '7 days'
            ORDER BY nm.proficiency ASC, nm.updated_at DESC
            LIMIT 3
        """),
        {"u": user_id},
    )).fetchall()
    weak_nodes = [r.title for r in weak_rows]

    # 3) RAG: 오늘의 target 제목으로 top-3 임베딩 검색
    rag_snippets: list[str] = []
    target_title = (target_node or {}).get("title")
    if target_title:
        try:
            emb = await get_query_embedding(target_title)
            rag_rows = (await db.execute(
                text("""
                    SELECT content FROM learning_embeddings
                    WHERE user_id=:u
                    ORDER BY embedding <=> CAST(:q AS vector)
                    LIMIT 3
                """),
                {"u": user_id, "q": str(emb)},
            )).fetchall()
            rag_snippets = [r.content[:120] for r in rag_rows if r.content]
        except Exception:
            logger.exception("RAG fetch in continuation greeting failed; continuing")

    has_anything = bool(last_session_summary or weak_nodes or rag_snippets)
    return {
        "last_session_summary": last_session_summary,
        "weak_nodes": weak_nodes,
        "rag_snippets": rag_snippets,
        "has_anything": has_anything,
    }
```

주의: `get_query_embedding`는 `backend/app/agent/ns_rag.py`에 이미 존재한다는 가정. 이름이 다르면 실제 함수명으로 대체 (`ns_rag.py` 확인 후).

- [ ] **Step 2-2-2: ns_rag.py에서 embedding 함수 실제 이름 확인 + import 보정**

```bash
grep -n "embedding" backend/app/agent/ns_rag.py | head -20
```

`get_query_embedding`이 없으면 있는 함수로 교체. 예: `_embed_text`, `embed_query` 등. 만약 RAG 검색이 `insert_learning_memory` + internal embedding으로만 되어 있다면, 검색 helper 함수(`search_learning_memory(user_id, query, k=3)`)가 이미 있을 수 있으니 그걸 호출. 없으면 위 inline SQL 유지하되 embedding 호출만 교체.

---

## Task 2-3: `start_session` 분기 (첫 세션 vs 재방문)

**Files:**
- Modify: `backend/app/routers/nightly_study.py`

- [ ] **Step 2-3-1: 세션 카운트 조회 + 분기 추가**

`backend/app/routers/nightly_study.py`의 `start_session` 내 첫 메시지 생성 블록(라인 141-160)을 다음으로 교체:

```python
    # 6. Seed the first assistant message
    if initial_mode == "onboarding":
        first_text = (
            "안녕하세요, 저는 CS 학습 어시스트예요. "
            "먼저 간단히 자기소개 부탁드려요. "
            "지금 어떤 일을 하시고 어떤 개발자가 되고 싶은지 편하게 말씀해주세요."
        )
        first_node_id = None
    else:
        fallback_text = (
            f"다시 오셨네요. 오늘은 '{target_node['title']}' 해볼까요?"
            if target_node else "오늘도 시작해볼까요?"
        )
        # 재방문: 과거 completed 세션이 있으면 RAG 기반 이어가기 인사 생성
        past_count_row = (await db.execute(
            text("""
                SELECT COUNT(*) AS c FROM learning_sessions
                WHERE user_id=:u AND status='completed'
            """),
            {"u": user.id},
        )).one()
        past_count = past_count_row.c or 0

        if past_count > 0:
            from app.agent.ns_greeting import generate_continuation_greeting
            first_text = await generate_continuation_greeting(
                db=db,
                user_id=user.id,
                goal_id=goal_id,
                target_node=target_node,
                fallback=fallback_text,
            )
        else:
            first_text = fallback_text

        first_node_id = target_node["id"] if target_node else None

    await db.execute(
        text("""
            INSERT INTO learning_messages (session_id, message_index, role, content, mode, node_id)
            VALUES (:s, 0, 'assistant', :c, :m, :n)
        """),
        {"s": session_id, "c": first_text, "m": initial_mode, "n": first_node_id},
    )
    await db.commit()
```

노트:
- `past_count > 0` 조건으로 **완전한 첫 방문**이면 고정 자기소개 텍스트(onboarding 분기) 또는 learning 분기의 fallback이 그대로 나감.
- onboarding인 유저는 goal이 아직 없으니 여기 분기에 안 들어옴.
- `generate_continuation_greeting`은 내부 실패 시 fallback을 반환하므로 except 불필요.

---

## Task 2-4: 수동 검증 + 커밋 2

- [ ] **Step 2-4-1: dev 환경에서 수동 검증**

시나리오:
1. **첫 세션 (onboarding)** — 신규 유저(또는 `learning_goals` 비어있음)로 시작 → 기존 자기소개 텍스트가 그대로 나옴 확인 (Network 탭에서 `/start` 응답의 `firstMessage` 확인)
2. **2회차 이상 (재방문)** — 같은 유저로 목표 설정 + 최소 1회 완료 세션 보유 상태에서 시작 → `firstMessage`가 `"다시 오셨네요..."` 고정 텍스트가 아니라 LLM 생성 문장인지 확인
3. **Fallback** — `OPENAI_API_KEY`를 임시로 잘못된 값으로 설정 → backend 재시작(`docker compose restart backend && docker compose restart nginx` — 메모리의 nginx DNS 갱신 원칙) → 재방문 시 fallback 고정 텍스트로 돌아가는지 확인 → 복구

- [ ] **Step 2-4-2: 커밋**

```bash
git add backend/app/prompts/nightly_study.py \
        backend/app/agent/ns_greeting.py \
        backend/app/routers/nightly_study.py
git commit -m "$(cat <<'EOF'
feat(nightly-study): 재방문 세션 RAG 기반 이어가기 인사

- CONTINUATION_GREETING_PROMPT 신규
- ns_greeting 모듈: 직전 세션 요약 + 약점 top-3 + RAG top-3 기반 1~2문장 생성
- start_session에서 completed 세션 count>0이면 LLM 인사 사용, 실패 시 기존 고정 텍스트 fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# 커밋 3: 세션 중 목표 변경 감지 + 확인 후 curriculum swap (A)

## Task 3-1: 마이그레이션 — `learning_sessions.pending_action`

**Files:**
- Create: `backend/migrations/2026-04-20-nightly-study-pending-action.sql`

- [ ] **Step 3-1-1: SQL 파일 생성**

`backend/migrations/2026-04-20-nightly-study-pending-action.sql`:

```sql
-- Pending action slot for session-level 2-turn protocols (e.g. goal_change confirm)
ALTER TABLE learning_sessions
  ADD COLUMN IF NOT EXISTS pending_action JSONB NULL;
```

- [ ] **Step 3-1-2: Supabase에서 마이그레이션 실행**

```bash
# Supabase SQL Editor 또는 CLI로 실행
# 루트 .env의 DATABASE_URL을 사용해 psql로 돌려도 됨:
# psql "$DATABASE_URL" -f backend/migrations/2026-04-20-nightly-study-pending-action.sql
```

실행 후 확인:

```sql
\d learning_sessions
-- pending_action jsonb 컬럼이 있어야 함
```

---

## Task 3-2: PlannerOutput 확장 + 프롬프트 업데이트

**Files:**
- Modify: `backend/app/agent/ns_state.py`
- Modify: `backend/app/agent/ns_planner.py`
- Modify: `backend/app/prompts/nightly_study.py`

- [ ] **Step 3-2-1: PlannerOutput TypedDict에 goal_change 필드 추가**

먼저 현재 `ns_state.py`의 `PlannerOutput` 구조를 파악:

```bash
grep -n "PlannerOutput" backend/app/agent/ns_state.py
```

`PlannerOutput` TypedDict에 optional 필드 추가 (기존 구조 유지):

```python
class PlannerOutput(TypedDict, total=False):
    intent: str  # answer | question | pivot | meta | change_goal | confirm
    pivot_target: str | None
    evaluation: dict | None
    next_mode: str
    actions: list[dict]
    should_suggest_end: bool
    briefing_note: str | None
    # 신규
    goal_change_proposed: str | None   # change_goal intent일 때 planner가 추출한 새 목표 텍스트
    goal_change_confirm: bool | None   # pending_action이 있을 때 유저 응답이 긍정/부정인지
```

(정확한 파일 포맷은 현재 `ns_state.py` 본문에 맞춰 조정)

- [ ] **Step 3-2-2: `_validate_planner_output` 업데이트**

`backend/app/agent/ns_planner.py:53-78`의 validator 확장:

```python
def _validate_planner_output(raw: Any) -> PlannerOutput:
    if not isinstance(raw, dict):
        raise ValueError(f"planner did not return dict: {raw}")

    intent = raw.get("intent")
    if intent not in ("answer", "question", "pivot", "meta", "change_goal", "confirm"):
        intent = "meta"

    next_mode = raw.get("next_mode")
    if next_mode not in ("tutoring", "quiz", "socratic", "onboarding"):
        next_mode = "quiz"

    actions = raw.get("actions") or []
    if not isinstance(actions, list):
        actions = []

    gc_proposed = raw.get("goal_change_proposed")
    if not isinstance(gc_proposed, str):
        gc_proposed = None

    gc_confirm = raw.get("goal_change_confirm")
    if gc_confirm not in (True, False):
        gc_confirm = None

    return {
        "intent": intent,
        "pivot_target": raw.get("pivot_target"),
        "evaluation": raw.get("evaluation") if intent == "answer" else None,
        "next_mode": next_mode,
        "actions": actions[:3],
        "should_suggest_end": bool(raw.get("should_suggest_end")),
        "briefing_note": raw.get("briefing_note"),
        "goal_change_proposed": gc_proposed,
        "goal_change_confirm": gc_confirm,
    }
```

- [ ] **Step 3-2-3: `run_planner` 시그니처에 `pending_action` 받기 + 프롬프트에 주입**

`backend/app/agent/ns_planner.py`의 `run_planner`에 `pending_action: dict | None = None` 추가하고 템플릿 변수 주입:

```python
async def run_planner(
    user_utterance: str,
    current_node: dict | None,
    current_mode: str,
    mastery: dict | None,
    recent_messages: list[dict],
    rag_hits: list[dict],
    curriculum_context: dict,
    turn_count: int,
    pending_action: dict | None = None,
) -> PlannerOutput:
    user_prompt = (
        PLANNER_USER_TEMPLATE
        .replace("{current_node_json}", json.dumps(current_node, ensure_ascii=False) if current_node else "null")
        .replace("{current_mode}", current_mode)
        .replace("{mastery_json}", json.dumps(mastery, ensure_ascii=False) if mastery else "null")
        .replace("{rag_hits_json}", json.dumps(rag_hits, ensure_ascii=False))
        .replace("{curriculum_context_json}", json.dumps(curriculum_context, ensure_ascii=False))
        .replace("{turn_count}", str(turn_count))
        .replace("{recent_messages}", _format_recent(recent_messages))
        .replace("{user_utterance}", user_utterance)
        .replace("{pending_action_json}", json.dumps(pending_action, ensure_ascii=False) if pending_action else "null")
    )
    ...
```

- [ ] **Step 3-2-4: PLANNER_SYSTEM_PROMPT + PLANNER_USER_TEMPLATE에 change_goal 블록 추가**

`backend/app/prompts/nightly_study.py`의 `PLANNER_SYSTEM_PROMPT` 안에 "특수 모드: current_mode=onboarding" 블록 바로 아래에 추가:

```
**특수 의도: change_goal (직군/포지션 레벨 목표 변경)**

유저가 "나 ~하려고", "~로 바꿀래", "~직군으로 갈래", "~엔지니어 준비할래" 같이 **직군/포지션 수준의 목표 변경**을 명시적으로 말한 경우만 change_goal:
- intent="change_goal"
- goal_change_proposed="추출한 새 목표 텍스트 (예: 프론트엔드 엔지니어)"
- actions=[{"tool":"propose_goal_change","args":{"new_goal":"..."}}]

주의: "React 좀 해볼까", "이벤트 루프 다시 보고 싶어"같은 주제 단위 전환은 **여전히 pivot_topic** (change_goal 아님).

**특수 상태: pending_action.type == "goal_change"**

위 상태로 세션에 진입하면, 유저의 이번 응답이 직전 턴 확인 질문에 대한 긍정/부정인지 판정:
- 긍정 ("응", "ㅇㅇ", "그래", "좋아", "바꿔줘", "네", "예" 등) → intent="confirm", goal_change_confirm=true, actions=[{"tool":"confirm_goal_change","args":{}}]
- 부정 ("아니", "됐어", "그냥 놔둬", "아니야" 등) → intent="confirm", goal_change_confirm=false, actions=[{"tool":"confirm_goal_change","args":{}}]
- 애매 (목표와 무관한 다른 말) → goal_change_confirm=null, 원래 로직대로 의도 분류
```

`PLANNER_USER_TEMPLATE` 끝에 추가:

```
# Pending action (있으면 위 특수 상태 규칙 적용)
{pending_action_json}
```

- [ ] **Step 3-2-5: JSON 출력 예시에 신규 필드 추가**

PLANNER_SYSTEM_PROMPT 안의 JSON 예시 블록에 두 필드 추가:

```
{{
  "intent": "answer|question|pivot|meta|change_goal|confirm",
  "pivot_target": null,
  "evaluation": {{...}},
  "next_mode": "tutoring|quiz|socratic",
  "actions": [...],
  "should_suggest_end": false,
  "briefing_note": "...",
  "goal_change_proposed": null,
  "goal_change_confirm": null
}}
```

---

## Task 3-3: `tool_propose_goal_change` / `tool_confirm_goal_change` 구현

**Files:**
- Modify: `backend/app/agent/ns_tools.py`

- [ ] **Step 3-3-1: 신규 툴 함수 2개 추가**

파일 끝에 append:

```python
from datetime import datetime, timezone
from app.agent.ns_seed import generate_and_insert_seed, normalize_goal


async def tool_propose_goal_change(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    new_goal: str,
    current_goal_title: str | None,
) -> tuple[str, dict]:
    """
    DB 변경 없이 pending_action만 기록하고 확인 문구 반환.
    Returns (assistant_text, pending_action_dict).
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    pending = {
        "type": "goal_change",
        "proposedGoal": new_goal.strip(),
        "proposedAt": now_iso,
    }
    await db.execute(
        text("UPDATE learning_sessions SET pending_action = CAST(:p AS jsonb) WHERE id=:s"),
        {"p": json.dumps(pending, ensure_ascii=False), "s": session_id},
    )
    current = current_goal_title or "현재 목표"
    reply = (
        f"목표를 '{new_goal.strip()}'로 바꿀까요? "
        f"지금까지 진행한 '{current}' 커리큘럼은 보관되고, 새 목표로 기초부터 다시 시작합니다."
    )
    return reply, pending


async def tool_confirm_goal_change(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    confirm: bool,
    pending_action: dict | None,
) -> tuple[str, dict | None]:
    """
    Returns (assistant_text, node_changed_to_dict_or_None).
    Clears pending_action regardless of confirm result.
    """
    if not pending_action or pending_action.get("type") != "goal_change":
        # stale: clear and bail
        await db.execute(
            text("UPDATE learning_sessions SET pending_action=NULL WHERE id=:s"),
            {"s": session_id},
        )
        return ("네, 계속 이어가죠.", None)

    new_goal_text = (pending_action.get("proposedGoal") or "").strip()

    if not confirm or not new_goal_text:
        await db.execute(
            text("UPDATE learning_sessions SET pending_action=NULL WHERE id=:s"),
            {"s": session_id},
        )
        return ("알겠습니다. 원래 주제 계속 이어가죠.", None)

    # Archive current active goal
    await db.execute(
        text("UPDATE learning_goals SET status='archived' WHERE user_id=:u AND status='active'"),
        {"u": user_id},
    )
    # Insert new active goal
    result = await db.execute(
        text("""
            INSERT INTO learning_goals (user_id, title, normalized_goal, status)
            VALUES (:u, :t, :n, 'active')
            RETURNING id
        """),
        {"u": user_id, "t": new_goal_text, "n": normalize_goal(new_goal_text)},
    )
    new_goal_id = str(result.one().id)

    # Regenerate seed curriculum (sync — user is waiting on this turn)
    try:
        await generate_and_insert_seed(db, new_goal_id, new_goal_text)
    except Exception:
        logger.exception("seed re-generation failed on goal swap")
        # Don't leave user in broken state — revert
        await db.execute(
            text("UPDATE learning_goals SET status='archived' WHERE id=:g"),
            {"g": new_goal_id},
        )
        # Un-archive the previous active (most recently archived)
        await db.execute(
            text("""
                UPDATE learning_goals
                SET status='active'
                WHERE user_id=:u
                  AND id = (
                    SELECT id FROM learning_goals
                    WHERE user_id=:u AND status='archived'
                    ORDER BY updated_at DESC NULLS LAST LIMIT 1
                  )
            """),
            {"u": user_id},
        )
        await db.execute(
            text("UPDATE learning_sessions SET pending_action=NULL WHERE id=:s"),
            {"s": session_id},
        )
        return ("커리큘럼을 다시 만드는 데 실패했어요. 잠시 후 다시 시도해주세요.", None)

    # Pick first seed node as new current
    first_node_row = (await db.execute(
        text("""
            SELECT id, title FROM curriculum_nodes
            WHERE goal_id=:g
            ORDER BY depth_level ASC, title ASC LIMIT 1
        """),
        {"g": new_goal_id},
    )).one_or_none()

    new_node = None
    if first_node_row:
        new_node = {"id": str(first_node_row.id), "title": first_node_row.title}

    # Update session to point at new goal + clear pending
    await db.execute(
        text("""
            UPDATE learning_sessions
            SET goal_id=:g, pending_action=NULL
            WHERE id=:s
        """),
        {"g": new_goal_id, "s": session_id},
    )

    first_title = new_node["title"] if new_node else "새 주제"
    reply = f"좋아요, 목표를 '{new_goal_text}'로 바꿨어요. 먼저 '{first_title}'부터 시작해볼게요."
    return reply, new_node
```

(`json`, `text`, `AsyncSession` import는 기존 파일 상단에서 이미 사용 중 — 없으면 추가)

---

## Task 3-4: `run_turn`에 pending_action 로드/소비 + 신규 툴 분기

**Files:**
- Modify: `backend/app/agent/ns_orchestrator.py`

- [ ] **Step 3-4-1: `_load_turn_state`가 pending_action + goal_title 반환하도록 확장**

`_load_turn_state` (라인 235-378) 내 session row 조회 SQL을 아래로 변경:

```python
    sess_row = (await db.execute(
        text("""
            SELECT user_id, goal_id, turn_count, pending_action
            FROM learning_sessions
            WHERE id=:s AND status='active'
        """),
        {"s": session_id},
    )).one_or_none()
```

반환 dict에 추가:

```python
    return {
        ...기존 필드...,
        "pending_action": sess_row.pending_action if sess_row else None,
    }
```

- [ ] **Step 3-4-2: `run_turn`에서 planner 호출에 pending_action 전달**

```python
    # 3. Run planner
    yield {"type": "phase", "data": {"phase": "thinking", "label": "생각하는 중"}}
    try:
        planner_out = await run_planner(
            user_utterance=user_utterance,
            current_node=state["current_node"],
            current_mode=state["current_mode"],
            mastery=state["mastery"],
            recent_messages=state["recent_messages"],
            rag_hits=[],
            curriculum_context=state["curriculum_context"],
            turn_count=state["turn_count"],
            pending_action=state.get("pending_action"),
        )
```

- [ ] **Step 3-4-3: 신규 툴 분기 + goal_changed_to meta 추가**

`run_turn`의 action 루프(라인 80-182)에 분기 추가 (`pivot_topic` 바로 위쯤):

```python
            elif tool == "propose_goal_change" and planner_out.get("goal_change_proposed"):
                from app.agent.ns_tools import tool_propose_goal_change
                reply, _pending = await tool_propose_goal_change(
                    db=db,
                    session_id=session_id,
                    user_id=user_id,
                    new_goal=planner_out["goal_change_proposed"],
                    current_goal_title=state.get("goal_title"),
                )
                assistant_reply_parts.append(reply)

            elif tool == "confirm_goal_change":
                from app.agent.ns_tools import tool_confirm_goal_change
                confirm = bool(planner_out.get("goal_change_confirm"))
                reply, new_node = await tool_confirm_goal_change(
                    db=db,
                    session_id=session_id,
                    user_id=user_id,
                    confirm=confirm,
                    pending_action=state.get("pending_action"),
                )
                assistant_reply_parts.append(reply)
                if new_node:
                    node_changed_to = new_node
```

- [ ] **Step 3-4-4: meta 이벤트에 `awaitingGoalConfirm` + `goalChangedTo` 추가**

기존 meta yield 블록(라인 207-220) 교체:

```python
    # 8. meta event
    # pending_action은 이미 Tool에서 DB 변경했으므로, 변경된 최신 상태를 다시 읽어 프론트에 반영
    latest_pending_row = (await db.execute(
        text("SELECT pending_action FROM learning_sessions WHERE id=:s"),
        {"s": session_id},
    )).one_or_none()
    latest_pending = latest_pending_row.pending_action if latest_pending_row else None

    awaiting_goal_confirm = None
    if latest_pending and latest_pending.get("type") == "goal_change":
        awaiting_goal_confirm = {"proposedGoal": latest_pending.get("proposedGoal")}

    goal_changed_to = None
    if planner_out.get("intent") == "confirm" and bool(planner_out.get("goal_change_confirm")):
        # confirm_goal_change 툴에서 session.goal_id가 업데이트됨
        g_row = (await db.execute(
            text("""
                SELECT lg.id, lg.title FROM learning_sessions ls
                JOIN learning_goals lg ON lg.id = ls.goal_id
                WHERE ls.id=:s
            """),
            {"s": session_id},
        )).one_or_none()
        if g_row:
            goal_changed_to = {"id": str(g_row.id), "title": g_row.title}

    yield {
        "type": "meta",
        "data": {
            "mode": planner_out["next_mode"],
            "intent": planner_out["intent"],
            "nodeChangedTo": (
                {"id": node_changed_to["id"], "title": node_changed_to["title"]}
                if node_changed_to else None
            ),
            "proficiencyAfter": proficiency_after,
            "shouldSuggestEnd": planner_out["should_suggest_end"],
            "awaitingGoalConfirm": awaiting_goal_confirm,
            "goalChangedTo": goal_changed_to,
        },
    }

    yield {"type": "end", "data": {"turnCount": state["turn_count"] + 1}}
```

---

## Task 3-5: `end_session`에서 pending_action clear

**Files:**
- Modify: `backend/app/routers/nightly_study.py`

- [ ] **Step 3-5-1: 세션 completed UPDATE에 pending_action=NULL 포함**

`end_session`의 UPDATE 문(라인 280-293)에 한 줄 추가:

```python
    await db.execute(
        text("""
            UPDATE learning_sessions
            SET status='completed', ended_at=NOW(),
                summary=:sum, highlights=CAST(:h AS jsonb), voice_briefing=:vb,
                pending_action=NULL
            WHERE id=:s
        """),
        {
            "s": session_id,
            "sum": summary_data["summary"],
            "h": json.dumps(summary_data["highlights"], ensure_ascii=False),
            "vb": summary_data["voice_briefing"],
        },
    )
```

(`auto-close existing active session` 쿼리 라인 59-62는 pending_action clear 불필요 — 세션이 아예 종료되므로.)

---

## Task 3-6: 프론트 TurnMeta 타입 확장 + headline 업데이트

**Files:**
- Modify: `frontend/src/hooks/useNightlyStudyStream.ts`
- Modify: `frontend/src/components/nightly-study/session-view.tsx`

- [ ] **Step 3-6-1: TurnMeta 확장**

`useNightlyStudyStream.ts`의 `TurnMeta` 타입(라인 3-9):

```typescript
export interface TurnMeta {
  mode: string;
  intent: string;
  nodeChangedTo: { id: string; title: string } | null;
  proficiencyAfter: number | null;
  shouldSuggestEnd: boolean;
  awaitingGoalConfirm: { proposedGoal: string } | null;
  goalChangedTo: { id: string; title: string } | null;
}
```

- [ ] **Step 3-6-2: session-view onMeta 핸들러에 goalChangedTo 반영**

`session-view.tsx`의 onMeta(라인 82-85):

```typescript
    onMeta: (meta) => {
      if (meta.nodeChangedTo) setCurrentTopicLabel(meta.nodeChangedTo.title);
      if (meta.goalChangedTo) {
        // 목표가 바뀌면 topic 라벨도 새 노드로 재설정되므로 nodeChangedTo가 따라옴.
        // 별도 토스트/UI는 이번 스코프 외. 필요 시 추가.
      }
      if (meta.shouldSuggestEnd) setShouldSuggestEnd(true);
    },
```

별도 UI 없음. AI 응답 텍스트 자체가 "목표를 바꿨어요..." 로 안내하므로 유저가 인지 가능. `nodeChangedTo`가 자동 따라오므로 currentTopicLabel도 업데이트됨.

---

## Task 3-7: 수동 검증 + 커밋 3

- [ ] **Step 3-7-1: dev 환경 수동 검증 — 6가지 시나리오**

**시나리오 1 — 긍정 flow:**
1. 목표가 "백엔드 엔지니어"로 설정된 유저로 세션 시작
2. 한두 턴 대화 후 "나 프론트엔드로 바꿀래" 발화
3. AI 응답: "목표를 '프론트엔드'로 바꿀까요? 기존 커리큘럼은 보관됩니다." (또는 유사)
4. 이어서 "응" 발화
5. AI 응답: "좋아요, 목표를 '프론트엔드'로 바꿨어요. 먼저 'X'부터 시작해볼게요."
6. DB 확인:
   ```sql
   SELECT title, status FROM learning_goals WHERE user_id='<테스트 user id>';
   -- 백엔드 엔지니어: archived, 프론트엔드: active
   SELECT goal_id, pending_action FROM learning_sessions WHERE id='<session id>';
   -- goal_id는 새 active goal, pending_action은 NULL
   SELECT COUNT(*) FROM curriculum_nodes WHERE goal_id='<새 goal id>';
   -- 8~15개 노드 존재
   ```

**시나리오 2 — 부정 flow:**
1. 목표 변경 요청 후 "아니" 발화
2. AI 응답: "알겠습니다. 원래 주제 계속 이어가죠."
3. DB `learning_sessions.goal_id` 불변, `pending_action` NULL

**시나리오 3 — 주제 언급은 pivot:**
1. "React 잠깐 해볼까" 발화 → change_goal이 아니라 pivot_topic 실행 확인
2. `learning_goals`에는 변화 없음

**시나리오 4 — pending_action stale TTL (manual):**
1. 목표 변경 제안 받은 뒤 6분 대기 → 다른 발화
2. planner가 pending_action의 `proposedAt`을 보고 만료 처리해야 하지만, 스펙상 TTL은 planner 프롬프트 규칙으로 맡김. 검증: 6분 후 "react 궁금해" 발화 시 confirm_goal_change가 아니라 일반 intent로 처리되는지.
   - 주의: 현재 구현은 pending_action이 세션에 남아있으면 planner가 confirm 분기로 갈 수 있음. 프롬프트에 5분 TTL 규칙을 반드시 포함해야 함 (Task 3-2-4 프롬프트에 추가).

**시나리오 5 — 세션 종료 시 clear:**
1. pending_action이 있는 상태로 세션 종료 버튼
2. DB에서 해당 세션 `pending_action` NULL 확인

**시나리오 6 — seed 재생성 실패 시 revert:**
1. OpenAI API를 일시적으로 끊어놓고 긍정 flow 시도
2. AI 응답: "커리큘럼을 다시 만드는 데 실패했어요..."
3. `learning_goals`: 새로 insert된 것이 archived되고, 원래 active가 복구됨 확인

- [ ] **Step 3-7-2: 프롬프트에 5분 TTL 규칙 명시 확인**

Task 3-2-4에서 작성한 `PLANNER_SYSTEM_PROMPT`의 pending_action 블록에 다음 줄이 포함되어 있는지 점검하고 없으면 추가:

```
- pending_action.proposedAt이 **5분 이상 경과**했다면 무시 (goal_change_confirm=null로 처리, 일반 intent 판정).
```

- [ ] **Step 3-7-3: 커밋**

```bash
git add backend/migrations/2026-04-20-nightly-study-pending-action.sql \
        backend/app/agent/ns_state.py \
        backend/app/agent/ns_planner.py \
        backend/app/agent/ns_orchestrator.py \
        backend/app/agent/ns_tools.py \
        backend/app/prompts/nightly_study.py \
        backend/app/routers/nightly_study.py \
        frontend/src/hooks/useNightlyStudyStream.ts \
        frontend/src/components/nightly-study/session-view.tsx
git commit -m "$(cat <<'EOF'
feat(nightly-study): 세션 중 목표 변경 감지 + 확인 후 curriculum swap

- 마이그레이션: learning_sessions.pending_action JSONB 컬럼 추가
- planner 프롬프트에 change_goal intent + pending_action confirm 분기 + 5분 TTL
- tool_propose_goal_change / tool_confirm_goal_change (archive + seed 재생성 + session goal_id swap, 실패 시 revert)
- SSE meta에 awaitingGoalConfirm / goalChangedTo 추가, 프론트 TurnMeta 확장
- end_session에서 pending_action NULL 처리

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Self-Review 완료 체크리스트

스펙 대비 누락 확인:

- [x] 이슈 ① phase 이벤트 3 단계 — Task 1-1
- [x] 프론트 phase state + 인디케이터 — Task 1-2, 1-3
- [x] 이슈 ② 첫 세션 vs 재방문 분기 — Task 2-3
- [x] context 수집 (summary + weak_nodes + RAG) — Task 2-2
- [x] CONTINUATION_GREETING_PROMPT — Task 2-1
- [x] LLM 실패 시 fallback — Task 2-2 (`_GREETING_TIMEOUT_SEC` + except)
- [x] 이슈 ③ planner intent change_goal / confirm — Task 3-2
- [x] propose_goal_change 툴 (DB 미변경, pending 기록) — Task 3-3
- [x] confirm_goal_change 툴 (archive + seed + goal_id swap) — Task 3-3
- [x] seed 실패 시 revert — Task 3-3
- [x] pending_action 컬럼 마이그레이션 — Task 3-1
- [x] end_session에서 pending_action clear — Task 3-5
- [x] 5분 TTL은 planner 프롬프트 규칙으로 — Task 3-2-4, 3-7-2
- [x] 프론트 TurnMeta 확장 — Task 3-6

각 task 끝에 수동 검증 시나리오 포함, 커밋 단위 분리 명확.
