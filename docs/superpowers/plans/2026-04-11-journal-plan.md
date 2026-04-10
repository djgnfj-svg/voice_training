# 하루의 정리 (Daily Journal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 음성 기반 일기/상담 채팅 기능 — 멀티에이전트가 정리/상담을 자동 분기하고 RAG에 핵심 정보를 저장한다.

**Architecture:** LangGraph 상태 머신 기반. router 노드가 의도를 분류하여 journal/counseling 에이전트로 분기하고, extractor가 매 턴 병렬로 정보를 추출하여 별도 `journal_embeddings` 테이블에 저장한다. 기존 에이전트 면접(`backend/app/agent/`)과 동일한 패턴(State TypedDict, pending_events, SSE EventSourceResponse)을 따른다.

**Tech Stack:** FastAPI, SQLAlchemy, pgvector, OpenAI Embeddings, Anthropic Claude (haiku), SSE, Next.js, TanStack Query, shadcn/ui, Web Speech API, Whisper

---

## File Structure

### Backend (Create)

| File | Responsibility |
|------|---------------|
| `backend/app/agent/journal_state.py` | `JournalState` TypedDict |
| `backend/app/agent/journal_router_agent.py` | 의도 분류 (journal vs counseling) |
| `backend/app/agent/journal_agent.py` | 하루 정리 대화 에이전트 |
| `backend/app/agent/counseling_agent.py` | 상담 대화 에이전트 |
| `backend/app/agent/journal_extractor.py` | 대화에서 정보 추출 → RAG 저장 |
| `backend/app/agent/journal_summarizer.py` | 세션 요약 생성 |
| `backend/app/agent/journal_nodes.py` | 노드 함수들 (router, respond, extract, summarize) |
| `backend/app/agent/journal_rag.py` | journal_embeddings 테이블 CRUD (search, upsert) |
| `backend/app/models/journal.py` | `JournalSession`, `JournalMessage` SQLAlchemy 모델 |
| `backend/app/routers/journal.py` | API 엔드포인트 (start, message, end, history) |
| `backend/app/prompts/journal.py` | 프롬프트 템플릿들 |

### Backend (Modify)

| File | Change |
|------|--------|
| `backend/app/models/__init__.py` | JournalSession, JournalMessage import 추가 |
| `backend/app/main.py` | journal router include 추가 |

### Frontend (Create)

| File | Responsibility |
|------|---------------|
| `frontend/src/lib/journal-api.ts` | API 호출 함수 + SSE 헬퍼 |
| `frontend/src/hooks/useJournalSession.ts` | 세션 시작/이어하기/종료/메시지 전송 |
| `frontend/src/hooks/useInactivityTimer.ts` | 2분 비활동 타이머 |
| `frontend/src/app/(authenticated)/journal/page.tsx` | 메인 대화 페이지 |
| `frontend/src/app/(authenticated)/journal/history/page.tsx` | 요약 히스토리 |
| `frontend/src/components/journal/journal-panel.tsx` | 대화 패널 (메시지 목록 + 음성 입력) |
| `frontend/src/components/journal/journal-message.tsx` | 개별 메시지 (모드별 스타일) |
| `frontend/src/components/journal/mode-indicator.tsx` | 현재 모드 표시 배지 |
| `frontend/src/components/journal/session-summary-card.tsx` | 요약 카드 |
| `frontend/src/components/journal/voice-input-bar.tsx` | 하단 음성 입력 바 |

### Frontend (Modify)

| File | Change |
|------|--------|
| `frontend/src/components/layout/sidebar.tsx` | "하루의 정리" 메뉴 추가 |
| `frontend/prisma/schema.prisma` | JournalSession, JournalMessage 모델 추가 |

### DB Migration (SQL)

| File | Content |
|------|---------|
| `db/migrations/journal_tables.sql` | journal_sessions, journal_messages, journal_embeddings 테이블 생성 |

---

## Task 1: DB 마이그레이션 SQL + Prisma 스키마

**Files:**
- Create: `db/migrations/journal_tables.sql`
- Modify: `frontend/prisma/schema.prisma`

- [ ] **Step 1: 마이그레이션 SQL 작성**

```sql
-- db/migrations/journal_tables.sql

-- Journal Sessions
CREATE TABLE IF NOT EXISTS journal_sessions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "freeMessagesUsed" INTEGER NOT NULL DEFAULT 0,
    "creditsCharged" INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_journal_sessions_user_status ON journal_sessions("userId", status);
CREATE INDEX idx_journal_sessions_user_date ON journal_sessions("userId", "createdAt");

-- Journal Messages
CREATE TABLE IF NOT EXISTS journal_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionId" TEXT NOT NULL REFERENCES journal_sessions(id) ON DELETE CASCADE,
    "messageIndex" INTEGER NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    mode VARCHAR(20) NOT NULL DEFAULT 'journal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("sessionId", "messageIndex")
);

-- Journal Embeddings (separate from user_profile_embeddings)
CREATE TABLE IF NOT EXISTS journal_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_journal_embeddings_user ON journal_embeddings("userId");
CREATE INDEX idx_journal_embeddings_user_category ON journal_embeddings("userId", category);
```

- [ ] **Step 2: Supabase에서 SQL 실행**

Run: Supabase SQL Editor에서 위 SQL 실행

- [ ] **Step 3: Prisma 스키마에 모델 추가**

`frontend/prisma/schema.prisma`의 User 모델에 relation 추가하고, 새 모델 정의:

User 모델의 relations 목록 맨 끝에 추가:
```prisma
  journalSessions    JournalSession[]
```

파일 맨 끝에 추가:
```prisma
model JournalSession {
  id               String   @id @default(uuid())
  userId           String
  status           String   @default("active")
  messageCount     Int      @default(0)
  freeMessagesUsed Int      @default(0)
  creditsCharged   Int      @default(0)
  summary          String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  user     User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages JournalMessage[]

  @@index([userId, status])
  @@index([userId, createdAt])
  @@map("journal_sessions")
}

model JournalMessage {
  id           String   @id @default(uuid()) @db.Uuid
  sessionId    String
  messageIndex Int
  role         String   @db.VarChar(20)
  content      String
  mode         String   @default("journal") @db.VarChar(20)
  createdAt    DateTime @default(now())

  session JournalSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, messageIndex])
  @@map("journal_messages")
}
```

- [ ] **Step 4: Prisma generate 실행**

Run: `cd frontend && set -a && source .env && set +a && npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 5: 커밋**

```bash
git add db/migrations/journal_tables.sql frontend/prisma/schema.prisma
git commit -m "feat(journal): DB 스키마 — journal_sessions, journal_messages, journal_embeddings 테이블"
```

---

## Task 2: SQLAlchemy 모델

**Files:**
- Create: `backend/app/models/journal.py`
- Modify: `backend/app/models/__init__.py`

- [ ] **Step 1: Journal 모델 파일 작성**

```python
# backend/app/models/journal.py
from __future__ import annotations

