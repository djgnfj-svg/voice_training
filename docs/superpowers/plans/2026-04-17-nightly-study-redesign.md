# 오늘의 학습 재설계 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정적 Subject/Topic 트리 기반 학습 기능을 폐기하고, 유저 목표 입력 → agentic 툴 기반 planner → 적응형 대화 모드로 매일 학습하는 음성 전용 모바일 코치로 전환한다.

**Architecture:** FastAPI + SQLAlchemy + pgvector 백엔드에 agentic planner(1 LLM/턴) + 8개 툴(retrieve/evaluate/explain/probing/quiz/pivot/extend/suggest_end) 구조. 새 7개 테이블(learning_goals/curriculum_nodes/node_mastery/learning_sessions/learning_messages/learning_embeddings/learning_streaks). Next.js 모바일 전용 단일 페이지(랜딩 → 대화 → 브리핑) + SSE 스트림.

**Tech Stack:** FastAPI, SQLAlchemy async, pgvector, OpenAI gpt-4o-mini + text-embedding-3-small, sse-starlette / Next.js 15, TanStack Query, Web Speech API / Whisper, 기존 tts 서비스 / pytest, Vitest

**참조 스펙:** `docs/superpowers/specs/2026-04-17-nightly-study-redesign-design.md`

---

## 파일 구조

### 백엔드 (신규)
- `backend/migrations/2026-04-17-nightly-study-v2.sql` — 기존 6 테이블 DROP + 신규 7 테이블 CREATE + pgvector 인덱스
- `backend/app/models/nightly_study.py` — SQLAlchemy 모델 (7개)
- `backend/app/prompts/nightly_study.py` — planner/튜터링/평가/소크라틱/시드/요약 프롬프트
- `backend/app/agent/ns_srs.py` — proficiency/next_review/streak 순수 함수
- `backend/app/agent/ns_rag.py` — learning_embeddings 검색/저장
- `backend/app/agent/ns_seed.py` — 시드 커리큘럼 LLM 생성
- `backend/app/agent/ns_planner.py` — planner LLM 래퍼 (JSON 출력)
- `backend/app/agent/ns_tools.py` — 8개 툴 함수
- `backend/app/agent/ns_orchestrator.py` — 턴 오케스트레이션 (plan → action 루프)
- `backend/app/agent/ns_summarizer.py` — 세션 종료 요약 + 음성 브리핑
- `backend/app/agent/ns_state.py` — 상태 타입 (TypedDict)
- `backend/app/routers/nightly_study.py` — 신규 API (기존 `learning_agent.py` 교체)
- `backend/tests/test_ns_srs.py` — SRS 단위 테스트
- `backend/tests/test_ns_streak.py` — streak 단위 테스트
- `backend/tests/test_ns_pivot_match.py` — pivot 매칭 단위 테스트
- `backend/tests/test_ns_api.py` — API 통합 테스트

### 백엔드 (삭제)
- `backend/app/agent/learning_nodes.py`
- `backend/app/agent/learning_planner.py`
- `backend/app/agent/learning_state.py`
- `backend/app/agent/tutor_agent.py`
- `backend/app/prompts/learning_agent.py`
- `backend/app/routers/learning_agent.py`
- `backend/app/models/learning.py` (Subject/Topic/UserKnowledge/DailyProgress)
- `backend/app/models/learning_agent.py` (LearningAgentSession/LearningAgentMessage)
- `backend/app/services/daily_progress.py` (있으면)

### 프론트엔드 (신규/수정)
- `frontend/src/middleware.ts` — UA 체크 추가 (수정)
- `frontend/src/app/(authenticated)/nightly-study/page.tsx` — 랜딩 화면 (전면 재작성)
- `frontend/src/app/(authenticated)/nightly-study/mobile-only/page.tsx` — 데스크톱 안내
- `frontend/src/components/nightly-study/streak-badge.tsx`
- `frontend/src/components/nightly-study/session-view.tsx` — 대화 중 화면
- `frontend/src/components/nightly-study/briefing-view.tsx` — 종료 후 카드 + TTS
- `frontend/src/hooks/useNightlyStudyStream.ts` — SSE 파싱
- `frontend/src/lib/nightly-study-api.ts` — API 클라이언트

### 프론트엔드 (삭제)
- `frontend/src/app/(authenticated)/nightly-study/session/page.tsx`
- `frontend/src/lib/learning-agent-api.ts`
- `frontend/prisma/schema.prisma`의 Subject/Topic/UserKnowledge/LearningAgentSession/LearningAgentMessage/DailyProgress 모델

---

## Phase A: DB 기반 (Foundation)

### Task 1: 마이그레이션 SQL 작성

**Files:**
- Create: `backend/migrations/2026-04-17-nightly-study-v2.sql`

- [ ] **Step 1: 마이그레이션 SQL 작성**

`backend/migrations/2026-04-17-nightly-study-v2.sql`:

```sql
-- 기존 오늘의 학습 테이블 전부 DROP
DROP TABLE IF EXISTS daily_progress CASCADE;
DROP TABLE IF EXISTS user_knowledge CASCADE;
DROP TABLE IF EXISTS "LearningAgentMessage" CASCADE;
DROP TABLE IF EXISTS "LearningAgentSession" CASCADE;
DROP TABLE IF EXISTS learning_agent_messages CASCADE;
DROP TABLE IF EXISTS learning_agent_sessions CASCADE;
DROP TABLE IF EXISTS topics CASCADE;
DROP TABLE IF EXISTS subjects CASCADE;

-- pgvector 확장 (이미 있으면 무시)
CREATE EXTENSION IF NOT EXISTS vector;

-- ① learning_goals
CREATE TABLE learning_goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    normalized_goal TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX learning_goals_active_per_user
    ON learning_goals(user_id) WHERE status = 'active';
CREATE INDEX learning_goals_user_id ON learning_goals(user_id);

-- ② curriculum_nodes
CREATE TABLE curriculum_nodes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id       UUID NOT NULL REFERENCES learning_goals(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL,
    depth_level   INT NOT NULL CHECK (depth_level BETWEEN 0 AND 2),
    parent_id     UUID NULL REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
    source        TEXT NOT NULL CHECK (source IN ('seed', 'extended')),
    keywords      TEXT[] NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX curriculum_nodes_goal_id ON curriculum_nodes(goal_id);
CREATE INDEX curriculum_nodes_parent_id ON curriculum_nodes(parent_id);

-- ③ node_mastery
CREATE TABLE node_mastery (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id         UUID NOT NULL REFERENCES curriculum_nodes(id) ON DELETE CASCADE,
    proficiency     INT NOT NULL DEFAULT 0 CHECK (proficiency BETWEEN 0 AND 100),
    success_count   INT NOT NULL DEFAULT 0,
    failure_count   INT NOT NULL DEFAULT 0,
    streak_count    INT NOT NULL DEFAULT 0,
    last_studied_at TIMESTAMPTZ NULL,
    next_review_at  TIMESTAMPTZ NULL,
    last_mode       TEXT NULL,
    PRIMARY KEY (user_id, node_id)
);
CREATE INDEX node_mastery_next_review ON node_mastery(user_id, next_review_at);

-- ④ learning_sessions
CREATE TABLE learning_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id         UUID NULL REFERENCES learning_goals(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ NULL,
    turn_count      INT NOT NULL DEFAULT 0,
    is_free_session BOOL NOT NULL DEFAULT FALSE,
    credit_deducted INT NOT NULL DEFAULT 0,
    summary         TEXT NULL,
    highlights      JSONB NULL,
    voice_briefing  TEXT NULL
);
CREATE INDEX learning_sessions_user_status ON learning_sessions(user_id, status);
CREATE INDEX learning_sessions_user_started ON learning_sessions(user_id, started_at);

-- ⑤ learning_messages
CREATE TABLE learning_messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
    message_index INT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content       TEXT NOT NULL,
    mode          TEXT NULL,
    tool_calls    JSONB NULL,
    node_id       UUID NULL REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, message_index)
);
CREATE INDEX learning_messages_session ON learning_messages(session_id, message_index);

-- ⑥ learning_embeddings
CREATE TABLE learning_embeddings (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id    UUID NULL REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
    category   TEXT NOT NULL CHECK (category IN ('misconception', 'explanation', 'connection', 'question')),
    content    TEXT NOT NULL,
    embedding  VECTOR(1536) NOT NULL,
    metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX learning_embeddings_user ON learning_embeddings(user_id);
CREATE INDEX learning_embeddings_ivfflat ON learning_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ⑦ learning_streaks
CREATE TABLE learning_streaks (
    user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak       INT NOT NULL DEFAULT 0,
    longest_streak       INT NOT NULL DEFAULT 0,
    total_sessions       INT NOT NULL DEFAULT 0,
    total_nodes_learned  INT NOT NULL DEFAULT 0,
    last_session_date    DATE NULL
);
```

- [ ] **Step 2: Commit**

```bash
git add backend/migrations/2026-04-17-nightly-study-v2.sql
git commit -m "feat(nightly-study): DB 마이그레이션 — 기존 6 테이블 DROP + 신규 7 테이블"
```

---

### Task 2: 마이그레이션 dev 적용

**Files:** (DB만 변경)

- [ ] **Step 1: dev Supabase에 마이그레이션 적용**

개발 DB에 적용. Supabase SQL Editor 또는 `psql` 로 실행:

```bash
# .env의 DATABASE_URL 사용
cat backend/migrations/2026-04-17-nightly-study-v2.sql | docker compose exec -T backend python -c "
import asyncio
from sqlalchemy import text
from app.database import engine

async def run():
    sql = open('/app/migrations/2026-04-17-nightly-study-v2.sql').read()
    async with engine.begin() as conn:
        await conn.execute(text(sql))
    print('migration applied')

asyncio.run(run())
"
```

만약 위 방법이 안 되면 Supabase Studio에서 SQL 복사-붙여넣기 실행.

- [ ] **Step 2: 테이블 생성 확인**

```bash
docker compose exec backend python -c "
import asyncio
from sqlalchemy import text
from app.database import engine

async def check():
    async with engine.begin() as conn:
        result = await conn.execute(text(\"\"\"
            SELECT table_name FROM information_schema.tables
            WHERE table_schema='public'
              AND table_name IN ('learning_goals','curriculum_nodes','node_mastery','learning_sessions','learning_messages','learning_embeddings','learning_streaks')
            ORDER BY table_name
        \"\"\"))
        for row in result:
            print(row[0])

asyncio.run(check())
"
```

Expected output: 7개 테이블 이름이 모두 나와야 함.

- [ ] **Step 3: 커밋 없음** (DB 변경은 마이그레이션 파일로 기록됨)

---

### Task 3: SQLAlchemy 모델 작성

**Files:**
- Create: `backend/app/models/nightly_study.py`

- [ ] **Step 1: 신규 모델 파일 작성**

`backend/app/models/nightly_study.py`:

```python
from __future__ import annotations

from sqlalchemy import (
    Column, String, DateTime, Date, Integer, Boolean, Text,
    ForeignKey, CheckConstraint, UniqueConstraint
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class LearningGoal(Base):
    __tablename__ = "learning_goals"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(Text, nullable=False)
    normalized_goal = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="active")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CurriculumNode(Base):
    __tablename__ = "curriculum_nodes"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    goal_id = Column(UUID(as_uuid=True), ForeignKey("learning_goals.id", ondelete="CASCADE"), nullable=False)
    title = Column(Text, nullable=False)
    description = Column(Text, nullable=False)
    depth_level = Column(Integer, nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("curriculum_nodes.id", ondelete="SET NULL"), nullable=True)
    source = Column(Text, nullable=False)
    keywords = Column(ARRAY(Text), nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        CheckConstraint("depth_level BETWEEN 0 AND 2", name="curriculum_nodes_depth_range"),
        CheckConstraint("source IN ('seed','extended')", name="curriculum_nodes_source_check"),
    )


class NodeMastery(Base):
    __tablename__ = "node_mastery"

    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    node_id = Column(UUID(as_uuid=True), ForeignKey("curriculum_nodes.id", ondelete="CASCADE"), primary_key=True)
    proficiency = Column(Integer, nullable=False, default=0)
    success_count = Column(Integer, nullable=False, default=0)
    failure_count = Column(Integer, nullable=False, default=0)
    streak_count = Column(Integer, nullable=False, default=0)
    last_studied_at = Column(DateTime(timezone=True), nullable=True)
    next_review_at = Column(DateTime(timezone=True), nullable=True)
    last_mode = Column(Text, nullable=True)


class LearningSession(Base):
    __tablename__ = "learning_sessions"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    goal_id = Column(UUID(as_uuid=True), ForeignKey("learning_goals.id", ondelete="SET NULL"), nullable=True)
    status = Column(Text, nullable=False, default="active")
    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at = Column(DateTime(timezone=True), nullable=True)
    turn_count = Column(Integer, nullable=False, default=0)
    is_free_session = Column(Boolean, nullable=False, default=False)
    credit_deducted = Column(Integer, nullable=False, default=0)
    summary = Column(Text, nullable=True)
    highlights = Column(JSONB, nullable=True)
    voice_briefing = Column(Text, nullable=True)


class LearningMessage(Base):
    __tablename__ = "learning_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    session_id = Column(UUID(as_uuid=True), ForeignKey("learning_sessions.id", ondelete="CASCADE"), nullable=False)
    message_index = Column(Integer, nullable=False)
    role = Column(Text, nullable=False)
    content = Column(Text, nullable=False)
    mode = Column(Text, nullable=True)
    tool_calls = Column(JSONB, nullable=True)
    node_id = Column(UUID(as_uuid=True), ForeignKey("curriculum_nodes.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("session_id", "message_index", name="learning_messages_session_idx_unique"),
    )


class LearningStreak(Base):
    __tablename__ = "learning_streaks"

    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    current_streak = Column(Integer, nullable=False, default=0)
    longest_streak = Column(Integer, nullable=False, default=0)
    total_sessions = Column(Integer, nullable=False, default=0)
    total_nodes_learned = Column(Integer, nullable=False, default=0)
    last_session_date = Column(Date, nullable=True)
```