from sqlalchemy import Column, String, DateTime, Integer, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class JournalSession(Base):
    __tablename__ = "journal_sessions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status = Column(String(20), nullable=False, default="active")
    message_count = Column("messageCount", Integer, default=0)
    free_messages_used = Column("freeMessagesUsed", Integer, default=0)
    credits_charged = Column("creditsCharged", Integer, default=0)
    summary = Column(Text, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    messages = relationship("JournalMessage", back_populates="session", cascade="all, delete-orphan")


class JournalMessage(Base):
    __tablename__ = "journal_messages"
    __table_args__ = (
        UniqueConstraint("sessionId", "messageIndex", name="journal_messages_session_index_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)
    session_id = Column("sessionId", String, ForeignKey("journal_sessions.id", ondelete="CASCADE"), nullable=False)
    message_index = Column("messageIndex", Integer, nullable=False)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    mode = Column(String(20), nullable=False, default="journal")
    created_at = Column("createdAt", DateTime, server_default=func.now())

    session = relationship("JournalSession", back_populates="messages")
```

- [ ] **Step 2: __init__.py에 import 추가**

`backend/app/models/__init__.py` 맨 끝에 추가:
```python
from app.models.journal import JournalSession, JournalMessage  # noqa: F401
```

- [ ] **Step 3: import smoke test**

Run: `cd backend && python -c "from app.models.journal import JournalSession, JournalMessage; print('OK')"`
Expected: `OK`

- [ ] **Step 4: 커밋**

```bash
git add backend/app/models/journal.py backend/app/models/__init__.py
git commit -m "feat(journal): SQLAlchemy 모델 — JournalSession, JournalMessage"
```

---

## Task 3: JournalState 정의

**Files:**
- Create: `backend/app/agent/journal_state.py`

- [ ] **Step 1: State TypedDict 작성**

```python
# backend/app/agent/journal_state.py
from __future__ import annotations

from typing import Literal, TypedDict


class JournalState(TypedDict, total=False):
    # 세션 기본 정보
    session_id: str
    user_id: str

    # 대화 상태
    messages: list[dict]  # 전체 대화 히스토리 [{role, content, mode}]
    mode: Literal["journal", "counseling"]
    user_message: str  # 현재 사용자 입력

    # RAG 컨텍스트 (세션 시작 시 로드)
    journal_context: list[dict]  # 오늘 추출된 인사이트

    # 추출 상태
    extracted_count: int

    # 과금
    message_count: int
    free_messages_used: int

    # AI 응답
    ai_response: str

    # 요약
    session_summary: str | None

    # SSE 이벤트 큐
    pending_events: list[dict]
```

- [ ] **Step 2: import test**

Run: `cd backend && python -c "from app.agent.journal_state import JournalState; print('OK')"`
Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/journal_state.py
git commit -m "feat(journal): JournalState TypedDict 정의"
```

---

## Task 4: 프롬프트 템플릿

**Files:**
- Create: `backend/app/prompts/journal.py`

- [ ] **Step 1: 프롬프트 작성**

```python
# backend/app/prompts/journal.py

ROUTER_PROMPT = """사용자의 메시지를 분석하여 대화 모드를 판단하세요.

현재 모드: {current_mode}
최근 대화:
{recent_messages}

사용자 메시지: {user_message}

다음 JSON으로 응답하세요:
{{
  "mode": "journal" 또는 "counseling",
  "reason": "판단 이유 (한 문장)"
}}

판단 기준:
- journal: 일상 보고, 하루 돌아보기, 사건 나열, 가벼운 감상
- counseling: 깊은 고민, 감정 토로, 스트레스, 불안, 관계 갈등, 조언 요청
- 모호한 경우 현재 모드를 유지하세요 (불필요한 전환 방지)
"""

JOURNAL_SYSTEM_PROMPT = """당신은 사용자의 하루를 함께 정리해주는 친구입니다.

성격:
- 편안하고 가벼운 톤 (반말 사용)
- 관심 있게 질문하며 하루를 이끌어냄
- "오늘 뭐했어?", "그거 어땠어?" 같은 자연스러운 대화

규칙:
- 2-3문장으로 짧게 응답
- 사용자가 말한 내용에 반응하고, 다음 이야기를 자연스럽게 유도
- 판단하거나 평가하지 않기
- 사용자가 감정을 드러내면 공감하되, 상담 모드로 깊이 들어가지는 않기

{context}"""

COUNSELING_SYSTEM_PROMPT = """당신은 공감적이고 전문적인 상담사입니다.

성격:
- 차분하고 진지한 톤 (존댓말 사용)
- 깊이 있는 질문으로 감정과 생각을 탐색
- 공감 먼저, 조언은 사용자가 원할 때만

규칙:
- 2-3문장으로 응답
- 감정을 명명하고 수용해주기 ("그런 상황이면 속상하셨겠어요")
- 구조화된 질문 사용 ("그때 어떤 생각이 드셨나요?", "가장 힘들었던 부분은요?")
- 섣부른 해결책 제시 금지
- 심각한 정신건강 이슈 감지 시 전문가 상담 권유

{context}"""

EXTRACTOR_PROMPT = """다음 대화에서 사용자에 대해 기억할 만한 정보를 추출하세요.

대화:
{conversation}

다음 JSON으로 응답하세요:
{{
  "items": [
    {{
      "category": "emotion|event|growth|concern|relationship|goal",
      "content": "추출된 정보 (구체적으로, 1-2문장)",
      "importance": "high|medium|low"
    }}
  ]
}}

추출 기준:
- emotion: 감정 상태와 원인 ("직장 상사의 부당한 지시에 화남")
- event: 구체적 사건 ("팀 회식에서 프레젠테이션 발표")
- growth: 배운 것, 성장 ("Docker 네트워크 개념 이해함")
- concern: 고민, 걱정 ("이직 준비 시작할지 고민")
- relationship: 인간관계 변화 ("동료 A와 오해 해소")
- goal: 목표, 계획 ("다음 주까지 포트폴리오 정리")

규칙:
- 저장할 만한 정보가 없으면 items를 빈 배열로 반환
- 이미 추출된 기존 인사이트와 중복되는 내용은 스킵
- importance가 low인 것은 포함하지 않기
- 일상적 인사("안녕", "오늘 피곤해")는 추출하지 않기
"""

SUMMARIZER_PROMPT = """다음 대화를 읽고 오늘의 하루 요약을 작성하세요.

대화:
{conversation}

다음 JSON으로 응답하세요:
{{
  "summary": "오늘의 하루 요약 (3-5문장, 핵심 사건/감정/결론 포함)",
  "mood": "오늘의 전반적 기분 (한 단어: 좋음/보통/힘듦/복잡함 등)",
  "highlights": ["핵심 포인트 1", "핵심 포인트 2"]
}}
"""
```

- [ ] **Step 2: import test**

Run: `cd backend && python -c "from app.prompts.journal import ROUTER_PROMPT, JOURNAL_SYSTEM_PROMPT; print('OK')"`
Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add backend/app/prompts/journal.py
git commit -m "feat(journal): 프롬프트 템플릿 — router, journal, counseling, extractor, summarizer"
```

---

## Task 5: Journal RAG (journal_embeddings CRUD)

**Files:**
- Create: `backend/app/agent/journal_rag.py`

- [ ] **Step 1: RAG 함수 작성**

기존 `profile_agent.py`의 `search_profile`/`update_profile` 패턴을 따르되, 테이블만 `journal_embeddings`로 변경.

```python
# backend/app/agent/journal_rag.py
from __future__ import annotations

import json
import logging
from datetime import date
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import create_embedding

logger = logging.getLogger(__name__)

TOP_K = 10
SIMILARITY_THRESHOLD = 0.85


async def search_journal(
    db: AsyncSession,
    user_id: str,
    query: str,
    top_k: int = TOP_K,
    category: str | None = None,
    since_date: date | None = None,
) -> list[dict]:
    """Search journal embeddings by cosine similarity."""
    query_embedding = await create_embedding(query)
    embedding_str = "[" + ",".join(str(v) for v in query_embedding) + "]"

    conditions = ['"userId" = :user_id']
    params: dict = {"user_id": user_id, "embedding": embedding_str, "top_k": top_k}

    if category:
        conditions.append("category = :category")
        params["category"] = category

    if since_date:
        conditions.append('"createdAt" >= :since_date')
        params["since_date"] = since_date.isoformat()

    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT id, category, content, metadata,
                   1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM journal_embeddings
            WHERE {where_clause}
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """),
        params,
    )
    rows = result.fetchall()
    return [
        {
            "id": str(row.id),
            "category": row.category,
            "content": row.content,
            "metadata": row.metadata,
            "similarity": round(row.similarity, 4),
        }
        for row in rows
    ]


async def upsert_journal_embedding(
    db: AsyncSession,
    user_id: str,
    category: str,
    content: str,
    metadata: dict | None = None,
) -> str:
    """Upsert a journal embedding. If similar entry exists (>=0.85), update it."""
    embedding = await create_embedding(content)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    result = await db.execute(
        text("""
            SELECT id, 1 - (embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM journal_embeddings
            WHERE "userId" = :user_id AND category = :category
            ORDER BY embedding <=> CAST(:embedding AS vector)
            LIMIT 1
        """),
        {"user_id": user_id, "embedding": embedding_str, "category": category},
    )
    existing = result.fetchone()

    meta_json = json.dumps(metadata or {})

    if existing and existing.similarity >= SIMILARITY_THRESHOLD:
        await db.execute(
            text("""
                UPDATE journal_embeddings
                SET content = :content, embedding = CAST(:embedding AS vector),
                    metadata = :metadata, "updatedAt" = NOW()
                WHERE id = :id
            """),
            {
                "id": str(existing.id),
                "content": content,
                "embedding": embedding_str,
                "metadata": meta_json,
            },
        )
        await db.commit()
        return str(existing.id)
    else:
        new_id = str(uuid4())
        await db.execute(
            text("""
                INSERT INTO journal_embeddings (id, "userId", category, content, embedding, metadata)
                VALUES (:id, :user_id, :category, :content, CAST(:embedding AS vector), :metadata)
            """),
            {
                "id": new_id,
                "user_id": user_id,
                "category": category,
                "content": content,
                "embedding": embedding_str,
                "metadata": meta_json,
            },
        )
        await db.commit()
        return new_id


async def load_today_context(
    db: AsyncSession,
    user_id: str,
    today: date,
) -> list[dict]:
    """Load today's journal embeddings for context restoration."""
    result = await db.execute(
        text("""
            SELECT id, category, content, metadata
            FROM journal_embeddings
            WHERE "userId" = :user_id
              AND DATE("createdAt") = :today
            ORDER BY "createdAt" DESC
        """),
        {"user_id": user_id, "today": today.isoformat()},
    )
    rows = result.fetchall()
    return [
        {
            "id": str(row.id),
            "category": row.category,
            "content": row.content,
            "metadata": row.metadata,
        }
        for row in rows
    ]
```

- [ ] **Step 2: import test**

Run: `cd backend && python -c "from app.agent.journal_rag import search_journal, upsert_journal_embedding, load_today_context; print('OK')"`
Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/journal_rag.py
git commit -m "feat(journal): journal_rag — journal_embeddings 검색/upsert/오늘 컨텍스트 로드"
```

---

## Task 6: 에이전트 함수들 (router, journal, counseling, extractor, summarizer)

**Files:**
- Create: `backend/app/agent/journal_router_agent.py`
- Create: `backend/app/agent/journal_agent.py`
- Create: `backend/app/agent/counseling_agent.py`
- Create: `backend/app/agent/journal_extractor.py`
- Create: `backend/app/agent/journal_summarizer.py`

- [ ] **Step 1: Router agent 작성**

```python
# backend/app/agent/journal_router_agent.py
from __future__ import annotations

import logging

from app.lib.anthropic_client import call_llm_json
from app.config import settings
from app.prompts.journal import ROUTER_PROMPT

logger = logging.getLogger(__name__)

# 상담 모드 전환 키워드 (규칙 기반 우선 판단)
_COUNSELING_KEYWORDS = [
    "힘들", "스트레스", "불안", "우울", "걱정", "고민",
    "짜증", "화가", "속상", "외로", "무기력", "자신감",
    "갈등", "싸우", "다퉜", "두렵", "무서",
]

_JOURNAL_KEYWORDS = [
    "오늘", "했어", "갔다", "먹었", "봤어", "만났",
    "회사에서", "집에서", "학교에서",
]


async def classify_intent(
    user_message: str,
    current_mode: str,
    recent_messages: list[dict],
) -> dict:
    """Classify user intent as journal or counseling.
    Returns: {"mode": "journal"|"counseling", "reason": "..."}
    """
    msg_lower = user_message.lower()

    # 규칙 기반 우선 판단
    counseling_score = sum(1 for kw in _COUNSELING_KEYWORDS if kw in msg_lower)
    journal_score = sum(1 for kw in _JOURNAL_KEYWORDS if kw in msg_lower)

    if counseling_score >= 2 and counseling_score > journal_score:
        return {"mode": "counseling", "reason": "감정/고민 키워드 감지"}
    if journal_score >= 2 and journal_score > counseling_score:
        return {"mode": "journal", "reason": "일상 보고 키워드 감지"}

    # 애매하면 현재 모드 유지 (LLM 호출 없이)
    if counseling_score == 0 and journal_score == 0:
        return {"mode": current_mode, "reason": "키워드 없음, 현재 모드 유지"}

    # 둘 다 감지되면 LLM 판단
    recent_text = ""
    for m in recent_messages[-3:]:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        recent_text += f"{role_label}: {m.get('content', '')}\n"

    prompt = ROUTER_PROMPT.format(
        current_mode=current_mode,
        recent_messages=recent_text or "(대화 시작)",
        user_message=user_message,
    )

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.1)
        mode = result.get("mode", current_mode)
        if mode not in ("journal", "counseling"):
            mode = current_mode
        return {"mode": mode, "reason": result.get("reason", "")}
    except Exception:
        logger.exception("Router classification failed, keeping current mode")
        return {"mode": current_mode, "reason": "분류 실패, 현재 모드 유지"}
```

- [ ] **Step 2: Journal agent 작성**

```python
# backend/app/agent/journal_agent.py
from __future__ import annotations

import logging

from app.lib.anthropic_client import call_llm
from app.config import settings
from app.prompts.journal import JOURNAL_SYSTEM_PROMPT

logger = logging.getLogger(__name__)


async def generate_response(
    messages: list[dict],
    user_message: str,
    journal_context: list[dict],
) -> str:
    """Generate journal-mode response."""
    context_parts = []
    if journal_context:
        context_parts.append("오늘 이야기된 내용:")
        for item in journal_context[:5]:
            context_parts.append(f"- [{item['category']}] {item['content']}")

    context_str = "\n".join(context_parts) if context_parts else ""
    system = JOURNAL_SYSTEM_PROMPT.format(context=context_str)

    # 최근 메시지를 대화 형태로 구성
    conversation = ""
    for m in messages[-10:]:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        conversation += f"{role_label}: {m.get('content', '')}\n"
    conversation += f"사용자: {user_message}\n"

    prompt = f"다음 대화에 이어서 응답하세요.\n\n{conversation}"

    response = await call_llm(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.7,
        system=system,
        max_tokens=500,
    )
    return response.strip()
```

- [ ] **Step 3: Counseling agent 작성**

```python
# backend/app/agent/counseling_agent.py
from __future__ import annotations

import logging

from app.lib.anthropic_client import call_llm
from app.config import settings
from app.prompts.journal import COUNSELING_SYSTEM_PROMPT

logger = logging.getLogger(__name__)


async def generate_response(
    messages: list[dict],
    user_message: str,
    journal_context: list[dict],
) -> str:
    """Generate counseling-mode response."""
    context_parts = []
    if journal_context:
        context_parts.append("사용자에 대해 알고 있는 정보:")
        for item in journal_context[:5]:
            context_parts.append(f"- [{item['category']}] {item['content']}")

    context_str = "\n".join(context_parts) if context_parts else ""
    system = COUNSELING_SYSTEM_PROMPT.format(context=context_str)

    conversation = ""
    for m in messages[-10:]:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        conversation += f"{role_label}: {m.get('content', '')}\n"
    conversation += f"사용자: {user_message}\n"

    prompt = f"다음 대화에 이어서 응답하세요.\n\n{conversation}"

    response = await call_llm(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.7,
        system=system,
        max_tokens=500,
    )
    return response.strip()
```

- [ ] **Step 4: Extractor agent 작성**

```python
# backend/app/agent/journal_extractor.py
from __future__ import annotations

import logging
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.anthropic_client import call_llm_json
from app.config import settings
from app.prompts.journal import EXTRACTOR_PROMPT
from app.agent.journal_rag import upsert_journal_embedding

logger = logging.getLogger(__name__)

VALID_CATEGORIES = {"emotion", "event", "growth", "concern", "relationship", "goal"}


async def extract_and_save(
    db: AsyncSession,
    user_id: str,
    session_id: str,
    messages: list[dict],
    user_message: str,
) -> int:
    """Extract insights from the latest exchange and save to RAG.
    Returns number of items saved.
    """
    # 최근 2턴만 분석 (직전 AI 응답 + 현재 사용자 메시지)
    recent = ""
    for m in messages[-2:]:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        recent += f"{role_label}: {m.get('content', '')}\n"
    recent += f"사용자: {user_message}\n"

    prompt = EXTRACTOR_PROMPT.format(conversation=recent)

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.2)
    except Exception:
        logger.exception("Extractor LLM call failed")
        return 0

    items = result.get("items", [])
    saved = 0

    for item in items:
        category = item.get("category", "")
        content = item.get("content", "")
        importance = item.get("importance", "low")

        if not content or category not in VALID_CATEGORIES or importance == "low":
            continue

        metadata = {
            "session_id": session_id,
            "date": date.today().isoformat(),
            "importance": importance,
        }

        try:
            await upsert_journal_embedding(db, user_id, category, content, metadata)
            saved += 1
        except Exception:
            logger.exception("Failed to save journal embedding: %s", content[:50])

    return saved
```

- [ ] **Step 5: Summarizer agent 작성**

```python
# backend/app/agent/journal_summarizer.py
from __future__ import annotations

import logging
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.anthropic_client import call_llm_json
from app.config import settings
from app.prompts.journal import SUMMARIZER_PROMPT
from app.agent.journal_rag import upsert_journal_embedding

logger = logging.getLogger(__name__)


async def generate_summary(
    db: AsyncSession,
    user_id: str,
    session_id: str,
    messages: list[dict],
) -> dict:
    """Generate session summary and save to RAG.
    Returns: {"summary": "...", "mood": "...", "highlights": [...]}
    """
    if not messages:
        return {"summary": "대화 없음", "mood": "보통", "highlights": []}

    conversation = ""
    for m in messages:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        conversation += f"{role_label}: {m.get('content', '')}\n"

    prompt = SUMMARIZER_PROMPT.format(conversation=conversation)

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)
    except Exception:
        logger.exception("Summarizer LLM call failed")
        return {"summary": "요약 생성 실패", "mood": "알 수 없음", "highlights": []}

    summary = result.get("summary", "")

    # Save summary to RAG
    if summary:
        metadata = {
            "session_id": session_id,
            "date": date.today().isoformat(),
            "mood": result.get("mood", ""),
            "highlights": result.get("highlights", []),
        }
        try:
            await upsert_journal_embedding(
                db, user_id, "daily_summary", summary, metadata,
            )
        except Exception:
            logger.exception("Failed to save summary to RAG")

    return result
```

- [ ] **Step 6: import test**

Run: `cd backend && python -c "from app.agent.journal_router_agent import classify_intent; from app.agent.journal_agent import generate_response; from app.agent.counseling_agent import generate_response as cr; from app.agent.journal_extractor import extract_and_save; from app.agent.journal_summarizer import generate_summary; print('OK')"`
Expected: `OK`

- [ ] **Step 7: 커밋**

```bash
git add backend/app/agent/journal_router_agent.py backend/app/agent/journal_agent.py backend/app/agent/counseling_agent.py backend/app/agent/journal_extractor.py backend/app/agent/journal_summarizer.py
git commit -m "feat(journal): 에이전트 5종 — router, journal, counseling, extractor, summarizer"
```

---

## Task 7: 노드 함수들

**Files:**
- Create: `backend/app/agent/journal_nodes.py`

- [ ] **Step 1: 노드 함수 작성**

```python
# backend/app/agent/journal_nodes.py
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.journal_state import JournalState
from app.agent import journal_router_agent, journal_agent, counseling_agent
from app.agent import journal_extractor, journal_summarizer

logger = logging.getLogger(__name__)


async def route_and_respond(state: JournalState, db: AsyncSession) -> JournalState:
    """Route user message to journal or counseling agent, generate response."""
    events = list(state.get("pending_events", []))
    messages = list(state.get("messages", []))
    user_message = state["user_message"]
    current_mode = state.get("mode", "journal")

    # 1. Classify intent
    classification = await journal_router_agent.classify_intent(
        user_message,
        current_mode,
        messages,
    )
    new_mode = classification["mode"]

    # Notify mode change if switched
    if new_mode != current_mode:
        events.append({
            "event": "status",
            "data": {"phase": "mode_change", "mode": new_mode, "reason": classification["reason"]},
        })

    # 2. Generate response based on mode
    journal_context = state.get("journal_context", [])

    if new_mode == "counseling":
        ai_response = await counseling_agent.generate_response(messages, user_message, journal_context)
    else:
        ai_response = await journal_agent.generate_response(messages, user_message, journal_context)

    # 3. Update messages
    messages.append({"role": "user", "content": user_message, "mode": new_mode})
    messages.append({"role": "assistant", "content": ai_response, "mode": new_mode})

    events.append({
        "event": "response",
        "data": {"content": ai_response, "mode": new_mode},
    })

    return {
        **state,
        "messages": messages,
        "mode": new_mode,
        "ai_response": ai_response,
        "message_count": state.get("message_count", 0) + 1,
        "pending_events": events,
    }


async def extract(state: JournalState, db: AsyncSession) -> JournalState:
    """Extract insights from conversation and save to RAG. Runs in parallel with response."""
    saved = await journal_extractor.extract_and_save(
        db,
        state["user_id"],
        state["session_id"],
        state.get("messages", []),
        state["user_message"],
    )

    events = list(state.get("pending_events", []))
    if saved > 0:
        events.append({
            "event": "extracted",
            "data": {"count": saved},
        })

    return {
        **state,
        "extracted_count": state.get("extracted_count", 0) + saved,
        "pending_events": events,
    }


async def summarize(state: JournalState, db: AsyncSession) -> JournalState:
    """Generate session summary on end."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "summarizing"}})

    result = await journal_summarizer.generate_summary(
        db,
        state["user_id"],
        state["session_id"],
        state.get("messages", []),
    )

    events.append({
        "event": "summary",
        "data": result,
    })

    return {
        **state,
        "session_summary": result.get("summary", ""),
        "pending_events": events,
    }
```

- [ ] **Step 2: import test**

Run: `cd backend && python -c "from app.agent.journal_nodes import route_and_respond, extract, summarize; print('OK')"`
Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/journal_nodes.py
git commit -m "feat(journal): 노드 함수 — route_and_respond, extract, summarize"
```

---

## Task 8: API 라우터

**Files:**
- Create: `backend/app/routers/journal.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: 라우터 작성**

```python
# backend/app/routers/journal.py
from __future__ import annotations

import json
import logging
from datetime import date, datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.agent import journal_nodes
from app.agent.journal_state import JournalState
from app.agent.journal_rag import load_today_context
from app.models.journal import JournalSession, JournalMessage

logger = logging.getLogger(__name__)

router = APIRouter()

FREE_MESSAGE_LIMIT = 10
COST_PER_MESSAGE = 1


# ---------- Schemas ----------

class MessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


# ---------- POST /api/journal/start ----------

@router.post("/api/journal/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start or resume today's journal session."""
    today = date.today()

    # Check for existing active session today
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
            sa_func.date(JournalSession.created_at) == today,
        )
        .options(selectinload(JournalSession.messages))
    )
    existing = result.scalar_one_or_none()

    if existing:
        # Resume: load recent messages + today's context
        messages = sorted(existing.messages, key=lambda m: m.message_index)
        recent = messages[-5:] if len(messages) > 5 else messages
        context = await load_today_context(db, user.id, today)

        return {
            "sessionId": existing.id,
            "resumed": True,
            "messages": [
                {
                    "role": m.role,
                    "content": m.content,
                    "mode": m.mode,
                }
                for m in recent
            ],
            "context": [{"category": c["category"], "content": c["content"]} for c in context],
            "messageCount": existing.message_count,
            "freeMessagesUsed": existing.free_messages_used,
        }

    # New session
    session_id = str(uuid4())
    session = JournalSession(
        id=session_id,
        user_id=user.id,
    )
    db.add(session)
    await db.commit()

    context = await load_today_context(db, user.id, today)

    return {
        "sessionId": session_id,
        "resumed": False,
        "messages": [],
        "context": [{"category": c["category"], "content": c["content"]} for c in context],
        "messageCount": 0,
        "freeMessagesUsed": 0,
    }


# ---------- POST /api/journal/message ----------

@router.post("/api/journal/{session_id}/message")
async def send_message(
    session_id: str,
    body: MessageRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Send a message and get AI response via SSE."""
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.id == session_id,
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
        )
        .options(selectinload(JournalSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Credit check (after free limit)
    if session.free_messages_used >= FREE_MESSAGE_LIMIT:
        from sqlalchemy import text
        credit_result = await db.execute(
            text("""
                UPDATE users SET "creditBalance" = "creditBalance" - :cost
                WHERE id = :user_id AND "creditBalance" >= :cost
            """),
            {"user_id": user.id, "cost": COST_PER_MESSAGE},
        )
        if credit_result.rowcount == 0:
            raise HTTPException(402, {"error": "크레딧이 부족합니다", "code": "INSUFFICIENT_CREDITS"})

    # Rebuild conversation history from DB
    db_messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation: list[dict] = [
        {"role": m.role, "content": m.content, "mode": m.mode}
        for m in db_messages
    ]

    today = date.today()
    journal_context = await load_today_context(db, user.id, today)

    # Determine current mode from last message
    current_mode = "journal"
    if db_messages:
        current_mode = db_messages[-1].mode or "journal"

    next_index = len(db_messages)

    state: JournalState = {
        "session_id": session_id,
        "user_id": user.id,
        "messages": conversation,
        "mode": current_mode,
        "user_message": body.message,
        "journal_context": [
            {"category": c["category"], "content": c["content"]}
            for c in journal_context
        ],
        "extracted_count": 0,
        "message_count": session.message_count,
        "free_messages_used": session.free_messages_used,
        "ai_response": "",
        "session_summary": None,
        "pending_events": [],
    }

    async def event_generator():
        nonlocal state, next_index
        try:
            # Route + respond
            state = await journal_nodes.route_and_respond(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Save user message to DB
            user_msg = JournalMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=next_index,
                role="user",
                content=body.message,
                mode=state["mode"],
            )
            db.add(user_msg)
            next_index += 1

            # Save AI response to DB
            ai_msg = JournalMessage(
                id=uuid4(),
                session_id=session_id,
                message_index=next_index,
                role="assistant",
                content=state["ai_response"],
                mode=state["mode"],
            )
            db.add(ai_msg)
            next_index += 1

            # Update session counters
            session.message_count = state["message_count"]
            if session.free_messages_used < FREE_MESSAGE_LIMIT:
                session.free_messages_used = session.free_messages_used + 1
            else:
                session.credits_charged = session.credits_charged + COST_PER_MESSAGE

            await db.commit()

            # Extract (async, doesn't block response — but we await since we need the same db session)
            state["pending_events"] = []
            state = await journal_nodes.extract(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}

        except Exception:
            logger.exception("Journal message processing failed")
            yield {"event": "error", "data": json.dumps({"error": "메시지 처리에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/journal/{session_id}/end ----------

@router.post("/api/journal/{session_id}/end")
async def end_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """End journal session and generate summary."""
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.id == session_id,
            JournalSession.user_id == user.id,
            JournalSession.status == "active",
        )
        .options(selectinload(JournalSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Empty session → just close
    if session.message_count == 0:
        session.status = "completed"
        await db.commit()
        return {"status": "completed", "summary": None}

    # Build conversation for summary
    db_messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation = [
        {"role": m.role, "content": m.content, "mode": m.mode}
        for m in db_messages
    ]

    state: JournalState = {
        "session_id": session_id,
        "user_id": user.id,
        "messages": conversation,
        "mode": "journal",
        "user_message": "",
        "journal_context": [],
        "extracted_count": 0,
        "message_count": session.message_count,
        "free_messages_used": session.free_messages_used,
        "ai_response": "",
        "session_summary": None,
        "pending_events": [],
    }

    state = await journal_nodes.summarize(state, db)

    session.status = "completed"
    session.summary = state.get("session_summary", "")
    await db.commit()

    # Extract summary event data
    summary_data = None
    for ev in state.get("pending_events", []):
        if ev["event"] == "summary":
            summary_data = ev["data"]
            break

    return {"status": "completed", "summary": summary_data}


# ---------- GET /api/journal/history ----------

@router.get("/api/journal/history")
async def get_history(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get journal session summaries (completed only)."""
    result = await db.execute(
        select(JournalSession)
        .where(
            JournalSession.user_id == user.id,
            JournalSession.status.in_(["completed", "timeout"]),
        )
        .order_by(JournalSession.created_at.desc())
        .limit(30)
    )
    sessions = result.scalars().all()

    return [
        {
            "id": s.id,
            "summary": s.summary,
            "messageCount": s.message_count,
            "status": s.status,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
        }
        for s in sessions
    ]


# ---------- GET /api/journal/{session_id} ----------

@router.get("/api/journal/{session_id}")
async def get_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific journal session summary."""
    result = await db.execute(
        select(JournalSession).where(
            JournalSession.id == session_id,
            JournalSession.user_id == user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    return {
        "id": session.id,
        "status": session.status,
        "summary": session.summary,
        "messageCount": session.message_count,
        "createdAt": session.created_at.isoformat() if session.created_at else None,
    }
```

- [ ] **Step 2: main.py에 라우터 등록**

`backend/app/main.py`에서 `from app.routers.agent_interview import router as agent_interview_router` 줄 아래에 추가:
```python
from app.routers.journal import router as journal_router
```

`app.include_router(agent_interview_router)` 줄 아래에 추가:
```python
app.include_router(journal_router)
```

- [ ] **Step 3: import smoke test**

Run: `cd backend && python -c "from app.routers.journal import router; print('OK')"`
Expected: `OK`

- [ ] **Step 4: 커밋**

```bash
git add backend/app/routers/journal.py backend/app/main.py
git commit -m "feat(journal): API 라우터 — start, message, end, history, get_session"
```

---

## Task 9: 프론트엔드 API + 타입

**Files:**
- Create: `frontend/src/lib/journal-api.ts`

- [ ] **Step 1: API 함수 작성**

```typescript
// frontend/src/lib/journal-api.ts
import { createSSEFromPost } from "@/lib/agent-interview-api";

export interface JournalStartResponse {
  sessionId: string;
  resumed: boolean;
  messages: JournalMessageData[];
  context: { category: string; content: string }[];
  messageCount: number;
  freeMessagesUsed: number;
}

export interface JournalMessageData {
  role: "user" | "assistant";
  content: string;
  mode: "journal" | "counseling";
}

export interface JournalSessionSummary {
  id: string;
  summary: string | null;
  messageCount: number;
  status: string;
  createdAt: string;
}

export interface JournalEndResponse {
  status: string;
  summary: {
    summary: string;
    mood: string;
    highlights: string[];
  } | null;
}

export async function startJournalSession(): Promise<JournalStartResponse> {
  const res = await fetch("/api/journal/start", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "세션 시작 실패" }));
    throw new Error(data.error || "세션 시작 실패");
  }
  return res.json();
}

export function sendJournalMessage(sessionId: string, message: string) {
  return createSSEFromPost(`/api/journal/${sessionId}/message`, { message });
}

export async function endJournalSession(sessionId: string): Promise<JournalEndResponse> {
  const res = await fetch(`/api/journal/${sessionId}/end`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "세션 종료 실패" }));
    throw new Error(data.error || "세션 종료 실패");
  }
  return res.json();
}

export async function getJournalHistory(): Promise<JournalSessionSummary[]> {
  const res = await fetch("/api/journal/history", {
    credentials: "include",
  });
  if (!res.ok) throw new Error("히스토리 조회 실패");
  return res.json();
}

export async function getJournalSession(sessionId: string) {
  const res = await fetch(`/api/journal/${sessionId}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("세션 조회 실패");
  return res.json();
}
```

- [ ] **Step 2: 커밋**

```bash
git add frontend/src/lib/journal-api.ts
git commit -m "feat(journal): 프론트엔드 API 함수 — start, message(SSE), end, history"
```

---

## Task 10: useJournalSession 훅

**Files:**
- Create: `frontend/src/hooks/useJournalSession.ts`

- [ ] **Step 1: 훅 작성**

```typescript
// frontend/src/hooks/useJournalSession.ts
import { useCallback, useRef, useState } from "react";
import {
  startJournalSession,
  sendJournalMessage,
  endJournalSession,
  type JournalMessageData,
  type JournalEndResponse,
} from "@/lib/journal-api";

export type JournalPhase =
  | "idle"
  | "starting"
  | "active"
  | "responding"
  | "summarizing"
  | "completed"
  | "error";

export interface JournalMessage {
  role: "user" | "assistant";
  content: string;
  mode: "journal" | "counseling";
}

export function useJournalSession() {
  const [phase, setPhase] = useState<JournalPhase>("idle");
  const [messages, setMessages] = useState<JournalMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<"journal" | "counseling">("journal");
  const [messageCount, setMessageCount] = useState(0);
  const [freeMessagesUsed, setFreeMessagesUsed] = useState(0);
  const [summary, setSummary] = useState<JournalEndResponse["summary"]>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<ReturnType<typeof sendJournalMessage> | null>(null);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    setPhase("starting");
    setError(null);

    try {
      const data = await startJournalSession();
      setSessionId(data.sessionId);
      setMessageCount(data.messageCount);
      setFreeMessagesUsed(data.freeMessagesUsed);

      if (data.resumed && data.messages.length > 0) {
        setMessages(
          data.messages.map((m: JournalMessageData) => ({
            role: m.role,
            content: m.content,
            mode: m.mode,
          })),
        );
        const lastMode = data.messages[data.messages.length - 1]?.mode || "journal";
        setMode(lastMode);
      } else {
        setMessages([]);
        setMode("journal");
      }

      setPhase("active");
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }, []);

  const sendMessage = useCallback(
    (message: string) => {
      if (!sessionId) return;
      cleanup();

      setMessages((prev) => [
        ...prev,
        { role: "user", content: message, mode },
      ]);
      setPhase("responding");

      const source = sendJournalMessage(sessionId, message);
      sourceRef.current = source;

      source.addEventListener("response", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.content, mode: data.mode },
        ]);
        setMode(data.mode);
        setMessageCount((prev) => prev + 1);
        setPhase("active");
      });

      source.addEventListener("status", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        if (data.phase === "mode_change") {
          setMode(data.mode);
        }
      });

      source.addEventListener("error", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.code === "INSUFFICIENT_CREDITS") {
            setError("크레딧이 부족합니다");
          } else {
            setError(data.error || "오류가 발생했습니다");
          }
        } catch {
          setError("연결이 끊어졌습니다");
        }
        setPhase("error");
        cleanup();
      });
    },
    [sessionId, mode, cleanup],
  );

  const end = useCallback(async () => {
    if (!sessionId) return;
    cleanup();
    setPhase("summarizing");

    try {
      const data = await endJournalSession(sessionId);
      setSummary(data.summary);
      setPhase("completed");
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }, [sessionId, cleanup]);

  return {
    phase,
    messages,
    sessionId,
    mode,
    messageCount,
    freeMessagesUsed,
    summary,
    error,
    start,
    sendMessage,
    end,
  };
}
```

- [ ] **Step 2: 커밋**

```bash
git add frontend/src/hooks/useJournalSession.ts
git commit -m "feat(journal): useJournalSession 훅 — 세션 관리 + SSE 메시지 처리"
```

---

## Task 11: useInactivityTimer 훅

**Files:**
- Create: `frontend/src/hooks/useInactivityTimer.ts`

- [ ] **Step 1: 훅 작성**

```typescript
// frontend/src/hooks/useInactivityTimer.ts
import { useCallback, useEffect, useRef, useState } from "react";

interface UseInactivityTimerOptions {
  timeoutMs: number;      // 비활동 시간 (기본 120000 = 2분)
  warningMs: number;      // 경고 후 자동 종료까지 시간 (기본 10000 = 10초)
  onWarning: () => void;  // 경고 콜백
  onTimeout: () => void;  // 타임아웃 콜백
  enabled: boolean;
}

export function useInactivityTimer({
  timeoutMs = 120000,
  warningMs = 10000,
  onWarning,
  onTimeout,
  enabled,
}: UseInactivityTimerOptions) {
  const [isWarning, setIsWarning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    setIsWarning(false);
  }, []);

  const resetTimer = useCallback(() => {
    clearTimers();

    if (!enabled) return;

    timerRef.current = setTimeout(() => {
      setIsWarning(true);
      onWarning();

      warningTimerRef.current = setTimeout(() => {
        onTimeout();
      }, warningMs);
    }, timeoutMs);
  }, [enabled, timeoutMs, warningMs, onWarning, onTimeout, clearTimers]);

  const dismiss = useCallback(() => {
    clearTimers();
    resetTimer();
  }, [clearTimers, resetTimer]);

  useEffect(() => {
    if (enabled) {
      resetTimer();
    } else {
      clearTimers();
    }
    return clearTimers;
  }, [enabled, resetTimer, clearTimers]);

  return { isWarning, resetTimer, dismiss };
}
```

- [ ] **Step 2: 커밋**

```bash
git add frontend/src/hooks/useInactivityTimer.ts
git commit -m "feat(journal): useInactivityTimer 훅 — 2분 비활동 경고 + 10초 자동 종료"
```

---

## Task 12: UI 컴포넌트 — 메시지, 모드 인디케이터, 요약 카드

**Files:**
- Create: `frontend/src/components/journal/journal-message.tsx`
- Create: `frontend/src/components/journal/mode-indicator.tsx`
- Create: `frontend/src/components/journal/session-summary-card.tsx`

- [ ] **Step 1: journal-message.tsx 작성**

```tsx
// frontend/src/components/journal/journal-message.tsx
"use client";