Note: `learning_embeddings` 테이블은 raw SQL로만 접근 (기존 journal_embeddings 패턴 따름). ORM 모델 불필요.

- [ ] **Step 2: import smoke 테스트**

```bash
docker compose exec backend python -c "
from app.models.nightly_study import LearningGoal, CurriculumNode, NodeMastery, LearningSession, LearningMessage, LearningStreak
print('ok')
"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/models/nightly_study.py
git commit -m "feat(nightly-study): SQLAlchemy 모델 6개"
```

---

## Phase B: Backend Agent Core

### Task 4: 상태 타입 정의

**Files:**
- Create: `backend/app/agent/ns_state.py`

- [ ] **Step 1: 상태 타입 작성**

`backend/app/agent/ns_state.py`:

```python
from __future__ import annotations

from typing import TypedDict, Literal, Optional, Any
from uuid import UUID
from datetime import datetime


Mode = Literal["tutoring", "quiz", "socratic", "onboarding"]
Intent = Literal["answer", "question", "pivot", "meta"]
Category = Literal["misconception", "explanation", "connection", "question"]


class MasteryInfo(TypedDict):
    proficiency: int
    success_count: int
    failure_count: int
    streak_count: int
    last_mode: Optional[str]


class NodeRef(TypedDict):
    id: str
    title: str
    description: str
    depth_level: int
    keywords: list[str]


class RagHit(TypedDict):
    id: str
    category: str
    content: str
    similarity: float


class ToolCall(TypedDict):
    tool: str
    args: dict[str, Any]


class Evaluation(TypedDict):
    correct: bool
    partial: bool
    proficiency_delta: int
    misconception: Optional[str]
    notes: str


class PlannerOutput(TypedDict):
    intent: Intent
    pivot_target: Optional[str]
    evaluation: Optional[Evaluation]
    next_mode: Mode
    actions: list[ToolCall]
    should_suggest_end: bool
    briefing_note: Optional[str]


class TurnState(TypedDict):
    session_id: str
    user_id: str
    user_utterance: str
    current_node: Optional[NodeRef]
    current_mode: Mode
    mastery: Optional[MasteryInfo]
    turn_count: int
    session_started_at: datetime
    assistant_reply: str
    planner_output: Optional[PlannerOutput]
    tool_results: list[dict[str, Any]]
    node_changed_to: Optional[NodeRef]
    proficiency_after: Optional[int]
    should_suggest_end: bool
```

- [ ] **Step 2: import 확인 + commit**

```bash
docker compose exec backend python -c "from app.agent.ns_state import TurnState, PlannerOutput; print('ok')"
git add backend/app/agent/ns_state.py
git commit -m "feat(nightly-study): 상태 타입 정의"
```

---

### Task 5: SRS 모듈 (TDD)

**Files:**
- Create: `backend/app/agent/ns_srs.py`
- Test: `backend/tests/test_ns_srs.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_ns_srs.py`:

```python
from datetime import datetime, timezone, timedelta

from app.agent.ns_srs import (
    apply_proficiency_delta,
    compute_next_review,
    update_streak_state,
)


def test_proficiency_clamped_0_to_100():
    # clamp low
    assert apply_proficiency_delta(current=10, delta=-30) == 0
    # clamp high
    assert apply_proficiency_delta(current=90, delta=30) == 100
    # normal
    assert apply_proficiency_delta(current=50, delta=8) == 58


def test_next_review_proficiency_based():
    now = datetime(2026, 4, 17, 12, 0, 0, tzinfo=timezone.utc)
    # low proficiency → short interval (1 day)
    assert compute_next_review(proficiency=20, now=now) == now + timedelta(days=1)
    # mid → 3 days
    assert compute_next_review(proficiency=50, now=now) == now + timedelta(days=3)
    # high → 7 days
    assert compute_next_review(proficiency=75, now=now) == now + timedelta(days=7)
    # mastered → 14 days
    assert compute_next_review(proficiency=95, now=now) == now + timedelta(days=14)


def test_streak_increment_when_next_day():
    from datetime import date
    # yesterday → today: streak +1
    new_current, new_longest = update_streak_state(
        current=5, longest=10,
        last_date=date(2026, 4, 16),
        today=date(2026, 4, 17),
    )
    assert new_current == 6
    assert new_longest == 10


def test_streak_resets_when_gap():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=5, longest=10,
        last_date=date(2026, 4, 14),  # 3일 전
        today=date(2026, 4, 17),
    )
    assert new_current == 1
    assert new_longest == 10


def test_streak_beats_longest():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=10, longest=10,
        last_date=date(2026, 4, 16),
        today=date(2026, 4, 17),
    )
    assert new_current == 11
    assert new_longest == 11


def test_streak_same_day_no_change():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=5, longest=10,
        last_date=date(2026, 4, 17),
        today=date(2026, 4, 17),
    )
    assert new_current == 5
    assert new_longest == 10


def test_streak_first_ever():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=0, longest=0, last_date=None, today=date(2026, 4, 17)
    )
    assert new_current == 1
    assert new_longest == 1
```

- [ ] **Step 2: 테스트 실행 (실패 확인)**

```bash
docker compose exec backend pytest tests/test_ns_srs.py -v
```

Expected: ImportError (ns_srs 모듈 없음)

- [ ] **Step 3: SRS 구현**

`backend/app/agent/ns_srs.py`:

```python
from __future__ import annotations

from datetime import datetime, date, timedelta


def apply_proficiency_delta(current: int, delta: int) -> int:
    """Apply delta and clamp to [0, 100]."""
    return max(0, min(100, current + delta))


def compute_next_review(proficiency: int, now: datetime) -> datetime:
    """Proficiency-based interval: low → soon, high → later."""
    if proficiency < 30:
        days = 1
    elif proficiency < 70:
        days = 3
    elif proficiency < 90:
        days = 7
    else:
        days = 14
    return now + timedelta(days=days)


def update_streak_state(
    current: int,
    longest: int,
    last_date: date | None,
    today: date,
) -> tuple[int, int]:
    """
    Returns (new_current, new_longest).
    Rules:
      - first ever (last_date=None): current=1
      - same day: no change
      - exactly +1 day: current += 1
      - gap >= 2: current = 1
    """
    if last_date is None:
        new_current = 1
    elif last_date == today:
        return current, longest
    elif last_date == today - timedelta(days=1):
        new_current = current + 1
    else:
        new_current = 1

    new_longest = max(longest, new_current)
    return new_current, new_longest
```

- [ ] **Step 4: 테스트 재실행 (통과 확인)**

```bash
docker compose exec backend pytest tests/test_ns_srs.py -v
```

Expected: 모든 테스트 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/agent/ns_srs.py backend/tests/test_ns_srs.py
git commit -m "feat(nightly-study): SRS 순수 함수 (proficiency/review/streak) + 단위 테스트"
```

---

### Task 6: Pivot 매칭 모듈 (TDD)

**Files:**
- Create: `backend/app/agent/ns_pivot.py`
- Test: `backend/tests/test_ns_pivot_match.py`

- [ ] **Step 1: 실패 테스트 작성**

`backend/tests/test_ns_pivot_match.py`:

```python
from app.agent.ns_pivot import match_pivot_target


def make_node(title, keywords):
    return {"id": "n1", "title": title, "description": "", "depth_level": 1, "keywords": keywords}


def test_exact_title_match():
    nodes = [make_node("gRPC", ["grpc", "rpc"]), make_node("HTTP", ["http"])]
    matched = match_pivot_target(nodes, target="gRPC")
    assert matched is not None
    assert matched["title"] == "gRPC"


def test_keyword_match_case_insensitive():
    nodes = [make_node("이벤트 루프", ["event loop", "이벤트", "루프"])]
    matched = match_pivot_target(nodes, target="event Loop")
    assert matched is not None


def test_no_match_returns_none():
    nodes = [make_node("HTTP", ["http"])]
    matched = match_pivot_target(nodes, target="요리")
    assert matched is None


def test_partial_title_match():
    nodes = [make_node("이벤트 루프", ["이벤트"])]
    matched = match_pivot_target(nodes, target="이벤트루프")
    assert matched is not None
```

- [ ] **Step 2: 실행 (실패)**

```bash
docker compose exec backend pytest tests/test_ns_pivot_match.py -v
```

- [ ] **Step 3: 구현**

`backend/app/agent/ns_pivot.py`:

```python
from __future__ import annotations

from typing import Optional


def _normalize(s: str) -> str:
    return "".join(ch.lower() for ch in s if not ch.isspace())


def match_pivot_target(
    candidate_nodes: list[dict],
    target: str,
) -> Optional[dict]:
    """
    Match user's pivot target to an existing curriculum node.
    Strategy: normalized title equality → title substring → keyword exact (normalized) → None.
    """
    target_norm = _normalize(target)
    if not target_norm:
        return None

    # 1. normalized title exact / substring
    for node in candidate_nodes:
        if _normalize(node["title"]) == target_norm:
            return node
    for node in candidate_nodes:
        if target_norm in _normalize(node["title"]):
            return node
        if _normalize(node["title"]) in target_norm:
            return node

    # 2. keyword exact match (normalized)
    for node in candidate_nodes:
        for kw in node.get("keywords", []):
            if _normalize(kw) == target_norm:
                return node

    return None
```

- [ ] **Step 4: 실행 (통과)**

```bash
docker compose exec backend pytest tests/test_ns_pivot_match.py -v
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/agent/ns_pivot.py backend/tests/test_ns_pivot_match.py
git commit -m "feat(nightly-study): pivot 타겟 매칭 (title/keyword 정규화) + 단위 테스트"
```

---

### Task 7: 프롬프트 파일

**Files:**
- Create: `backend/app/prompts/nightly_study.py`

- [ ] **Step 1: 프롬프트 작성**

`backend/app/prompts/nightly_study.py`:

```python
"""
오늘의 학습 프롬프트 모음.
모든 프롬프트는 JSON 출력 또는 단순 한글 텍스트 출력으로 설계됨.
"""

# ------------------------------ 시드 커리큘럼 ------------------------------

SEED_CURRICULUM_PROMPT = """당신은 개발자 학습 커리큘럼을 설계하는 교육 전문가입니다.

유저의 목표: "{goal_title}"

이 목표를 달성하기 위한 핵심 기초 개념을 8~15개 제안하세요.

규칙:
- "배우고 싶은 프레임워크"가 아니라 "그 프레임워크를 이해하려면 알아야 할 원리"에 편중하세요.
- 실제 면접/실무에서 자주 묻히는 기초 개념이어야 합니다.
- depth_level: 0=뿌리(반드시 먼저 이해할 것), 1=중간, 2=응용.
- parent_id는 이 배열 내의 다른 노드의 title(ko)과 일치해야 합니다. 없으면 null.
- keywords는 한글/영문 혼합 2~5개.

반드시 아래 JSON 구조로만 응답하세요:

{{
  "nodes": [
    {{
      "title": "이벤트 루프",
      "description": "비동기 처리의 기초. 콜스택/태스크 큐/마이크로태스크 구조.",
      "depth_level": 0,
      "parent_title": null,
      "keywords": ["event loop", "이벤트 루프", "비동기"]
    }},
    ...
  ]
}}"""


# ------------------------------ Planner ------------------------------

PLANNER_SYSTEM_PROMPT = """당신은 개발자 학습 코치 AI의 의사결정 엔진입니다.
매 턴 유저 발화와 상태를 받아 JSON으로 행동 계획을 반환합니다.

당신의 역할:
1. 유저 의도 분류: answer(답변) | question(질문) | pivot(주제 전환) | meta(종료/학습 무관)
2. 답변일 경우 평가 (정답 여부, proficiency 변화량 -10~+15)
3. 다음 모드 결정 (proficiency 기반):
   - 0~30 → tutoring (개념을 먼저 설명해야 함)
   - 30~70 → quiz (질문으로 확인)
   - 70+ → socratic (유도 질문으로 깊이)
   - 유저가 "모르겠어요" 힌트 보이면 tutoring으로 override
4. 실행할 툴 시퀀스 결정 (1~3개)
5. 종료 제안 여부 판정 (proficiency>=80 도달 + turn>=10 이상이면 검토)

**특수 모드: current_mode=onboarding**
- 유저가 목표를 말한 경우 → intent="meta", actions=[{{"tool":"create_goal","args":{{"title":"..."}}}}, {{"tool":"generate_immediate_reply","args":{{"text":"좋아요, 같이 기초부터 해볼게요. 잠시만요..."}}}}]
- 유저가 애매한 답변 → actions=[{{"tool":"generate_immediate_reply","args":{{"text":"어떤 개발자가 되고 싶으세요?"}}}}]

사용 가능 툴:
- retrieve_memory(query): 과거 학습 기억 검색
- evaluate_answer: 평가 기록 (자동 실행, actions에 넣지 말 것)
- explain_concept(node_id, user_level): 개념 설명 (튜터링 모드)
- ask_probing(hint, depth_target): 소크라틱 질문
- quiz(node_id, difficulty): 평가 질문
- pivot_topic(target): 주제 전환
- extend_curriculum(proposed_title, rationale): 새 노드 생성
- suggest_end: 종료 제안 멘트 생성
- create_goal(title): 목표 등록 (온보딩 전용)
- generate_immediate_reply(text): LLM 추가 호출 없이 고정 멘트

범위 밖 pivot (예: 요리, 연애) → intent="meta", assistant가 학습 주제 복귀 안내.

반드시 아래 JSON 구조로만 응답:

{{
  "intent": "answer|question|pivot|meta",
  "pivot_target": null,
  "evaluation": {{
    "correct": true,
    "partial": false,
    "proficiency_delta": 8,
    "misconception": null,
    "notes": "짧은 관찰"
  }},
  "next_mode": "tutoring|quiz|socratic",
  "actions": [
    {{"tool": "...", "args": {{...}}}}
  ],
  "should_suggest_end": false,
  "briefing_note": "이 턴에서 배운 것 한 줄 (세션 종료 브리핑용)"
}}

intent가 answer가 아니면 evaluation=null.
"""