import { cn } from "@/lib/utils";

interface JournalMessageProps {
  role: "user" | "assistant";
  content: string;
  mode: "journal" | "counseling";
}

export function JournalMessage({ role, content, mode }: JournalMessageProps) {
  const isUser = role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : mode === "counseling"
              ? "bg-violet-100 text-violet-900 dark:bg-violet-900/30 dark:text-violet-100"
              : "bg-muted text-foreground",
        )}
      >
        {content}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: mode-indicator.tsx 작성**

```tsx
// frontend/src/components/journal/mode-indicator.tsx
"use client";

import { cn } from "@/lib/utils";
import { BookOpen, Heart } from "lucide-react";

interface ModeIndicatorProps {
  mode: "journal" | "counseling";
}

export function ModeIndicator({ mode }: ModeIndicatorProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        mode === "journal"
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          : "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
      )}
    >
      {mode === "journal" ? (
        <BookOpen className="h-3 w-3" />
      ) : (
        <Heart className="h-3 w-3" />
      )}
      {mode === "journal" ? "하루 정리" : "상담"}
    </div>
  );
}
```

- [ ] **Step 3: session-summary-card.tsx 작성**

```tsx
// frontend/src/components/journal/session-summary-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SessionSummaryCardProps {
  summary: {
    summary: string;
    mood: string;
    highlights: string[];
  };
  date?: string;
}

export function SessionSummaryCard({ summary, date }: SessionSummaryCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">오늘의 기록</CardTitle>
          {date && (
            <span className="text-sm text-muted-foreground">{date}</span>
          )}
        </div>
        <div className="inline-flex w-fit items-center rounded-full bg-muted px-2.5 py-0.5 text-xs">
          기분: {summary.mood}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed">{summary.summary}</p>
        {summary.highlights.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">하이라이트</p>
            <ul className="space-y-1">
              {summary.highlights.map((h, i) => (
                <li key={i} className="text-sm text-muted-foreground">
                  &bull; {h}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/components/journal/journal-message.tsx frontend/src/components/journal/mode-indicator.tsx frontend/src/components/journal/session-summary-card.tsx
git commit -m "feat(journal): UI 컴포넌트 — JournalMessage, ModeIndicator, SessionSummaryCard"
```

---

## Task 13: UI 컴포넌트 — 음성 입력 바 + 대화 패널

**Files:**
- Create: `frontend/src/components/journal/voice-input-bar.tsx`
- Create: `frontend/src/components/journal/journal-panel.tsx`

- [ ] **Step 1: voice-input-bar.tsx 작성**

```tsx
// frontend/src/components/journal/voice-input-bar.tsx
"use client";

import { useRef, useState } from "react";
import { Mic, MicOff, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface VoiceInputBarProps {
  onSubmit: (text: string) => void;
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  onStartListening: () => void;
  onStopListening: () => void;
  disabled?: boolean;
}

export function VoiceInputBar({
  onSubmit,
  isListening,
  transcript,
  interimTranscript,
  onStartListening,
  onStopListening,
  disabled = false,
}: VoiceInputBarProps) {
  const [manualText, setManualText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const displayText = isListening
    ? (transcript + " " + interimTranscript).trim()
    : manualText;

  const handleSubmit = () => {
    const text = isListening ? transcript.trim() : manualText.trim();
    if (!text) return;

    if (isListening) {
      onStopListening();
    }
    onSubmit(text);
    setManualText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t bg-card p-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={isListening ? "destructive" : "outline"}
          size="icon"
          className="shrink-0"
          onClick={isListening ? onStopListening : onStartListening}
          disabled={disabled}
        >
          {isListening ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>

        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={displayText}
            onChange={(e) => {
              if (!isListening) setManualText(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? "말씀하세요..." : "텍스트로 입력하기..."}
            disabled={disabled}
            readOnly={isListening}
            className={cn(
              "w-full rounded-lg border bg-background px-4 py-2.5 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-primary/50",
              isListening && "animate-pulse border-red-300 dark:border-red-700",
            )}
          />
        </div>

        <Button
          type="button"
          size="icon"
          className="shrink-0"
          onClick={handleSubmit}
          disabled={disabled || !displayText.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: journal-panel.tsx 작성**

```tsx
// frontend/src/components/journal/journal-panel.tsx
"use client";