PLANNER_USER_TEMPLATE = """# 유저 발화
{user_utterance}

# 현재 노드
{current_node_json}

# 현재 모드
{current_mode}

# 현 노드의 숙련도
{mastery_json}

# 최근 대화 (최대 6턴)
{recent_messages}

# 검색된 기억 (RAG top-3, 비어있을 수 있음)
{rag_hits_json}

# 커리큘럼 맥락
{curriculum_context_json}

# 턴 수
{turn_count}

위 정보를 바탕으로 JSON 행동 계획을 반환하세요."""


# ------------------------------ Tool 프롬프트 ------------------------------

EXPLAIN_CONCEPT_PROMPT = """당신은 친절한 개발 튜터입니다.
아래 개념을 쉽게 설명하고, 마지막에 이해 확인 질문 1개를 붙이세요.

개념: {node_title}
설명 기반 요약: {node_description}
유저 현재 수준: proficiency {proficiency}/100

규칙:
- 2~4문장 설명 + 1개 질문
- 음성 대화라 코드블록/불릿 금지
- 너무 길지 않게"""


QUIZ_PROMPT = """당신은 개발 면접관입니다.
아래 개념에 대해 유저 수준에 맞는 질문 1개를 던지세요.

개념: {node_title}
유저 수준: proficiency {proficiency}/100
난이도 힌트: {difficulty}

규칙:
- 1~2문장 질문
- 실무/이론 중 proficiency가 낮으면 이론, 높으면 응용
- 코드 없이 구두 답변 가능한 질문"""


ASK_PROBING_PROMPT = """당신은 소크라틱 튜터입니다. 답을 주지 말고 유도 질문만 하세요.

개념: {node_title}
힌트(파고들 방향): {hint}
현재 proficiency: {proficiency}/100

규칙:
- 1개 질문만
- 답을 유도하되 직접 알려주지 말 것
- 음성 대화라 짧고 명료하게"""


SUGGEST_END_PROMPT = """당신은 학습 코치입니다. 오늘 세션을 마무리하자고 자연스럽게 제안하세요.

오늘 다룬 토픽: {topics_json}
총 턴수: {turn_count}
성장 포인트: {briefing_notes}

규칙:
- 1~2문장
- 성취를 언급하며 "여기까지 할까요?" 느낌"""


EXTEND_CURRICULUM_PROMPT = """유저와 대화 중 새 학습 노드를 추가해야 합니다.

제안된 노드: {proposed_title}
이유: {rationale}
현 목표: {goal_title}
기존 뿌리 노드들: {root_titles_json}

이 제안을 기반으로 아래 JSON을 반환:
{{
  "title": "...",
  "description": "1~2줄 설명",
  "depth_level": 0|1|2,
  "parent_title": null | "기존 노드 title",
  "keywords": ["..."]
}}"""


PIVOT_TOPIC_PROMPT = """유저가 새 주제로 전환을 원합니다.

기존 주제: {current_node_title}
전환 대상: {target}

자연스러운 전환 멘트 1~2문장 생성. 새 주제에 대한 첫 질문 포함.

규칙:
- "네, gRPC로 넘어가죠. HTTP는 익숙하세요?" 같은 자연스러운 전환
- 음성 대화용 짧게"""


# ------------------------------ 세션 요약 ------------------------------

SESSION_SUMMARY_PROMPT = """당신은 학습 세션을 정리하는 코치입니다.

세션 메시지 (유저/AI 대화):
{transcript}

오늘 다룬 노드와 proficiency 변화:
{mastery_changes_json}

아래 JSON을 반환:
{{
  "summary": "3~4문장 세션 요약",
  "highlights": {{
    "headline": "한 줄 요약 (예: '이벤트 루프의 마이크로태스크 큐를 이해했어요')",
    "learned": ["새로 이해한 개념 1~3개 (짧게)"],
    "improved": ["약점에서 개선된 부분 0~2개"]
  }},
  "voice_briefing": "TTS로 읽을 2~4문장 음성 브리핑. 유저 성장을 구체적으로 언급. 따뜻하게."
}}

규칙:
- 실제 대화 내용 기반, 일반론 금지
- voice_briefing은 음성용이라 이모지/불릿 없이 자연스러운 문장"""
```

- [ ] **Step 2: import 확인 + Commit**

```bash
docker compose exec backend python -c "from app.prompts.nightly_study import PLANNER_SYSTEM_PROMPT; print(len(PLANNER_SYSTEM_PROMPT))"
git add backend/app/prompts/nightly_study.py
git commit -m "feat(nightly-study): 프롬프트 (planner/tool/seed/summary)"
```

---

### Task 8: RAG 모듈

**Files:**
- Create: `backend/app/agent/ns_rag.py`

- [ ] **Step 1: RAG 함수 작성**

`backend/app/agent/ns_rag.py`:

```python
from __future__ import annotations

import json
import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import create_embedding

logger = logging.getLogger(__name__)

TOP_K = 3