import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useJournalSession } from "@/hooks/useJournalSession";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useInactivityTimer } from "@/hooks/useInactivityTimer";
import { useToast } from "@/hooks/use-toast";
import { normalizeTranscript } from "@/lib/transcript";
import { JournalMessage } from "@/components/journal/journal-message";
import { ModeIndicator } from "@/components/journal/mode-indicator";
import { SessionSummaryCard } from "@/components/journal/session-summary-card";
import { VoiceInputBar } from "@/components/journal/voice-input-bar";
import { Loader2, Square } from "lucide-react";

export function JournalPanel() {
  const journal = useJournalSession();
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const { toast } = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const lastAiMessageRef = useRef<string>("");

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [journal.messages]);

  // Start session on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    journal.start();
  }, [journal.start]);

  // TTS for AI responses
  useEffect(() => {
    const lastMsg = journal.messages[journal.messages.length - 1];
    if (
      lastMsg?.role === "assistant" &&
      lastMsg.content !== lastAiMessageRef.current
    ) {
      lastAiMessageRef.current = lastMsg.content;
      tts.speak(lastMsg.content);
    }
  }, [journal.messages, tts]);

  // Inactivity timer
  const handleWarning = useCallback(() => {
    toast({
      title: "오늘은 여기까지 할까요?",
      description: "10초 후 자동으로 마무리됩니다.",
    });
  }, [toast]);

  const inactivity = useInactivityTimer({
    timeoutMs: 120000,
    warningMs: 10000,
    onWarning: handleWarning,
    onTimeout: journal.end,
    enabled: journal.phase === "active",
  });

  const handleSubmit = useCallback(
    (text: string) => {
      const normalized = normalizeTranscript(text);
      if (!normalized) return;
      journal.sendMessage(normalized);
      speech.resetTranscript();
      inactivity.resetTimer();
    },
    [journal, speech, inactivity],
  );

  // Completed state
  if (journal.phase === "completed" && journal.summary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        <SessionSummaryCard summary={journal.summary} />
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => {
            startedRef.current = false;
            journal.start();
          }}
        >
          새 대화 시작
        </Button>
      </div>
    );
  }

  // Loading state
  if (journal.phase === "starting" || journal.phase === "idle") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">하루의 정리</h1>
          <ModeIndicator mode={journal.mode} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={journal.end}
          disabled={journal.phase === "summarizing"}
        >
          {journal.phase === "summarizing" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Square className="mr-1 h-3 w-3" />
          )}
          마무리
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {journal.messages.length === 0 && journal.phase === "active" && (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            마이크를 누르고 오늘 하루를 이야기해보세요
          </div>
        )}
        {journal.messages.map((msg, i) => (
          <JournalMessage key={i} role={msg.role} content={msg.content} mode={msg.mode} />
        ))}
        {journal.phase === "responding" && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-muted px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {journal.error && (
        <div className="border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {journal.error}
        </div>
      )}

      {/* Voice Input */}
      <VoiceInputBar
        onSubmit={handleSubmit}
        isListening={speech.isListening}
        transcript={speech.transcript}
        interimTranscript={speech.interimTranscript}
        onStartListening={speech.startListening}
        onStopListening={speech.stopListening}
        disabled={journal.phase !== "active"}
      />
    </div>
  );
}
```

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/journal/voice-input-bar.tsx frontend/src/components/journal/journal-panel.tsx
git commit -m "feat(journal): VoiceInputBar + JournalPanel 컴포넌트"
```