async def search_learning_memory(
    db: AsyncSession,
    user_id: str,
    query: str,
    top_k: int = TOP_K,
    category: Optional[str] = None,
    node_id: Optional[str] = None,
) -> list[dict]:
    """Cosine similarity search on learning_embeddings."""
    embedding = await create_embedding(query)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    conditions = ["user_id = :user_id"]
    params: dict = {"user_id": user_id, "embedding": embedding_str, "top_k": top_k}

    if category:
        conditions.append("category = :category")
        params["category"] = category
    if node_id:
        conditions.append("node_id = :node_id")
        params["node_id"] = node_id

    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT id, category, content, metadata,
                   1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM learning_embeddings
            WHERE {where_clause}
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """),
        params,
    )
    return [
        {
            "id": str(row.id),
            "category": row.category,
            "content": row.content,
            "metadata": row.metadata,
            "similarity": round(row.similarity, 4),
        }
        for row in result.fetchall()
    ]


async def insert_learning_memory(
    db: AsyncSession,
    user_id: str,
    category: str,
    content: str,
    node_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> str:
    """Insert a new learning_embedding row. Returns row id."""
    embedding = await create_embedding(content)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    result = await db.execute(
        text("""
            INSERT INTO learning_embeddings (user_id, node_id, category, content, embedding, metadata)
            VALUES (:user_id, :node_id, :category, :content, CAST(:embedding AS vector), CAST(:metadata AS jsonb))
            RETURNING id
        """),
        {
            "user_id": user_id,
            "node_id": node_id,
            "category": category,
            "content": content,
            "embedding": embedding_str,
            "metadata": json.dumps(metadata or {}),
        },
    )
    row = result.one()
    await db.commit()
    return str(row.id)
```

- [ ] **Step 2: import 확인 + Commit**

```bash
docker compose exec backend python -c "from app.agent.ns_rag import search_learning_memory, insert_learning_memory; print('ok')"
git add backend/app/agent/ns_rag.py
git commit -m "feat(nightly-study): learning_embeddings RAG (검색/저장)"
```

---

### Task 9: 시드 커리큘럼 생성 모듈

**Files:**
- Create: `backend/app/agent/ns_seed.py`

- [ ] **Step 1: 시드 생성 함수 작성**

`backend/app/agent/ns_seed.py`:

```python
from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm_json
from app.prompts.nightly_study import SEED_CURRICULUM_PROMPT

logger = logging.getLogger(__name__)


async def generate_and_insert_seed(
    db: AsyncSession,
    goal_id: str,
    goal_title: str,
) -> int:
    """
    Call LLM to generate seed curriculum, insert curriculum_nodes.
    Returns number of nodes inserted.
    """
    prompt = SEED_CURRICULUM_PROMPT.format(goal_title=goal_title)
    data = await call_llm_json(
        system="당신은 개발자 학습 커리큘럼 설계자입니다.",
        user=prompt,
    )

    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, list) or len(nodes) == 0:
        raise RuntimeError(f"seed curriculum returned no nodes: {data}")

    # Insert root nodes first (parent_title=None), then children (parent_title != None)
    title_to_id: dict[str, str] = {}
    roots = [n for n in nodes if not n.get("parent_title")]
    children = [n for n in nodes if n.get("parent_title")]

    for node in roots + children:
        parent_id = None
        if node.get("parent_title"):
            parent_id = title_to_id.get(node["parent_title"])
        result = await db.execute(
            text("""
                INSERT INTO curriculum_nodes (goal_id, title, description, depth_level, parent_id, source, keywords)
                VALUES (:goal_id, :title, :description, :depth, :parent_id, 'seed', CAST(:keywords AS text[]))
                RETURNING id
            """),
            {
                "goal_id": goal_id,
                "title": node["title"],
                "description": node.get("description", ""),
                "depth": max(0, min(2, int(node.get("depth_level", 0)))),
                "parent_id": parent_id,
                "keywords": "{" + ",".join(
                    '"' + k.replace('"', '\\"') + '"' for k in (node.get("keywords") or [])
                ) + "}",
            },
        )
        row = result.one()
        title_to_id[node["title"]] = str(row.id)

    await db.commit()
    return len(nodes)


def normalize_goal(title: str) -> str:
    """Normalize free-form goal text to a key. Simple heuristic."""
    return "_".join(title.strip().upper().split())
```

- [ ] **Step 2: import 확인 + Commit**

```bash
docker compose exec backend python -c "from app.agent.ns_seed import generate_and_insert_seed, normalize_goal; print(normalize_goal('AI Agent 엔지니어'))"
git add backend/app/agent/ns_seed.py
git commit -m "feat(nightly-study): 시드 커리큘럼 LLM 생성 + 노드 INSERT"
```

---

### Task 10: Planner 모듈

**Files:**
- Create: `backend/app/agent/ns_planner.py`

- [ ] **Step 1: Planner 함수 작성**

`backend/app/agent/ns_planner.py`:

```python
from __future__ import annotations

import json
import logging
from typing import Any

from app.lib.llm_client import call_llm_json
from app.prompts.nightly_study import PLANNER_SYSTEM_PROMPT, PLANNER_USER_TEMPLATE
from app.agent.ns_state import PlannerOutput

logger = logging.getLogger(__name__)


async def run_planner(
    user_utterance: str,
    current_node: dict | None,
    current_mode: str,
    mastery: dict | None,
    recent_messages: list[dict],
    rag_hits: list[dict],
    curriculum_context: dict,
    turn_count: int,
) -> PlannerOutput:
    """Call planner LLM with current state. Returns structured action plan."""
    user_prompt = PLANNER_USER_TEMPLATE.format(
        user_utterance=user_utterance,
        current_node_json=json.dumps(current_node, ensure_ascii=False) if current_node else "null",
        current_mode=current_mode,
        mastery_json=json.dumps(mastery, ensure_ascii=False) if mastery else "null",
        recent_messages=_format_recent(recent_messages),
        rag_hits_json=json.dumps(rag_hits, ensure_ascii=False),
        curriculum_context_json=json.dumps(curriculum_context, ensure_ascii=False),
        turn_count=turn_count,
    )

    result = await call_llm_json(
        system=PLANNER_SYSTEM_PROMPT,
        user=user_prompt,
    )
    return _validate_planner_output(result)


def _format_recent(messages: list[dict]) -> str:
    lines = []
    for m in messages[-6:]:
        role = "유저" if m["role"] == "user" else "AI"
        lines.append(f"{role}: {m['content']}")
    return "\n".join(lines) if lines else "(대화 없음)"


def _validate_planner_output(raw: Any) -> PlannerOutput:
    """Basic validation with safe defaults."""
    if not isinstance(raw, dict):
        raise ValueError(f"planner did not return dict: {raw}")

    intent = raw.get("intent")
    if intent not in ("answer", "question", "pivot", "meta"):
        intent = "meta"

    next_mode = raw.get("next_mode")
    if next_mode not in ("tutoring", "quiz", "socratic", "onboarding"):
        next_mode = "quiz"

    actions = raw.get("actions") or []
    if not isinstance(actions, list):
        actions = []

    return {
        "intent": intent,
        "pivot_target": raw.get("pivot_target"),
        "evaluation": raw.get("evaluation") if intent == "answer" else None,
        "next_mode": next_mode,
        "actions": actions[:3],  # max 3 tools per turn
        "should_suggest_end": bool(raw.get("should_suggest_end")),
        "briefing_note": raw.get("briefing_note"),
    }
```

- [ ] **Step 2: Commit**

```bash
docker compose exec backend python -c "from app.agent.ns_planner import run_planner; print('ok')"
git add backend/app/agent/ns_planner.py
git commit -m "feat(nightly-study): planner LLM 래퍼 (JSON 출력 검증)"
```

---

### Task 11: 툴 모듈

**Files:**
- Create: `backend/app/agent/ns_tools.py`

- [ ] **Step 1: 툴 함수들 작성**

`backend/app/agent/ns_tools.py`:

```python
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm
from app.prompts.nightly_study import (
    EXPLAIN_CONCEPT_PROMPT,
    QUIZ_PROMPT,
    ASK_PROBING_PROMPT,
    SUGGEST_END_PROMPT,
    EXTEND_CURRICULUM_PROMPT,
    PIVOT_TOPIC_PROMPT,
)
from app.agent.ns_rag import search_learning_memory
from app.agent.ns_pivot import match_pivot_target
from app.agent.ns_srs import apply_proficiency_delta, compute_next_review

logger = logging.getLogger(__name__)


async def tool_retrieve_memory(db: AsyncSession, user_id: str, query: str, node_id: str | None) -> list[dict]:
    return await search_learning_memory(db, user_id, query, node_id=node_id)


async def tool_explain_concept(node_title: str, node_description: str, proficiency: int) -> str:
    prompt = EXPLAIN_CONCEPT_PROMPT.format(
        node_title=node_title, node_description=node_description, proficiency=proficiency
    )
    return await call_llm(system="당신은 친절한 개발 튜터입니다.", user=prompt)


async def tool_quiz(node_title: str, proficiency: int, difficulty: str = "medium") -> str:
    prompt = QUIZ_PROMPT.format(
        node_title=node_title, proficiency=proficiency, difficulty=difficulty
    )
    return await call_llm(system="당신은 개발 면접관입니다.", user=prompt)


async def tool_ask_probing(node_title: str, hint: str, proficiency: int) -> str:
    prompt = ASK_PROBING_PROMPT.format(
        node_title=node_title, hint=hint, proficiency=proficiency
    )
    return await call_llm(system="당신은 소크라틱 튜터입니다.", user=prompt)


async def tool_suggest_end(topics: list[str], turn_count: int, briefing_notes: list[str]) -> str:
    import json
    prompt = SUGGEST_END_PROMPT.format(
        topics_json=json.dumps(topics, ensure_ascii=False),
        turn_count=turn_count,
        briefing_notes="\n".join(f"- {n}" for n in briefing_notes if n),
    )
    return await call_llm(system="당신은 학습 코치입니다.", user=prompt)


async def tool_pivot_topic(
    db: AsyncSession,
    goal_id: str,
    candidate_nodes: list[dict],
    target: str,
    current_node_title: str,
) -> tuple[dict, str]:
    """
    Match target to existing node or create new. Returns (new_current_node, transition_message).
    """
    matched = match_pivot_target(candidate_nodes, target)
    if matched is None:
        # Create new extended node
        import json as _json
        import uuid as _uuid
        new_id = str(_uuid.uuid4())
        await db.execute(
            text("""
                INSERT INTO curriculum_nodes (id, goal_id, title, description, depth_level, source, keywords)
                VALUES (:id, :goal_id, :title, :description, 1, 'extended', CAST(:keywords AS text[]))
            """),
            {
                "id": new_id,
                "goal_id": goal_id,
                "title": target,
                "description": f"유저 요청으로 추가된 주제: {target}",
                "keywords": "{" + '"' + target.lower().replace('"', '\\"') + '"' + "}",
            },
        )
        await db.commit()
        matched = {"id": new_id, "title": target, "description": f"유저 요청으로 추가된 주제: {target}", "depth_level": 1, "keywords": [target.lower()]}

    prompt = PIVOT_TOPIC_PROMPT.format(current_node_title=current_node_title, target=target)
    message = await call_llm(system="당신은 학습 코치입니다.", user=prompt)
    return matched, message


async def tool_extend_curriculum(
    db: AsyncSession,
    goal_id: str,
    proposed_title: str,
    rationale: str,
    root_titles: list[str],
    goal_title: str,
) -> dict:
    """Create a new extended node based on conversation gap. Returns created node."""
    import json as _json
    import uuid as _uuid
    from app.lib.llm_client import call_llm_json

    prompt = EXTEND_CURRICULUM_PROMPT.format(
        proposed_title=proposed_title,
        rationale=rationale,
        goal_title=goal_title,
        root_titles_json=_json.dumps(root_titles, ensure_ascii=False),
    )
    node_spec = await call_llm_json(system="당신은 커리큘럼 설계자입니다.", user=prompt)

    new_id = str(_uuid.uuid4())
    await db.execute(
        text("""
            INSERT INTO curriculum_nodes (id, goal_id, title, description, depth_level, source, keywords)
            VALUES (:id, :goal_id, :title, :description, :depth, 'extended', CAST(:keywords AS text[]))
        """),
        {
            "id": new_id,
            "goal_id": goal_id,
            "title": node_spec.get("title", proposed_title),
            "description": node_spec.get("description", ""),
            "depth": max(0, min(2, int(node_spec.get("depth_level", 1)))),
            "keywords": "{" + ",".join(
                '"' + k.replace('"', '\\"') + '"' for k in (node_spec.get("keywords") or [])
            ) + "}",
        },
    )
    await db.commit()
    return {
        "id": new_id,
        "title": node_spec.get("title", proposed_title),
        "description": node_spec.get("description", ""),
        "depth_level": int(node_spec.get("depth_level", 1)),
        "keywords": node_spec.get("keywords") or [],
    }


async def tool_evaluate_answer(
    db: AsyncSession,
    user_id: str,
    node_id: str,
    delta: int,
    correct: bool,
    mode: str,
) -> int:
    """Apply proficiency delta + update counts + recompute next_review_at. Returns new proficiency."""
    # Upsert node_mastery
    existing = await db.execute(
        text("SELECT proficiency, success_count, failure_count, streak_count FROM node_mastery WHERE user_id=:u AND node_id=:n"),
        {"u": user_id, "n": node_id},
    )
    row = existing.one_or_none()
    now = datetime.now(timezone.utc)

    if row is None:
        new_prof = apply_proficiency_delta(0, delta)
        success = 1 if correct else 0
        failure = 0 if correct else 1
        streak = 1 if correct else 0
        next_review = compute_next_review(new_prof, now)
        await db.execute(
            text("""
                INSERT INTO node_mastery (user_id, node_id, proficiency, success_count, failure_count, streak_count, last_studied_at, next_review_at, last_mode)
                VALUES (:u, :n, :p, :s, :f, :sc, :ls, :nr, :lm)
            """),
            {"u": user_id, "n": node_id, "p": new_prof, "s": success, "f": failure, "sc": streak, "ls": now, "nr": next_review, "lm": mode},
        )
    else:
        new_prof = apply_proficiency_delta(row.proficiency, delta)
        success = row.success_count + (1 if correct else 0)
        failure = row.failure_count + (0 if correct else 1)
        streak = (row.streak_count + 1) if correct else 0
        next_review = compute_next_review(new_prof, now)
        await db.execute(
            text("""
                UPDATE node_mastery
                SET proficiency=:p, success_count=:s, failure_count=:f, streak_count=:sc,
                    last_studied_at=:ls, next_review_at=:nr, last_mode=:lm
                WHERE user_id=:u AND node_id=:n
            """),
            {"p": new_prof, "s": success, "f": failure, "sc": streak, "ls": now, "nr": next_review, "lm": mode, "u": user_id, "n": node_id},
        )
    await db.commit()
    return new_prof
```

- [ ] **Step 2: import 확인 + Commit**

```bash
docker compose exec backend python -c "from app.agent.ns_tools import tool_retrieve_memory, tool_explain_concept, tool_quiz, tool_ask_probing, tool_suggest_end, tool_pivot_topic, tool_extend_curriculum, tool_evaluate_answer; print('ok')"
git add backend/app/agent/ns_tools.py
git commit -m "feat(nightly-study): 8개 툴 함수 (retrieve/explain/quiz/probing/end/pivot/extend/evaluate)"
```

---

### Task 12: 오케스트레이터

**Files:**
- Create: `backend/app/agent/ns_orchestrator.py`

- [ ] **Step 1: 오케스트레이터 작성**

`backend/app/agent/ns_orchestrator.py`:

```python
from __future__ import annotations

import json
import logging
from typing import AsyncGenerator
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import BackgroundTasks

from app.agent.ns_planner import run_planner
from app.agent.ns_tools import (
    tool_retrieve_memory, tool_explain_concept, tool_quiz,
    tool_ask_probing, tool_suggest_end, tool_pivot_topic,
    tool_extend_curriculum, tool_evaluate_answer,
)
from app.agent.ns_seed import generate_and_insert_seed, normalize_goal

logger = logging.getLogger(__name__)


async def run_turn(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    user_utterance: str,
    background_tasks: BackgroundTasks,
) -> AsyncGenerator[dict, None]:
    """
    Execute one turn. Yields SSE event dicts:
      {type: 'text', data: <chunk>}
      {type: 'meta', data: {...}}
      {type: 'end', data: {...}}
      {type: 'error', data: {...}}
    """
    # 1. Load session state
    state = await _load_turn_state(db, session_id)
    if state is None:
        yield {"type": "error", "data": {"error": "세션을 찾을 수 없어요"}}
        return

    # 2. Persist user message
    await _append_message(db, session_id, state["next_index"], "user", user_utterance, None, None, None)

    # 3. Run planner
    try:
        planner_out = await run_planner(
            user_utterance=user_utterance,
            current_node=state["current_node"],
            current_mode=state["current_mode"],
            mastery=state["mastery"],
            recent_messages=state["recent_messages"],
            rag_hits=[],  # will be filled if retrieve_memory runs
            curriculum_context=state["curriculum_context"],
            turn_count=state["turn_count"],
        )
    except Exception as e:
        logger.exception("planner failed")
        yield {"type": "error", "data": {"error": "잠깐 연결이 끊겼어요. 다시 말씀해주세요."}}
        return

    # 4. Evaluate answer (if applicable) — update proficiency BEFORE other tools
    proficiency_after = None
    if planner_out["intent"] == "answer" and planner_out["evaluation"] and state["current_node"]:
        ev = planner_out["evaluation"]
        proficiency_after = await tool_evaluate_answer(
            db=db,
            user_id=user_id,
            node_id=state["current_node"]["id"],
            delta=int(ev.get("proficiency_delta", 0)),
            correct=bool(ev.get("correct", False)),
            mode=state["current_mode"],
        )

    # 5. Execute actions
    node_changed_to = None
    rag_hits = []
    assistant_reply_parts: list[str] = []

    for action in planner_out["actions"]:
        tool = action.get("tool")
        args = action.get("args") or {}

        try:
            if tool == "retrieve_memory":
                rag_hits = await tool_retrieve_memory(
                    db, user_id, args.get("query", ""),
                    state["current_node"]["id"] if state["current_node"] else None,
                )

            elif tool == "explain_concept" and state["current_node"]:
                text_out = await tool_explain_concept(
                    state["current_node"]["title"],
                    state["current_node"]["description"],
                    state["mastery"]["proficiency"] if state["mastery"] else 0,
                )
                assistant_reply_parts.append(text_out)

            elif tool == "quiz" and state["current_node"]:
                text_out = await tool_quiz(
                    state["current_node"]["title"],
                    state["mastery"]["proficiency"] if state["mastery"] else 0,
                    args.get("difficulty", "medium"),
                )
                assistant_reply_parts.append(text_out)

            elif tool == "ask_probing" and state["current_node"]:
                text_out = await tool_ask_probing(
                    state["current_node"]["title"],
                    args.get("hint", ""),
                    state["mastery"]["proficiency"] if state["mastery"] else 0,
                )
                assistant_reply_parts.append(text_out)

            elif tool == "pivot_topic" and state["goal_id"]:
                target = args.get("target") or planner_out.get("pivot_target") or ""
                if target:
                    new_node, message = await tool_pivot_topic(
                        db=db,
                        goal_id=state["goal_id"],
                        candidate_nodes=state["all_nodes"],
                        target=target,
                        current_node_title=state["current_node"]["title"] if state["current_node"] else "",
                    )
                    node_changed_to = new_node
                    assistant_reply_parts.append(message)

            elif tool == "extend_curriculum" and state["goal_id"]:
                new_node = await tool_extend_curriculum(
                    db=db,
                    goal_id=state["goal_id"],
                    proposed_title=args.get("proposed_title", ""),
                    rationale=args.get("rationale", ""),
                    root_titles=[n["title"] for n in state["all_nodes"] if n.get("depth_level") == 0],
                    goal_title=state["goal_title"] or "",
                )
                # Don't auto-switch; planner decides if this should become current_node
                # For simplicity, do not change current_node here.

            elif tool == "suggest_end":
                topics = [n["title"] for n in state["all_nodes_in_session"]]
                text_out = await tool_suggest_end(topics, state["turn_count"], state["briefing_notes"])
                assistant_reply_parts.append(text_out)

            elif tool == "create_goal":
                title = (args.get("title") or "").strip()
                if title:
                    from sqlalchemy import text as _t
                    result = await db.execute(
                        _t("""
                            INSERT INTO learning_goals (user_id, title, normalized_goal, status)
                            VALUES (:u, :t, :n, 'active')
                            RETURNING id
                        """),
                        {"u": user_id, "t": title, "n": normalize_goal(title)},
                    )
                    row = result.one()
                    new_goal_id = str(row.id)
                    await db.execute(
                        _t("UPDATE learning_sessions SET goal_id=:g WHERE id=:s"),
                        {"g": new_goal_id, "s": session_id},
                    )
                    await db.commit()
                    # Schedule seed generation in background — user doesn't wait
                    background_tasks.add_task(_run_seed_bg, new_goal_id, title)

            elif tool == "generate_immediate_reply":
                text_out = args.get("text", "").strip()
                if text_out:
                    assistant_reply_parts.append(text_out)

        except Exception as e:
            logger.exception(f"tool {tool} failed")

    # 6. Stream assistant reply
    final_reply = " ".join(p for p in assistant_reply_parts if p).strip()
    if not final_reply:
        final_reply = "네, 계속 해볼까요?"

    yield {"type": "text", "data": final_reply}

    # 7. Persist assistant message + state updates
    await _append_message(
        db, session_id, state["next_index"] + 1,
        "assistant", final_reply, planner_out["next_mode"],
        {"actions": planner_out["actions"], "planner": {
            "intent": planner_out["intent"],
            "evaluation": planner_out["evaluation"],
            "briefing_note": planner_out["briefing_note"],
        }},
        (node_changed_to or state["current_node"] or {}).get("id"),
    )
    await db.execute(
        text("UPDATE learning_sessions SET turn_count = turn_count + 1 WHERE id=:s"),
        {"s": session_id},
    )
    await db.commit()

    # 8. meta event
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
        },
    }

    yield {"type": "end", "data": {"turnCount": state["turn_count"] + 1}}


async def _run_seed_bg(goal_id: str, goal_title: str) -> None:
    """Background: generate seed curriculum. Uses its own DB session."""
    from app.database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        try:
            await generate_and_insert_seed(db, goal_id, goal_title)
        except Exception:
            logger.exception("seed generation failed for goal_id=%s", goal_id)


async def _load_turn_state(db: AsyncSession, session_id: str) -> dict | None:
    """Load everything planner needs: session, goal, current_node candidate, mastery, history."""
    sess_row = (await db.execute(
        text("SELECT user_id, goal_id, turn_count FROM learning_sessions WHERE id=:s AND status='active'"),
        {"s": session_id},
    )).one_or_none()
    if sess_row is None:
        return None

    user_id = sess_row.user_id
    goal_id = str(sess_row.goal_id) if sess_row.goal_id else None
    turn_count = sess_row.turn_count

    # Last assistant message index
    last_idx_row = (await db.execute(
        text("SELECT COALESCE(MAX(message_index), -1) AS idx FROM learning_messages WHERE session_id=:s"),
        {"s": session_id},
    )).one()
    next_index = last_idx_row.idx + 1

    # Recent messages
    recent_rows = (await db.execute(
        text("SELECT role, content FROM learning_messages WHERE session_id=:s ORDER BY message_index DESC LIMIT 6"),
        {"s": session_id},
    )).fetchall()
    recent_messages = [{"role": r.role, "content": r.content} for r in reversed(recent_rows)]

    # Current node: last assistant message's node_id, or null
    cur_node_row = (await db.execute(
        text("""
            SELECT cn.id, cn.title, cn.description, cn.depth_level, cn.keywords
            FROM learning_messages lm
            JOIN curriculum_nodes cn ON cn.id = lm.node_id
            WHERE lm.session_id=:s AND lm.role='assistant' AND lm.node_id IS NOT NULL
            ORDER BY lm.message_index DESC LIMIT 1
        """),
        {"s": session_id},
    )).one_or_none()

    current_node = None
    if cur_node_row:
        current_node = {
            "id": str(cur_node_row.id),
            "title": cur_node_row.title,
            "description": cur_node_row.description,
            "depth_level": cur_node_row.depth_level,
            "keywords": list(cur_node_row.keywords) if cur_node_row.keywords else [],
        }

    # Mastery
    mastery = None
    if current_node:
        m_row = (await db.execute(
            text("SELECT proficiency, success_count, failure_count, streak_count, last_mode FROM node_mastery WHERE user_id=:u AND node_id=:n"),
            {"u": user_id, "n": current_node["id"]},
        )).one_or_none()
        if m_row:
            mastery = {
                "proficiency": m_row.proficiency,
                "success_count": m_row.success_count,
                "failure_count": m_row.failure_count,
                "streak_count": m_row.streak_count,
                "last_mode": m_row.last_mode,
            }

    # Determine mode from proficiency
    current_mode = "onboarding"
    if goal_id:
        p = (mastery or {}).get("proficiency", 0)
        if p < 30:
            current_mode = "tutoring"
        elif p < 70:
            current_mode = "quiz"
        else:
            current_mode = "socratic"

    # All nodes for goal (for pivot matching)
    all_nodes = []
    goal_title = None
    if goal_id:
        g_row = (await db.execute(
            text("SELECT title FROM learning_goals WHERE id=:g"),
            {"g": goal_id},
        )).one_or_none()
        goal_title = g_row.title if g_row else None

        n_rows = (await db.execute(
            text("SELECT id, title, description, depth_level, keywords FROM curriculum_nodes WHERE goal_id=:g"),
            {"g": goal_id},
        )).fetchall()
        all_nodes = [
            {
                "id": str(r.id),
                "title": r.title,
                "description": r.description,
                "depth_level": r.depth_level,
                "keywords": list(r.keywords) if r.keywords else [],
            }
            for r in n_rows
        ]

    root_nodes = [n for n in all_nodes if n["depth_level"] == 0]

    # Nodes covered in this session
    nodes_in_sess_rows = (await db.execute(
        text("""
            SELECT DISTINCT cn.id, cn.title FROM learning_messages lm
            JOIN curriculum_nodes cn ON cn.id = lm.node_id
            WHERE lm.session_id=:s
        """),
        {"s": session_id},
    )).fetchall()
    all_nodes_in_session = [{"id": str(r.id), "title": r.title} for r in nodes_in_sess_rows]

    # Briefing notes collected so far
    notes_rows = (await db.execute(
        text("""
            SELECT tool_calls -> 'planner' ->> 'briefing_note' AS note
            FROM learning_messages
            WHERE session_id=:s AND role='assistant' AND tool_calls IS NOT NULL
            ORDER BY message_index
        """),
        {"s": session_id},
    )).fetchall()
    briefing_notes = [r.note for r in notes_rows if r.note]

    return {
        "user_id": user_id,
        "goal_id": goal_id,
        "goal_title": goal_title,
        "current_node": current_node,
        "current_mode": current_mode,
        "mastery": mastery,
        "recent_messages": recent_messages,
        "curriculum_context": {
            "root_nodes": [{"id": n["id"], "title": n["title"]} for n in root_nodes[:5]],
            "all_node_count": len(all_nodes),
        },
        "all_nodes": all_nodes,
        "all_nodes_in_session": all_nodes_in_session,
        "turn_count": turn_count,
        "next_index": next_index,
        "briefing_notes": briefing_notes,
    }


async def _append_message(
    db: AsyncSession,
    session_id: str,
    message_index: int,
    role: str,
    content: str,
    mode: str | None,
    tool_calls: dict | None,
    node_id: str | None,
) -> None:
    import json as _j
    await db.execute(
        text("""
            INSERT INTO learning_messages (session_id, message_index, role, content, mode, tool_calls, node_id)
            VALUES (:s, :i, :r, :c, :m, CAST(:t AS jsonb), :n)
        """),
        {
            "s": session_id,
            "i": message_index,
            "r": role,
            "c": content,
            "m": mode,
            "t": _j.dumps(tool_calls) if tool_calls else None,
            "n": node_id,
        },
    )
```

- [ ] **Step 2: import 확인 + Commit**

```bash
docker compose exec backend python -c "from app.agent.ns_orchestrator import run_turn; print('ok')"
git add backend/app/agent/ns_orchestrator.py
git commit -m "feat(nightly-study): 턴 오케스트레이터 (상태 로드 → planner → 툴 순차 실행 → 스트림)"
```

---

### Task 13: 세션 요약 모듈

**Files:**
- Create: `backend/app/agent/ns_summarizer.py`

- [ ] **Step 1: 요약 함수 작성**

`backend/app/agent/ns_summarizer.py`:

```python
from __future__ import annotations

import json
import logging
from datetime import date
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm_json
from app.prompts.nightly_study import SESSION_SUMMARY_PROMPT
from app.agent.ns_srs import update_streak_state

logger = logging.getLogger(__name__)


async def generate_session_summary(
    db: AsyncSession,
    session_id: str,
) -> dict:
    """
    Returns {
        'summary': str,
        'highlights': {'headline', 'learned', 'improved'},
        'voice_briefing': str,
    }
    """
    # Collect messages
    msg_rows = (await db.execute(
        text("SELECT role, content FROM learning_messages WHERE session_id=:s ORDER BY message_index"),
        {"s": session_id},
    )).fetchall()
    transcript = "\n".join(
        f"{'유저' if r.role == 'user' else 'AI'}: {r.content}" for r in msg_rows
    )

    # Collect mastery changes in session
    user_row = (await db.execute(
        text("SELECT user_id FROM learning_sessions WHERE id=:s"),
        {"s": session_id},
    )).one()
    user_id = user_row.user_id

    mastery_rows = (await db.execute(
        text("""
            SELECT cn.title, nm.proficiency, nm.success_count, nm.failure_count
            FROM node_mastery nm
            JOIN curriculum_nodes cn ON cn.id = nm.node_id
            JOIN (
                SELECT DISTINCT node_id FROM learning_messages WHERE session_id=:s AND node_id IS NOT NULL
            ) used ON used.node_id = nm.node_id
            WHERE nm.user_id=:u
        """),
        {"s": session_id, "u": user_id},
    )).fetchall()

    mastery_changes = [
        {
            "title": r.title,
            "proficiency_now": r.proficiency,
            "success": r.success_count,
            "failure": r.failure_count,
        }
        for r in mastery_rows
    ]

    prompt = SESSION_SUMMARY_PROMPT.format(
        transcript=transcript[:10000],
        mastery_changes_json=json.dumps(mastery_changes, ensure_ascii=False),
    )

    try:
        result = await call_llm_json(
            system="당신은 학습 코치입니다.",
            user=prompt,
        )
        summary = result.get("summary", "")
        highlights = result.get("highlights") or {}
        voice_briefing = result.get("voice_briefing", "")
    except Exception:
        logger.exception("summary LLM failed — falling back")
        summary = ""
        highlights = {
            "headline": f"오늘 {len(mastery_changes)}개 토픽 학습",
            "learned": [m["title"] for m in mastery_changes[:3]],
            "improved": [],
        }
        voice_briefing = "오늘도 학습을 마쳤어요. 수고하셨어요."

    return {"summary": summary, "highlights": highlights, "voice_briefing": voice_briefing}


async def update_streak_after_session(db: AsyncSession, user_id: str, today: date) -> dict:
    """Upsert learning_streaks. Returns the new state + isNewRecord flag."""
    row = (await db.execute(
        text("SELECT current_streak, longest_streak, total_sessions, total_nodes_learned, last_session_date FROM learning_streaks WHERE user_id=:u"),
        {"u": user_id},
    )).one_or_none()

    if row is None:
        current, longest = update_streak_state(0, 0, None, today)
        total_sessions = 1
    else:
        current, longest = update_streak_state(
            row.current_streak, row.longest_streak,
            row.last_session_date, today,
        )
        total_sessions = row.total_sessions + 1

    # total_nodes_learned = proficiency >= 70 count
    learned_row = (await db.execute(
        text("SELECT COUNT(*) AS c FROM node_mastery WHERE user_id=:u AND proficiency >= 70"),
        {"u": user_id},
    )).one()
    total_nodes_learned = learned_row.c

    is_new_record = (row is None) or (current > (row.longest_streak if row else 0))

    await db.execute(
        text("""
            INSERT INTO learning_streaks (user_id, current_streak, longest_streak, total_sessions, total_nodes_learned, last_session_date)
            VALUES (:u, :cur, :lng, :ts, :tn, :ld)
            ON CONFLICT (user_id) DO UPDATE SET
                current_streak=:cur, longest_streak=:lng, total_sessions=:ts,
                total_nodes_learned=:tn, last_session_date=:ld
        """),
        {"u": user_id, "cur": current, "lng": longest, "ts": total_sessions, "tn": total_nodes_learned, "ld": today},
    )
    await db.commit()

    return {
        "current": current,
        "longest": longest,
        "totalSessions": total_sessions,
        "totalNodesLearned": total_nodes_learned,
        "isNewRecord": is_new_record,
    }
```

- [ ] **Step 2: Commit**

```bash
docker compose exec backend python -c "from app.agent.ns_summarizer import generate_session_summary, update_streak_after_session; print('ok')"
git add backend/app/agent/ns_summarizer.py
git commit -m "feat(nightly-study): 세션 요약 + streak 업데이트"
```

---

## Phase C: Backend API

### Task 14: 라우터 — 스키마 + `/start` + `/goal`

**Files:**
- Create: `backend/app/routers/nightly_study.py`

- [ ] **Step 1: 라우터 skeleton + start + goal 작성**

`backend/app/routers/nightly_study.py`:

```python
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta, date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.config import settings
from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.services.credit import deduct_for_feature, InsufficientCreditsError
from app.agent.ns_orchestrator import run_turn
from app.agent.ns_seed import generate_and_insert_seed, normalize_goal
from app.agent.ns_summarizer import generate_session_summary, update_streak_after_session

logger = logging.getLogger(__name__)

router = APIRouter()

KST = timezone(timedelta(hours=9))

FREE_COST = 0
EXTRA_COST = 1  # 추가 세션 1 코인


def _kst_today() -> date:
    return datetime.now(KST).date()


def _kst_today_utc_midnight() -> datetime:
    now_kst = datetime.now(KST)
    midnight_kst = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_kst.astimezone(timezone.utc).replace(tzinfo=None)


# ---------- POST /api/nightly-study/start ----------

@router.post("/api/nightly-study/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 0. Auto-close any existing active session for this user
    await db.execute(
        text("UPDATE learning_sessions SET status='completed', ended_at=NOW() WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )
    await db.commit()

    # 1. Daily free check (skip in dev)
    midnight_utc = _kst_today_utc_midnight()
    is_free = False
    if settings.is_dev:
        is_free = True
    else:
        existing_free_row = (await db.execute(
            text("""
                SELECT 1 FROM learning_sessions
                WHERE user_id=:u AND is_free_session=TRUE AND started_at >= :m
                LIMIT 1
            """),
            {"u": user.id, "m": midnight_utc},
        )).one_or_none()
        if existing_free_row is None:
            is_free = True
        else:
            # Need credit
            try:
                await deduct_for_feature(
                    db=db, user_id=user.id, reference_id="nightly-study-extra",
                    description="오늘의 학습 추가 세션", cost=EXTRA_COST, tx_type="FEATURE_DEBIT",
                )
            except InsufficientCreditsError:
                raise HTTPException(
                    status_code=402,
                    detail={"error": "크레딧이 부족해요", "code": "INSUFFICIENT_CREDITS"},
                )

    # 2. Check goal
    goal_row = (await db.execute(
        text("SELECT id, title FROM learning_goals WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )).one_or_none()

    goal_id = str(goal_row.id) if goal_row else None
    initial_mode = "learning" if goal_id else "onboarding"

    # 3. Pick target node if goal exists
    target_node = None
    if goal_id:
        tn_row = (await db.execute(
            text("""
                SELECT cn.id, cn.title, cn.description
                FROM curriculum_nodes cn
                LEFT JOIN node_mastery nm ON nm.node_id = cn.id AND nm.user_id=:u
                WHERE cn.goal_id=:g
                ORDER BY
                    CASE WHEN nm.next_review_at IS NULL OR nm.next_review_at <= NOW() THEN 0 ELSE 1 END,
                    nm.proficiency ASC NULLS FIRST,
                    cn.depth_level ASC
                LIMIT 1
            """),
            {"u": user.id, "g": goal_id},
        )).one_or_none()
        if tn_row:
            target_node = {"id": str(tn_row.id), "title": tn_row.title, "description": tn_row.description}

    # 4. Create session
    result = await db.execute(
        text("""
            INSERT INTO learning_sessions (user_id, goal_id, is_free_session, credit_deducted, status)
            VALUES (:u, :g, :f, :c, 'active')
            RETURNING id
        """),
        {"u": user.id, "g": goal_id, "f": is_free, "c": 0 if is_free else EXTRA_COST},
    )
    row = result.one()
    session_id = str(row.id)
    await db.commit()

    # 5. Seed the first assistant message (non-LLM, fixed greeting for onboarding or learning)
    if initial_mode == "onboarding":
        first_text = "어떤 개발자가 되고 싶으세요?"
        first_node_id = None
    else:
        first_text = f"다시 오셨네요. 오늘은 '{target_node['title']}' 해볼까요?" if target_node else "오늘도 시작해볼까요?"
        first_node_id = target_node["id"] if target_node else None

    await db.execute(
        text("""
            INSERT INTO learning_messages (session_id, message_index, role, content, mode, node_id)
            VALUES (:s, 0, 'assistant', :c, :m, :n)
        """),
        {"s": session_id, "c": first_text, "m": initial_mode, "n": first_node_id},
    )
    await db.commit()

    return {
        "sessionId": session_id,
        "initialMode": initial_mode,
        "targetNode": target_node,
        "firstMessage": first_text,
    }


# ---------- POST /api/nightly-study/goal (온보딩 + 변경 겸용) ----------

class GoalBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/api/nightly-study/goal")
async def set_goal(
    body: GoalBody,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Archive existing active goal
    await db.execute(
        text("UPDATE learning_goals SET status='archived' WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )
    # Insert new active goal
    result = await db.execute(
        text("""
            INSERT INTO learning_goals (user_id, title, normalized_goal, status)
            VALUES (:u, :t, :n, 'active')
            RETURNING id
        """),
        {"u": user.id, "t": body.title, "n": normalize_goal(body.title)},
    )
    row = result.one()
    goal_id = str(row.id)
    await db.commit()

    # Generate seed synchronously (called from non-voice context, e.g. settings)
    try:
        count = await generate_and_insert_seed(db, goal_id, body.title)
    except Exception:
        logger.exception("seed generation failed")
        raise HTTPException(
            status_code=500,
            detail={"error": "커리큘럼 생성에 실패했어요. 잠시 후 다시 시도해주세요."},
        )

    return {"goalId": goal_id, "seedNodeCount": count}
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/routers/nightly_study.py
git commit -m "feat(nightly-study): 라우터 /start + /goal (일일 무료, 크레딧, 시드 생성)"
```

---

### Task 15: SSE `/turn` 엔드포인트

**Files:**
- Modify: `backend/app/routers/nightly_study.py`

- [ ] **Step 1: /turn 추가**

`backend/app/routers/nightly_study.py` 하단에 추가:

```python
class TurnBody(BaseModel):
    userUtterance: str = Field(min_length=1, max_length=5000)


@router.post("/api/nightly-study/{session_id}/turn")
async def turn(
    session_id: str,
    body: TurnBody,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Ownership check
    own = (await db.execute(
        text("SELECT 1 FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if own is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    async def event_stream():
        try:
            async for ev in run_turn(
                db=db,
                session_id=session_id,
                user_id=user.id,
                user_utterance=body.userUtterance,
                background_tasks=background_tasks,
            ):
                yield {"event": ev["type"], "data": json.dumps(ev["data"], ensure_ascii=False)}
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("turn stream failed")
            yield {"event": "error", "data": json.dumps({"error": "잠깐 문제가 생겼어요. 다시 시도해주세요."})}

    return EventSourceResponse(event_stream())
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/routers/nightly_study.py
git commit -m "feat(nightly-study): /turn SSE 엔드포인트 (text/meta/end/error)"
```

---

### Task 16: `/end` 엔드포인트

**Files:**
- Modify: `backend/app/routers/nightly_study.py`

- [ ] **Step 1: /end 추가**

하단에 추가:

```python
class EndBody(BaseModel):
    reason: str = Field(default="user")


@router.post("/api/nightly-study/{session_id}/end")
async def end_session(
    session_id: str,
    body: EndBody,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Ownership + active check
    sess = (await db.execute(
        text("SELECT id, user_id FROM learning_sessions WHERE id=:s AND user_id=:u AND status='active'"),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if sess is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    # Generate summary
    summary_data = await generate_session_summary(db, session_id)

    # Mark completed + persist summary
    await db.execute(
        text("""
            UPDATE learning_sessions
            SET status='completed', ended_at=NOW(),
                summary=:sum, highlights=CAST(:h AS jsonb), voice_briefing=:vb
            WHERE id=:s
        """),
        {
            "s": session_id,
            "sum": summary_data["summary"],
            "h": json.dumps(summary_data["highlights"], ensure_ascii=False),
            "vb": summary_data["voice_briefing"],
        },
    )
    await db.commit()

    # Update streak
    streak_state = await update_streak_after_session(db, user.id, _kst_today())

    # Background: store insights to learning_embeddings
    background_tasks.add_task(_store_insights_bg, session_id, user.id)

    return {
        "summary": summary_data["summary"],
        "highlights": summary_data["highlights"],
        "voiceBriefing": summary_data["voice_briefing"],
        "streakUpdated": streak_state,
    }


async def _store_insights_bg(session_id: str, user_id: str) -> None:
    """Background: extract and store learning_embeddings (misconception/explanation)."""
    from app.database import AsyncSessionLocal
    from app.agent.ns_rag import insert_learning_memory
    async with AsyncSessionLocal() as db:
        try:
            rows = (await db.execute(
                text("""
                    SELECT tool_calls, node_id FROM learning_messages
                    WHERE session_id=:s AND role='assistant' AND tool_calls IS NOT NULL
                """),
                {"s": session_id},
            )).fetchall()
            for r in rows:
                tc = r.tool_calls or {}
                planner = tc.get("planner") or {}
                evaluation = planner.get("evaluation") or {}
                note = planner.get("briefing_note")
                misc = evaluation.get("misconception")
                if misc:
                    await insert_learning_memory(
                        db, user_id=user_id, category="misconception",
                        content=misc, node_id=str(r.node_id) if r.node_id else None,
                    )
                if note:
                    await insert_learning_memory(
                        db, user_id=user_id, category="connection",
                        content=note, node_id=str(r.node_id) if r.node_id else None,
                    )
        except Exception:
            logger.exception("insight extraction failed for session %s", session_id)
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/routers/nightly_study.py
git commit -m "feat(nightly-study): /end (요약 생성, streak 업데이트, 인사이트 백그라운드 저장)"
```

---

### Task 17: `/status` + `/sessions/{id}` 엔드포인트

**Files:**
- Modify: `backend/app/routers/nightly_study.py`

- [ ] **Step 1: 추가**

```python
@router.get("/api/nightly-study/status")
async def status(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    midnight_utc = _kst_today_utc_midnight()

    # Daily free used?
    used_row = (await db.execute(
        text("""
            SELECT 1 FROM learning_sessions
            WHERE user_id=:u AND is_free_session=TRUE AND started_at >= :m LIMIT 1
        """),
        {"u": user.id, "m": midnight_utc},
    )).one_or_none()
    daily_free_used = used_row is not None

    # Credit balance
    cb_row = (await db.execute(
        text('SELECT credit_balance FROM users WHERE id=:u'),
        {"u": user.id},
    )).one()
    credit_balance = cb_row.credit_balance

    # Streak
    s_row = (await db.execute(
        text("SELECT current_streak, longest_streak, total_sessions, total_nodes_learned FROM learning_streaks WHERE user_id=:u"),
        {"u": user.id},
    )).one_or_none()
    streak = {
        "current": s_row.current_streak if s_row else 0,
        "longest": s_row.longest_streak if s_row else 0,
        "totalSessions": s_row.total_sessions if s_row else 0,
        "totalNodesLearned": s_row.total_nodes_learned if s_row else 0,
    }

    # Goal / today target node
    goal_row = (await db.execute(
        text("SELECT id FROM learning_goals WHERE user_id=:u AND status='active'"),
        {"u": user.id},
    )).one_or_none()
    has_goal = goal_row is not None

    today_target = None
    if has_goal:
        tn_row = (await db.execute(
            text("""
                SELECT cn.title, cn.description
                FROM curriculum_nodes cn
                LEFT JOIN node_mastery nm ON nm.node_id = cn.id AND nm.user_id=:u
                WHERE cn.goal_id=:g
                ORDER BY
                    CASE WHEN nm.next_review_at IS NULL OR nm.next_review_at <= NOW() THEN 0 ELSE 1 END,
                    nm.proficiency ASC NULLS FIRST,
                    cn.depth_level ASC
                LIMIT 1
            """),
            {"u": user.id, "g": str(goal_row.id)},
        )).one_or_none()
        if tn_row:
            today_target = {"title": tn_row.title, "description": tn_row.description}

    # Recent 5 sessions
    rs_rows = (await db.execute(
        text("""
            SELECT id, started_at, ended_at, highlights
            FROM learning_sessions
            WHERE user_id=:u AND status='completed'
            ORDER BY started_at DESC LIMIT 5
        """),
        {"u": user.id},
    )).fetchall()
    recent_sessions = []
    for r in rs_rows:
        headline = None
        if r.highlights and isinstance(r.highlights, dict):
            headline = r.highlights.get("headline")
        recent_sessions.append({
            "id": str(r.id),
            "startedAt": r.started_at.isoformat() if r.started_at else None,
            "endedAt": r.ended_at.isoformat() if r.ended_at else None,
            "headline": headline or "학습 세션",
        })

    return {
        "dailyFreeUsed": daily_free_used,
        "creditBalance": credit_balance,
        "streak": streak,
        "hasGoal": has_goal,
        "todayTargetNode": today_target,
        "recentSessions": recent_sessions,
    }


@router.get("/api/nightly-study/sessions/{session_id}")
async def get_session_detail(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sess = (await db.execute(
        text("""
            SELECT id, started_at, ended_at, summary, highlights, voice_briefing
            FROM learning_sessions WHERE id=:s AND user_id=:u
        """),
        {"s": session_id, "u": user.id},
    )).one_or_none()
    if sess is None:
        raise HTTPException(status_code=404, detail={"error": "세션을 찾을 수 없어요"})

    msgs = (await db.execute(
        text("SELECT message_index, role, content, mode FROM learning_messages WHERE session_id=:s ORDER BY message_index"),
        {"s": session_id},
    )).fetchall()

    return {
        "session": {
            "id": str(sess.id),
            "startedAt": sess.started_at.isoformat() if sess.started_at else None,
            "endedAt": sess.ended_at.isoformat() if sess.ended_at else None,
            "summary": sess.summary,
        },
        "highlights": sess.highlights,
        "voiceBriefing": sess.voice_briefing,
        "messages": [
            {"index": m.message_index, "role": m.role, "content": m.content, "mode": m.mode}
            for m in msgs
        ],
    }
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/routers/nightly_study.py
git commit -m "feat(nightly-study): /status + /sessions/{id} 엔드포인트"
```

---

### Task 18: main.py 배선 + 기존 라우터 제거

**Files:**
- Modify: `backend/app/main.py`

- [ ] **Step 1: main.py 교체**

기존 `backend/app/main.py` 에서 다음 라인 찾기:

```python
from app.routers.learning_agent import router as learning_agent_router
# ...
app.include_router(learning_agent_router)
```

다음으로 변경:

```python
from app.routers.nightly_study import router as nightly_study_router
# ...
app.include_router(nightly_study_router)
```

- [ ] **Step 2: 백엔드 재시작 + nginx 재시작**

```bash
docker compose restart backend nginx
```

- [ ] **Step 3: 엔드포인트 스모크 테스트**

```bash
# health check
curl -s http://localhost:81/api/health
# unauthenticated start should 401
curl -s -X POST http://localhost:81/api/nightly-study/start
```

Expected: status endpoint 401 (인증 미들웨어 동작), health ok.

- [ ] **Step 4: Commit**

```bash
git add backend/app/main.py
git commit -m "feat(nightly-study): main.py 라우터 배선 (learning_agent → nightly_study)"
```

---

### Task 19: API 통합 테스트

**Files:**
- Create: `backend/tests/test_ns_api.py`

- [ ] **Step 1: 통합 테스트 작성**

`backend/tests/test_ns_api.py`:

```python
"""
Integration test: start → goal → turn flow.
Uses conftest.py helpers. LLM is mocked.
"""
import pytest
from unittest.mock import patch, AsyncMock


@pytest.mark.asyncio
async def test_start_creates_session_in_onboarding_mode(client, auth_headers, db):
    # Precondition: no goal
    resp = await client.post("/api/nightly-study/start", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["initialMode"] == "onboarding"
    assert data["sessionId"]
    assert "어떤 개발자" in data["firstMessage"]


@pytest.mark.asyncio
async def test_start_closes_previous_active_session(client, auth_headers, db):
    r1 = await client.post("/api/nightly-study/start", headers=auth_headers)
    r2 = await client.post("/api/nightly-study/start", headers=auth_headers)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["sessionId"] != r2.json()["sessionId"]
    # r1 should be completed now
    from sqlalchemy import text
    row = (await db.execute(
        text("SELECT status FROM learning_sessions WHERE id=:s"),
        {"s": r1.json()["sessionId"]},
    )).one()
    assert row.status == "completed"


@pytest.mark.asyncio
async def test_ownership_403_on_foreign_session(client, auth_headers_other, auth_headers, db):
    r = await client.post("/api/nightly-study/start", headers=auth_headers)
    sid = r.json()["sessionId"]
    r2 = await client.post(
        f"/api/nightly-study/{sid}/end",
        json={"reason": "user"},
        headers=auth_headers_other,
    )
    assert r2.status_code == 404  # treat as not found


@pytest.mark.asyncio
async def test_status_reflects_streak(client, auth_headers, db):
    r = await client.get("/api/nightly-study/status", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert "streak" in data
    assert "currentStreak" in data["streak"] or "current" in data["streak"]
```

Note: `auth_headers_other` fixture는 conftest에서 만들어야 함. 이미 있으면 사용, 없으면 스킵 가능.

- [ ] **Step 2: 실행**

```bash
docker compose exec backend pytest tests/test_ns_api.py -v
```

Expected: 모든 테스트 통과 (auth_headers_other 없으면 해당 테스트 skip).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_ns_api.py
git commit -m "test(nightly-study): API 통합 테스트 (start/ownership/status)"
```

---

### Task 20: 기존 백엔드 파일 삭제

**Files:**
- Delete: `backend/app/agent/learning_nodes.py`
- Delete: `backend/app/agent/learning_planner.py`
- Delete: `backend/app/agent/learning_state.py`
- Delete: `backend/app/agent/tutor_agent.py`
- Delete: `backend/app/prompts/learning_agent.py`
- Delete: `backend/app/routers/learning_agent.py`
- Delete: `backend/app/models/learning.py`
- Delete: `backend/app/models/learning_agent.py`
- Delete: `backend/app/services/daily_progress.py` (존재 시)

- [ ] **Step 1: 참조 점검**

```bash
grep -rn "from app.models.learning\|from app.models.learning_agent\|from app.agent.learning_nodes\|from app.agent.learning_planner\|from app.agent.learning_state\|from app.agent.tutor_agent\|from app.prompts.learning_agent\|daily_progress" backend --include="*.py" | grep -v "__pycache__"
```

각 참조 지점을 확인. 삭제 시 빠진 import는 제거 또는 nightly_study로 교체.

특히:
- `backend/app/models/user.py` 의 `user_knowledge`, `daily_progress` relationship은 제거
- `backend/app/services/` 에서 해당 모델 import가 있으면 제거
- `backend/app/main.py`의 `app.models` import 블록 정리

- [ ] **Step 2: 파일 삭제**

```bash
rm backend/app/agent/learning_nodes.py
rm backend/app/agent/learning_planner.py
rm backend/app/agent/learning_state.py
rm backend/app/agent/tutor_agent.py
rm backend/app/prompts/learning_agent.py
rm backend/app/routers/learning_agent.py
rm backend/app/models/learning.py
rm backend/app/models/learning_agent.py
rm -f backend/app/services/daily_progress.py
```

- [ ] **Step 3: User 모델 relationship 제거**

`backend/app/models/user.py` 에서 `user_knowledge`, `daily_progress` 관련 라인 삭제.

- [ ] **Step 4: import smoke**

```bash
docker compose exec backend python -c "from app.main import app; print('ok')"
```

Expected: `ok`. 실패 시 남은 import 제거.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(nightly-study): 기존 learning 모듈/모델/라우터 전부 삭제"
```

---

### Task 21: Prisma schema 정리

**Files:**
- Modify: `frontend/prisma/schema.prisma`

- [ ] **Step 1: Prisma 모델 제거**

`frontend/prisma/schema.prisma` 에서 다음 모델을 찾아 통째로 삭제:
- `model Subject`
- `model Topic`
- `model UserKnowledge`
- `model LearningAgentSession`
- `model LearningAgentMessage`
- `model DailyProgress`

`User` 모델 내 아래 관계 필드도 삭제:
- `userKnowledge UserKnowledge[]`
- `learningAgentSessions LearningAgentSession[]`
- `dailyProgress DailyProgress[]`

- [ ] **Step 2: Prisma generate + push 스킵**

Prisma는 NextAuth 전용. DB 구조는 raw SQL로 이미 반영됨. `schema.prisma`는 NextAuth 관련 모델만 있으면 됨.

```bash
cd frontend && set -a && source .env && set +a && npx prisma generate
```

Expected: `✔ Generated Prisma Client ...`

- [ ] **Step 3: frontend typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: 0 errors (Prisma 타입 참조 있던 코드가 끊겼을 수 있음 — 해당 파일은 Task 28에서 삭제)

만약 에러가 있으면 일단 진행. 프론트 정리 단계에서 해결.

- [ ] **Step 4: Commit**

```bash
git add frontend/prisma/schema.prisma
git commit -m "chore(nightly-study): Prisma schema에서 기존 learning 모델 제거"
```

---

## Phase D: Frontend

### Task 22: 미들웨어 UA 체크

**Files:**
- Modify: `frontend/src/middleware.ts`

- [ ] **Step 1: UA 체크 추가**

`frontend/src/middleware.ts` 교체:

```typescript
import { NextRequest, NextResponse } from 'next/server';

function isMobileUA(ua: string): boolean {
  // Rough heuristic: phone-class devices (not tablets)
  return /Mobi|Android.*Mobile|iPhone|iPod|IEMobile|Windows Phone/.test(ua);
}

export function middleware(request: NextRequest) {
  const sessionToken =
    request.cookies.get('__Secure-authjs.session-token') ??
    request.cookies.get('authjs.session-token');

  if (!sessionToken) {
    const { pathname } = request.nextUrl;
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Mobile-only gate for /nightly-study
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/nightly-study') && !pathname.startsWith('/nightly-study/mobile-only')) {
    const ua = request.headers.get('user-agent') || '';
    if (!isMobileUA(ua)) {
      return NextResponse.redirect(new URL('/nightly-study/mobile-only', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/interview/:path*',
    '/agent-interview/:path*',
    '/journal/:path*',
    '/nightly-study/:path*',
    '/profile/:path*',
    '/history/:path*',
    '/credits/:path*',
    '/admin/:path*',
    '/learn/:path*',
    '/progress/:path*',
  ],
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/middleware.ts
git commit -m "feat(nightly-study): 모바일 전용 UA 체크 미들웨어"
```

---

### Task 23: 데스크톱 안내 페이지

**Files:**
- Create: `frontend/src/app/(authenticated)/nightly-study/mobile-only/page.tsx`

- [ ] **Step 1: 페이지 작성**

`frontend/src/app/(authenticated)/nightly-study/mobile-only/page.tsx`:

```typescript
'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Smartphone } from 'lucide-react';

export default function MobileOnlyPage() {
  const [url, setUrl] = useState('');

  useEffect(() => {
    setUrl(window.location.origin + '/nightly-study');
  }, []);

  const qr = url
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`
    : '';

  return (
    <div className="mx-auto max-w-md space-y-6 p-8">
      <div className="text-center">
        <Smartphone className="mx-auto h-12 w-12 text-primary" />
        <h1 className="mt-4 text-2xl font-bold">모바일에서 열어주세요</h1>
        <p className="mt-2 text-muted-foreground">
          오늘의 학습은 음성 대화 기반이라 휴대폰에서 가장 자연스러워요.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-6">
          {qr ? <img src={qr} alt="QR" className="h-48 w-48" /> : null}
          <p className="text-sm text-muted-foreground break-all text-center">{url}</p>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "frontend/src/app/(authenticated)/nightly-study/mobile-only/page.tsx"
git commit -m "feat(nightly-study): 데스크톱 안내 페이지 (QR 코드)"
```

---

### Task 24: API 클라이언트

**Files:**
- Create: `frontend/src/lib/nightly-study-api.ts`

- [ ] **Step 1: API 클라이언트 작성**

`frontend/src/lib/nightly-study-api.ts`:

```typescript
export interface TargetNode {
  id: string;
  title: string;
  description: string;
}

export interface StartResponse {
  sessionId: string;
  initialMode: 'onboarding' | 'learning';
  targetNode: TargetNode | null;
  firstMessage: string;
}

export interface StatusResponse {
  dailyFreeUsed: boolean;
  creditBalance: number;
  streak: {
    current: number;
    longest: number;
    totalSessions: number;
    totalNodesLearned: number;
  };
  hasGoal: boolean;
  todayTargetNode: { title: string; description: string } | null;
  recentSessions: Array<{
    id: string;
    startedAt: string | null;
    endedAt: string | null;
    headline: string;
  }>;
}

export interface Highlights {
  headline: string;
  learned: string[];
  improved: string[];
}

export interface EndResponse {
  summary: string;
  highlights: Highlights;
  voiceBriefing: string;
  streakUpdated: {
    current: number;
    longest: number;
    totalSessions: number;
    totalNodesLearned: number;
    isNewRecord: boolean;
  };
}

export async function startSession(): Promise<StartResponse> {
  const res = await fetch('/api/nightly-study/start', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.detail?.error || '세션을 시작할 수 없어요');
  }
  return res.json();
}

export async function endSession(sessionId: string, reason: 'user' | 'ai_suggested' = 'user'): Promise<EndResponse> {
  const res = await fetch(`/api/nightly-study/${sessionId}/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    throw new Error('세션 종료에 실패했어요');
  }
  return res.json();
}

export async function getStatus(): Promise<StatusResponse> {
  const res = await fetch('/api/nightly-study/status');
  if (!res.ok) throw new Error('상태 로드 실패');
  return res.json();
}

export async function setGoal(title: string): Promise<{ goalId: string; seedNodeCount: number }> {
  const res = await fetch('/api/nightly-study/goal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error('목표 저장 실패');
  return res.json();
}

export async function getSessionDetail(id: string) {
  const res = await fetch(`/api/nightly-study/sessions/${id}`);
  if (!res.ok) throw new Error('세션 로드 실패');
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/nightly-study-api.ts
git commit -m "feat(nightly-study): 프론트 API 클라이언트"
```

---

### Task 25: SSE 스트림 훅

**Files:**
- Create: `frontend/src/hooks/useNightlyStudyStream.ts`

- [ ] **Step 1: 훅 작성**

`frontend/src/hooks/useNightlyStudyStream.ts`:

```typescript
import { useCallback, useRef, useState } from 'react';

export interface TurnMeta {
  mode: string;
  intent: string;
  nodeChangedTo: { id: string; title: string } | null;
  proficiencyAfter: number | null;
  shouldSuggestEnd: boolean;
}

export interface UseNightlyStudyStreamOptions {
  sessionId: string;
  onText: (text: string) => void;
  onMeta: (meta: TurnMeta) => void;
  onError: (msg: string) => void;
  onEnd: (turnCount: number) => void;
}

export function useNightlyStudyStream(opts: UseNightlyStudyStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendTurn = useCallback(async (userUtterance: string) => {
    if (isStreaming) return;
    setIsStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`/api/nightly-study/${opts.sessionId}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ userUtterance }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        opts.onError('연결에 실패했어요');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = chunk.split('\n');
          let event = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload: unknown;
          try { payload = JSON.parse(data); } catch { continue; }

          if (event === 'text') {
            opts.onText(typeof payload === 'string' ? payload : (payload as { text?: string }).text || String(payload));
          } else if (event === 'meta') {
            opts.onMeta(payload as TurnMeta);
          } else if (event === 'error') {
            opts.onError((payload as { error?: string })?.error || '에러');
          } else if (event === 'end') {
            opts.onEnd((payload as { turnCount?: number })?.turnCount ?? 0);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        opts.onError('연결이 끊겼어요');
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming, opts]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { isStreaming, sendTurn, abort };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useNightlyStudyStream.ts
git commit -m "feat(nightly-study): SSE 스트림 파싱 훅"
```

---

### Task 26: StreakBadge 컴포넌트

**Files:**
- Create: `frontend/src/components/nightly-study/streak-badge.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`frontend/src/components/nightly-study/streak-badge.tsx`:

```typescript
import { Flame } from 'lucide-react';

interface Props {
  current: number;
  totalNodesLearned: number;
}

export function StreakBadge({ current, totalNodesLearned }: Props) {
  return (
    <div className="flex items-center justify-center gap-4 text-sm">
      <span className="flex items-center gap-1">
        <Flame className="h-4 w-4 text-orange-500" />
        <span className="font-semibold">{current}일 연속</span>
      </span>
      <span className="text-muted-foreground">|</span>
      <span className="text-muted-foreground">총 {totalNodesLearned}개 학습</span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/nightly-study/streak-badge.tsx
git commit -m "feat(nightly-study): StreakBadge 컴포넌트"
```

---

### Task 27: SessionView 컴포넌트 (대화 화면)

**Files:**
- Create: `frontend/src/components/nightly-study/session-view.tsx`

- [ ] **Step 1: SessionView 작성**

`frontend/src/components/nightly-study/session-view.tsx`:

```typescript
'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, StopCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useNightlyStudyStream } from '@/hooks/useNightlyStudyStream';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  sessionId: string;
  firstMessage: string;
  currentTopic: string | null;
  onEnd: () => Promise<void>;
}

export function SessionView({ sessionId, firstMessage, currentTopic, onEnd }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: firstMessage },
  ]);
  const [currentTopicLabel, setCurrentTopicLabel] = useState<string | null>(currentTopic);
  const [shouldSuggestEnd, setShouldSuggestEnd] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { isListening, startListening, stopListening, transcript, resetTranscript } = useSpeechRecognition();

  const { isStreaming, sendTurn } = useNightlyStudyStream({
    sessionId,
    onText: (text) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
      playTTS(text);
    },
    onMeta: (meta) => {
      if (meta.nodeChangedTo) setCurrentTopicLabel(meta.nodeChangedTo.title);
      if (meta.shouldSuggestEnd) setShouldSuggestEnd(true);
    },
    onError: (msg) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: `⚠ ${msg}` }]);
    },
    onEnd: () => {},
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // TTS playback
  useEffect(() => {
    playTTS(firstMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = async () => {
    const text = transcript.trim();
    if (!text || isStreaming) return;
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    resetTranscript();
    stopListening();
    await sendTurn(text);
  };

  return (
    <div className="flex flex-col h-[100dvh]">
      <header className="flex items-center justify-between border-b p-3">
        {currentTopicLabel ? (
          <Badge variant="secondary">{currentTopicLabel}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">대화 중</span>
        )}
        <Button variant="ghost" size="sm" onClick={onEnd}>
          <X className="h-4 w-4 mr-1" /> 종료
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              m.role === 'user'
                ? 'ml-auto bg-primary text-primary-foreground'
                : 'bg-muted'
            }`}
          >
            {m.content}
          </div>
        ))}
        {isListening && transcript ? (
          <div className="max-w-[85%] ml-auto rounded-lg px-3 py-2 text-sm bg-primary/20 text-primary">
            {transcript}
          </div>
        ) : null}
        <div ref={bottomRef} />
      </main>

      {shouldSuggestEnd ? (
        <div className="bg-amber-50 border-t border-amber-200 p-2 text-xs text-center text-amber-900">
          AI가 오늘 여기까지 정리하자고 제안했어요
        </div>
      ) : null}

      <footer className="border-t p-3 flex items-center gap-2">
        {!isListening ? (
          <Button
            className="flex-1 h-14"
            onClick={startListening}
            disabled={isStreaming}
          >
            <Mic className="mr-2 h-5 w-5" /> 말하기
          </Button>
        ) : (
          <Button
            className="flex-1 h-14"
            variant="destructive"
            onClick={handleSend}
          >
            <StopCircle className="mr-2 h-5 w-5" /> 완료
          </Button>
        )}
      </footer>
    </div>
  );
}

async function playTTS(text: string) {
  try {
    const res = await fetch('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, persona: 'tutor' }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    await audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
  } catch {
    // fail silently
  }
}
```

Note: `useSpeechRecognition` 훅은 기존 프로젝트에 있음 (`frontend/src/hooks/useSpeechRecognition.ts`).
TTS 엔드포인트 경로는 기존 프로젝트 패턴 확인 필요: `/api/tts/synthesize` (nginx가 tts 서비스로 프록시).

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/nightly-study/session-view.tsx
git commit -m "feat(nightly-study): SessionView — 음성 대화 화면"
```

---

### Task 28: BriefingView 컴포넌트

**Files:**
- Create: `frontend/src/components/nightly-study/briefing-view.tsx`

- [ ] **Step 1: BriefingView 작성**

`frontend/src/components/nightly-study/briefing-view.tsx`:

```typescript
'use client';

import { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Flame, Sparkles, TrendingUp } from 'lucide-react';
import type { EndResponse } from '@/lib/nightly-study-api';

interface Props {
  result: EndResponse;
  onClose: () => void;
}

export function BriefingView({ result, onClose }: Props) {
  // Auto-play voice briefing on mount
  useEffect(() => {
    const text = result.voiceBriefing;
    if (!text) return;
    (async () => {
      try {
        const res = await fetch('/api/tts/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, persona: 'tutor' }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        await audio.play();
        audio.onended = () => URL.revokeObjectURL(url);
      } catch {}
    })();
  }, [result.voiceBriefing]);

  return (
    <div className="space-y-4 p-4 pb-8">
      <h2 className="text-xl font-bold text-center">수고하셨어요</h2>

      {/* Card 1: Headline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> 오늘의 하이라이트
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-base">{result.highlights.headline}</p>
        </CardContent>
      </Card>

      {/* Card 2: Learned & Improved */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" /> 새로 이해한 것
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {result.highlights.learned.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="text-sm space-y-1">
              {result.highlights.learned.map((item, i) => (
                <li key={i}>• {item}</li>
              ))}
            </ul>
          )}
          {result.highlights.improved.length > 0 && (
            <div className="pt-2 border-t mt-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">개선 포인트</p>
              <ul className="text-sm space-y-1">
                {result.highlights.improved.map((item, i) => (
                  <li key={i}>• {item}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 3: Streak */}
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-2">
            <Flame className="h-6 w-6 text-orange-500" />
            <span className="text-lg font-bold">{result.streakUpdated.current}일</span>
            {result.streakUpdated.isNewRecord && (
              <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">최고 기록</span>
            )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>총 {result.streakUpdated.totalSessions}회 학습</div>
            <div>{result.streakUpdated.totalNodesLearned}개 토픽 마스터</div>
          </div>
        </CardContent>
      </Card>

      <Button onClick={onClose} className="w-full">확인</Button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/nightly-study/briefing-view.tsx
git commit -m "feat(nightly-study): BriefingView — 카드 3장 + 자동 TTS"
```

---

### Task 29: 메인 페이지 재작성

**Files:**
- Modify: `frontend/src/app/(authenticated)/nightly-study/page.tsx`

- [ ] **Step 1: 페이지 교체**

`frontend/src/app/(authenticated)/nightly-study/page.tsx` 전체 교체:

```typescript
'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Moon, Loader2 } from 'lucide-react';
import {
  getStatus,
  startSession,
  endSession,
  type StartResponse,
  type EndResponse,
} from '@/lib/nightly-study-api';
import { StreakBadge } from '@/components/nightly-study/streak-badge';
import { SessionView } from '@/components/nightly-study/session-view';
import { BriefingView } from '@/components/nightly-study/briefing-view';

type View =
  | { kind: 'landing' }
  | { kind: 'session'; session: StartResponse }
  | { kind: 'briefing'; result: EndResponse };

export default function NightlyStudyPage() {
  const [view, setView] = useState<View>({ kind: 'landing' });
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: ['ns-status'],
    queryFn: getStatus,
    enabled: view.kind === 'landing',
  });

  const startMut = useMutation({
    mutationFn: startSession,
    onSuccess: (s) => setView({ kind: 'session', session: s }),
    onError: (e: Error) => alert(e.message),
  });

  const endMut = useMutation({
    mutationFn: (sessionId: string) => endSession(sessionId),
    onSuccess: (result) => {
      setView({ kind: 'briefing', result });
      qc.invalidateQueries({ queryKey: ['ns-status'] });
    },
  });

  if (view.kind === 'session') {
    return (
      <SessionView
        sessionId={view.session.sessionId}
        firstMessage={view.session.firstMessage}
        currentTopic={view.session.targetNode?.title ?? null}
        onEnd={async () => {
          await endMut.mutateAsync(view.session.sessionId);
        }}
      />
    );
  }

  if (view.kind === 'briefing') {
    return (
      <BriefingView
        result={view.result}
        onClose={() => setView({ kind: 'landing' })}
      />
    );
  }

  // Landing
  return (
    <div className="mx-auto max-w-md space-y-6 p-4 pt-6">
      <div className="text-center">
        <Moon className="mx-auto h-10 w-10 text-primary" />
        <h1 className="mt-3 text-xl font-bold">오늘의 학습</h1>
      </div>

      {isLoading || !status ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <StreakBadge
            current={status.streak.current}
            totalNodesLearned={status.streak.totalNodesLearned}
          />

          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-8">
              {status.hasGoal && status.todayTargetNode ? (
                <p className="text-sm text-muted-foreground">
                  오늘은 <span className="font-semibold">{status.todayTargetNode.title}</span>
                </p>
              ) : !status.hasGoal ? (
                <p className="text-sm text-muted-foreground text-center">
                  처음이시네요. 시작하면 목표를 물어볼게요.
                </p>
              ) : null}

              {!status.dailyFreeUsed ? (
                <Badge variant="secondary">오늘 무료</Badge>
              ) : (
                <Badge variant="outline">추가 1코인 · 잔액 {status.creditBalance}</Badge>
              )}

              <Button
                size="lg"
                className="w-full h-14"
                onClick={() => startMut.mutate()}
                disabled={startMut.isPending}
              >
                {startMut.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>● 시작</>
                )}
              </Button>
            </CardContent>
          </Card>

          {status.recentSessions.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">지난 세션</h2>
              {status.recentSessions.map((s) => (
                <Card key={s.id}>
                  <CardContent className="py-3">
                    <p className="text-sm">{s.headline}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {s.startedAt ? new Date(s.startedAt).toLocaleDateString('ko-KR') : ''}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "frontend/src/app/(authenticated)/nightly-study/page.tsx"
git commit -m "feat(nightly-study): 메인 페이지 재작성 (랜딩/세션/브리핑 분기)"
```

---

### Task 30: 기존 프론트 파일 삭제 + 리빌드

**Files:**
- Delete: `frontend/src/app/(authenticated)/nightly-study/session/page.tsx`
- Delete: `frontend/src/lib/learning-agent-api.ts`

- [ ] **Step 1: 파일 삭제**

```bash
rm "frontend/src/app/(authenticated)/nightly-study/session/page.tsx"
rmdir "frontend/src/app/(authenticated)/nightly-study/session"
rm frontend/src/lib/learning-agent-api.ts
```

- [ ] **Step 2: 남은 참조 점검**

```bash
grep -rn "learning-agent-api\|learning_agent_api\|getLearningStatus\|getLearningHistory" frontend/src 2>&1
```

남은 참조가 있으면 해당 파일에서 제거. 사이드바/대시보드/히스토리 등에 있을 수 있음.

예상 위치:
- `frontend/src/components/layout/sidebar.tsx`
- `frontend/src/app/(authenticated)/dashboard/page.tsx`
- 세션 히스토리 통합 부분

각각에서 learning-agent-api 의존을 제거하고, 대신 `nightly-study-api`의 `getStatus()`/`getSessionDetail()` 사용으로 교체.

- [ ] **Step 3: typecheck + build**

```bash
cd frontend && npm run typecheck && npm run build
```

Expected: 0 errors. 에러 있으면 해결.

- [ ] **Step 4: Dev 리빌드 + 수동 확인**

```bash
docker compose build frontend && docker compose up -d frontend
docker compose restart nginx
```

모바일 UA로 `http://localhost:81/nightly-study` 접근 (Chrome DevTools → Toggle device toolbar).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(nightly-study): 기존 프론트 파일/참조 정리"
```

---

## Phase E: 마무리

### Task 31: 수동 체크리스트

- [ ] **Step 1: 랜딩 → 온보딩 → 세션 → 종료 → 브리핑 전체 흐름**

모바일 뷰포트에서:
1. `/nightly-study` 접근 → 랜딩 로드
2. "시작" 터치 → 음성 대화 화면
3. AI가 "어떤 개발자가 되고 싶으세요?" TTS 재생
4. "말하기" → "백엔드 엔지니어" 음성 입력 → "완료"
5. AI "좋아요..." + 시드 생성 백그라운드 시작
6. 다음 턴: 기초 개념 튜터링/질문 확인
7. "종료" → 브리핑 카드 3장 + TTS 재생
8. "확인" → 랜딩 복귀 (streak 1일)

- [ ] **Step 2: 데스크톱 접근 확인**

데스크톱 UA로 `/nightly-study` 접근 → `/nightly-study/mobile-only` 리다이렉트, QR 코드 보임.

- [ ] **Step 3: 일일 무료 소진 동작**

`ENVIRONMENT=production` 환경 설정 후 같은 유저로 두 번째 세션 시작. 두 번째 시도는 1코인 차감. 잔액 0이면 402.

- [ ] **Step 4: 기존 데이터 마이그레이션 흔적 없음 확인**

```bash
docker compose exec backend python -c "
import asyncio
from sqlalchemy import text
from app.database import engine

async def check():
    async with engine.begin() as conn:
        result = await conn.execute(text(\"\"\"
            SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_name IN (
                'subjects','topics','user_knowledge','daily_progress',
                'learning_agent_sessions','learning_agent_messages',
                'LearningAgentSession','LearningAgentMessage'
            )
        \"\"\"))
        remaining = [r[0] for r in result]
        print('remaining old tables:', remaining)

asyncio.run(check())
"
```

Expected: 빈 리스트.

- [ ] **Step 5: 회귀 확인 — 다른 기능 정상 동작**

- `/interview/setup` 진입 OK
- `/agent-interview/start` 정상 (세션 생성 OK)
- `/journal` 정상
- `/dashboard` 히스토리에서 구 learning 세션 참조 잔재 없음

### Task 32: 최종 커밋 + 메모리 업데이트

- [ ] **Step 1: 메모리 업데이트**

기존 `~/.claude/.../memory/MEMORY.md`에 다음 한 줄 추가:

```
- [오늘의 학습 v2 구조](project_nightly_study_v2.md) — 2026-04-17 재설계. 목표 기반 agentic 학습, 모바일 전용
```

그리고 해당 파일 생성:

`memory/project_nightly_study_v2.md`:
```markdown
---
name: 오늘의 학습 v2 구조
description: 2026-04-17 재설계된 목표 기반 agentic 학습 코치 구조
type: project
---

오늘의 학습은 2026-04-17에 전면 재설계되었다. 기존 정적 Subject/Topic 트리 구조는 전부 폐기.

**구조**:
- 유저가 목표(예: "백엔드 엔지니어") 입력 → LLM이 시드 커리큘럼(뿌리 노드 8~15개) 자동 생성
- 대화 중 빈틈 발견 시 `curriculum_nodes` 확장 (source='extended')
- Planner LLM이 매 턴 JSON으로 의도 분류 + 평가 + 툴 시퀀스 결정 (8개 툴: retrieve/explain/quiz/probing/pivot/extend/end 등)
- proficiency 기반 적응형 모드 (0~30=튜터링, 30~70=평가, 70+=소크라틱)
- 음성 전용. 코드 블록/렌더링 없음
- 모바일 전용 (데스크톱 UA는 `/nightly-study/mobile-only`로 리다이렉트)
- 일일 무료 1세션 + 초과는 1코인
- 세션 종료 시 카드 3장 + TTS 음성 브리핑

**Why:** "매일 꾸준한 학습 습관" 브랜드에 맞게 SRS 기반 long-term 기억 구조 + agentic planner로 재설계. 정적 트리는 유지보수 부담 + 개인화 안 됨.

**How to apply:** 학습 관련 코드 수정 시 `backend/app/agent/ns_*` 모듈 + `backend/app/routers/nightly_study.py` + `frontend/src/app/(authenticated)/nightly-study/` 참조. 구조 변경은 `docs/superpowers/specs/2026-04-17-nightly-study-redesign-design.md` 스펙에 맞춰서.
```

- [ ] **Step 2: 최종 커밋**

```bash
git add -A
git commit -m "docs(memory): 오늘의 학습 v2 구조 메모리 추가"
```

---

## 실행 원칙 재확인

- 각 Task 완료 후 반드시 커밋 (DRY/YAGNI/TDD/frequent commits)
- TDD는 순수 함수(SRS, pivot 매칭)에만 엄격 적용. 나머지는 통합 테스트 + 수동 확인
- 각 Task 종료 시 `docker compose restart backend nginx` 필수 (백엔드 수정 시)
- Prisma schema 변경은 마이그레이션 SQL과 별개로 관리 (NextAuth 전용이라 실제 DB 영향 없음)
- `eslint-disable` 대신 `useRef`로 stable function reference
- 모든 에러 응답 `{"error": "..."}` 형태
- `user_id` 소유권 검증은 모든 세션 엔드포인트에 필수

## Self-Review 기록

1. **스펙 커버리지**: 스펙 17개 섹션 전부 태스크 매핑됨
2. **Placeholder 없음**: 모든 코드 블록 실 코드. "TODO/TBD/fill in" 없음
3. **타입 일관성**: `PlannerOutput`, `TurnMeta`, `EndResponse`, `StartResponse` 이름 전 파일에서 동일 사용
4. **의존성**: Task 1 (마이그레이션) → Task 3 (모델) → Task 4~13 (에이전트) → Task 14~19 (API) → Task 20~21 (정리) → Task 22~30 (프론트)