---

## Task 14: 페이지 + 사이드바

**Files:**
- Create: `frontend/src/app/(authenticated)/journal/page.tsx`
- Create: `frontend/src/app/(authenticated)/journal/history/page.tsx`
- Modify: `frontend/src/components/layout/sidebar.tsx`

- [ ] **Step 1: 메인 페이지 작성**

```tsx
// frontend/src/app/(authenticated)/journal/page.tsx
"use client";

import { JournalPanel } from "@/components/journal/journal-panel";

export default function JournalPage() {
  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col">
      <JournalPanel />
    </div>
  );
}
```

- [ ] **Step 2: 히스토리 페이지 작성**

```tsx
// frontend/src/app/(authenticated)/journal/history/page.tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { getJournalHistory } from "@/lib/journal-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function JournalHistoryPage() {
  const { data: sessions, isLoading } = useQuery({
    queryKey: ["journal-history"],
    queryFn: getJournalHistory,
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const sessionsWithSummary = (sessions || []).filter(
    (s) => s.summary,
  );

  if (sessionsWithSummary.length === 0) {
    return (
      <div className="p-6">
        <h1 className="mb-6 text-2xl font-bold">하루의 기록</h1>
        <p className="text-muted-foreground">아직 기록이 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold">하루의 기록</h1>
      <div className="space-y-4">
        {sessionsWithSummary.map((session) => (
          <Card key={session.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  {new Date(session.createdAt).toLocaleDateString("ko-KR", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    weekday: "short",
                  })}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {session.messageCount}개 메시지
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {session.summary}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 사이드바에 메뉴 추가**

`frontend/src/components/layout/sidebar.tsx`에서 import에 `BookOpen` 추가:
```typescript
import {
  LayoutDashboard,
  Mic,
  FileText,
  History,
  LogOut,
  AudioLines,
  Eye,
  MessageSquare,
  Moon,
  Sun,
  Monitor,
  BookOpen,
} from 'lucide-react';
```

navItems 배열에서 `{ href: '/interview/setup', label: '면접 연습', icon: Mic }` 다음에 추가:
```typescript
  { href: '/journal', label: '하루의 정리', icon: BookOpen },
```

사이드바 숨김 조건에 journal 경로 추가 — `Sidebar` 컴포넌트에서:
```typescript
if (pathname.startsWith('/interview/session/') || pathname.startsWith('/agent-interview/session/') || pathname === '/nightly-study/session' || pathname === '/journal') return null;
```

`MobileSidebar` 컴포넌트에서도 동일 조건 추가:
```typescript
if (pathname.startsWith('/interview/session/') || pathname.startsWith('/agent-interview/session/') || pathname === '/nightly-study/session' || pathname === '/journal') return null;
```

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/app/\(authenticated\)/journal/page.tsx frontend/src/app/\(authenticated\)/journal/history/page.tsx frontend/src/components/layout/sidebar.tsx
git commit -m "feat(journal): 페이지 라우트 + 사이드바 메뉴 추가"
```

---

## Task 15: 통합 smoke test

- [ ] **Step 1: 백엔드 전체 import 테스트**

Run: `cd backend && python -c "from app.main import app; print('Routes:', len(app.routes))"`
Expected: Routes 수 출력 (에러 없이)

- [ ] **Step 2: 프론트엔드 빌드 테스트**

Run: `cd frontend && npx next build`
Expected: 빌드 성공 (에러 없이)

- [ ] **Step 3: Docker 재빌드**

Run: `docker compose up -d --build`
Expected: 모든 컨테이너 정상 기동

- [ ] **Step 4: API 엔드포인트 확인**

브라우저에서 `/journal` 페이지 접속 후:
1. 세션 시작 (POST /api/journal/start) 정상 응답
2. 음성 입력 → 메시지 전송 → AI 응답 수신
3. 모드 전환 확인 (감정적 대화 시 상담 모드)
4. 마무리 버튼 → 요약 생성

- [ ] **Step 5: 최종 커밋 (필요시)**

빌드 오류 수정이 있었다면:
```bash
git add -u
git commit -m "fix(journal): 통합 테스트 수정"
```
