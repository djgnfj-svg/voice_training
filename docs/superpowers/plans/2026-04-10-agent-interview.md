# AI 면접 코치 에이전트 시스템 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자를 깊이 이해하고 기억하는 멀티 에이전트 기반 대화형 AI 면접 코치 시스템 구현

**Architecture:** LangGraph 오케스트레이터(규칙 기반 상태 머신)가 프로필/면접관/평가 3개 서브 에이전트를 조율. pgvector RAG로 사용자 장기 기억. SSE로 프론트에 실시간 스트림.

**Tech Stack:** LangGraph, pgvector (Supabase), OpenAI Embeddings (text-embedding-3-small), FastAPI SSE, Anthropic Claude Haiku

**Spec:** `docs/superpowers/specs/2026-04-10-agent-interview-design.md`

---

## 파일 구조

### 백엔드 — 새로 생성

```
backend/app/
├── agent/
│   ├── __init__.py
│   ├── state.py              # InterviewState TypedDict
│   ├── graph.py              # LangGraph 상태 머신 (오케스트레이터)
│   ├── nodes.py              # 각 그래프 노드 함수
│   ├── profile_agent.py      # 프로필 에이전트 (RAG 읽기/쓰기)
│   ├── interviewer_agent.py  # 면접관 에이전트 (질문 생성 + 흐름 결정)
│   ├── evaluator_agent.py    # 평가 에이전트 (답변 평가)
│   └── embeddings.py         # OpenAI 임베딩 유틸
├── models/
│   └── agent_interview.py    # AgentInterviewSession, AgentInterviewMessage 모델
├── prompts/
│   └── agent.py              # 에이전트 전용 프롬프트
├── routers/
│   └── agent_interview.py    # /api/agent-interview/* 엔드포인트
└── config.py                 # AGENT_MODEL 설정 추가
```

### 백엔드 — 기존 수정

```
backend/app/config.py         # AGENT_MODEL 설정 추가
backend/app/main.py           # agent_interview 라우터 등록
backend/pyproject.toml        # langgraph, pgvector 의존성 추가
```

### 프론트엔드 — 새로 생성

```
frontend/src/
├── app/agent-interview/
│   ├── setup/page.tsx        # 에이전트 면접 설정 페이지
│   └── session/[id]/page.tsx # 대화형 면접 진행 페이지
├── hooks/
│   └── useAgentInterview.ts  # 에이전트 면접 SSE 훅
├── lib/
│   └── agent-interview-api.ts # API 호출 함수
└── components/agent-interview/
    ├── chat-message.tsx      # 대화 메시지 버블
    └── agent-interview-panel.tsx # 면접 진행 패널
```

### 프론트엔드 — 기존 수정

```
frontend/src/components/layout/sidebar.tsx  # AI 코치 면접 메뉴 추가
```

### DB 마이그레이션

```
db/agent_interview_migration.sql  # pgvector 확장 + 테이블 생성
```

---

## Task 1: DB 마이그레이션 — pgvector + 에이전트 테이블

**Files:**
- Create: `db/agent_interview_migration.sql`

- [ ] **Step 1: 마이그레이션 SQL 작성**

```sql
-- db/agent_interview_migration.sql

-- 1. pgvector 확장 활성화
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 사용자 프로필 임베딩 테이블
CREATE TABLE user_profile_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    category VARCHAR(20) NOT NULL CHECK (category IN ('strength', 'weakness', 'pattern', 'context')),
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    "updatedAt" TIMESTAMP(3) DEFAULT NOW()
);

CREATE INDEX idx_user_profile_embeddings_user ON user_profile_embeddings ("userId");
CREATE INDEX idx_user_profile_embeddings_vector ON user_profile_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 3. 에이전트 면접 세션 테이블
CREATE TABLE agent_interview_sessions (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "resumeId" TEXT REFERENCES resumes(id) ON DELETE SET NULL,
    "jobPostingId" TEXT REFERENCES job_postings(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
    "totalQuestions" INTEGER DEFAULT 0,
    "maxQuestions" INTEGER DEFAULT 7,
    "overallScore" FLOAT,
    "reportData" JSONB,
    "creditDeducted" BOOLEAN DEFAULT FALSE,
    "textMode" BOOLEAN DEFAULT FALSE,
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    "updatedAt" TIMESTAMP(3) DEFAULT NOW()
);

CREATE INDEX idx_agent_sessions_user ON agent_interview_sessions ("userId");

-- 4. 에이전트 면접 메시지 테이블 (대화 히스토리)
CREATE TABLE agent_interview_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionId" TEXT NOT NULL REFERENCES agent_interview_sessions(id) ON DELETE CASCADE,
    "messageIndex" INTEGER NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('agent_question', 'user_answer', 'agent_evaluation', 'agent_followup')),
    content TEXT NOT NULL,
    evaluation JSONB,
    "questionNumber" INTEGER,
    "followUpRound" INTEGER DEFAULT 0,
    "audioUrl" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    UNIQUE ("sessionId", "messageIndex")
);

CREATE INDEX idx_agent_messages_session ON agent_interview_messages ("sessionId");
```

- [ ] **Step 2: Supabase에서 마이그레이션 실행**

Run: Supabase SQL Editor에서 위 SQL 실행
Expected: 4개 테이블 생성 (user_profile_embeddings, agent_interview_sessions, agent_interview_messages) + pgvector 확장 활성화

- [ ] **Step 3: 커밋**

```bash
git add db/agent_interview_migration.sql
git commit -m "feat(db): 에이전트 면접 시스템 마이그레이션 — pgvector + 세션/메시지 테이블"
```

---

## Task 2: 의존성 추가 + config 설정

**Files:**
- Modify: `backend/pyproject.toml`
- Modify: `backend/app/config.py`

- [ ] **Step 1: pyproject.toml에 의존성 추가**

`backend/pyproject.toml`의 `dependencies` 리스트에 추가:

```toml
    "langgraph>=0.2",
    "pgvector>=0.3",
```

- [ ] **Step 2: 의존성 설치 확인**

Run: `cd backend && pip install -e .`
Expected: langgraph, pgvector 설치 성공

- [ ] **Step 3: config.py에 에이전트 모델 설정 추가**

`backend/app/config.py`의 `Settings` 클래스에 추가:

```python
    # Agent
    AGENT_MODEL: str = "claude-haiku-4-5-20251001"
```

- [ ] **Step 4: 커밋**

```bash
git add backend/pyproject.toml backend/app/config.py
git commit -m "feat: langgraph + pgvector 의존성 추가, AGENT_MODEL 설정"
```

---

## Task 3: 임베딩 유틸리티

**Files:**
- Create: `backend/app/agent/__init__.py`
- Create: `backend/app/agent/embeddings.py`

- [ ] **Step 1: __init__.py 생성**

```python
# backend/app/agent/__init__.py
```

빈 파일.

- [ ] **Step 2: embeddings.py 작성**

```python
# backend/app/agent/embeddings.py
from __future__ import annotations

import logging

from openai import AsyncOpenAI

from app.config import settings

logger = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536


def _get_openai_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    return _client


async def create_embedding(text: str) -> list[float]:
    """Create embedding vector for given text using OpenAI."""
    client = _get_openai_client()
    response = await client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
    )
    return response.data[0].embedding
```

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/__init__.py backend/app/agent/embeddings.py
git commit -m "feat(agent): OpenAI 임베딩 유틸리티"
```

---

## Task 4: SQLAlchemy 모델 — 에이전트 세션 + 메시지 + 프로필 임베딩

**Files:**
- Create: `backend/app/models/agent_interview.py`

- [ ] **Step 1: 모델 파일 작성**

```python
# backend/app/models/agent_interview.py
from __future__ import annotations

from pgvector.sqlalchemy import Vector
from sqlalchemy import Column, String, DateTime, Integer, Float, Boolean, JSON, Text, ForeignKey, UniqueConstraint, CheckConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class UserProfileEmbedding(Base):
    __tablename__ = "user_profile_embeddings"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    category = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    embedding = Column(Vector(1536), nullable=False)
    metadata_ = Column("metadata", JSON, default={})
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())


class AgentInterviewSession(Base):
    __tablename__ = "agent_interview_sessions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    resume_id = Column("resumeId", String, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True)
    job_posting_id = Column("jobPostingId", String, ForeignKey("job_postings.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), nullable=False, default="in_progress")
    total_questions = Column("totalQuestions", Integer, default=0)
    max_questions = Column("maxQuestions", Integer, default=7)
    overall_score = Column("overallScore", Float, nullable=True)
    report_data = Column("reportData", JSON, nullable=True)
    credit_deducted = Column("creditDeducted", Boolean, default=False)
    text_mode = Column("textMode", Boolean, default=False)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    messages = relationship("AgentInterviewMessage", back_populates="session", cascade="all, delete-orphan")


class AgentInterviewMessage(Base):
    __tablename__ = "agent_interview_messages"
    __table_args__ = (
        UniqueConstraint("sessionId", "messageIndex", name="agent_messages_session_index_key"),
    )

    id = Column(String, primary_key=True)
    session_id = Column("sessionId", String, ForeignKey("agent_interview_sessions.id", ondelete="CASCADE"), nullable=False)
    message_index = Column("messageIndex", Integer, nullable=False)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    evaluation = Column(JSON, nullable=True)
    question_number = Column("questionNumber", Integer, nullable=True)
    follow_up_round = Column("followUpRound", Integer, default=0)
    audio_url = Column("audioUrl", String, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    session = relationship("AgentInterviewSession", back_populates="messages")
```

- [ ] **Step 2: 커밋**

```bash
git add backend/app/models/agent_interview.py
git commit -m "feat(models): 에이전트 면접 세션/메시지 + 프로필 임베딩 SQLAlchemy 모델"
```

---

## Task 5: 프로필 에이전트

**Files:**
- Create: `backend/app/agent/profile_agent.py`

- [ ] **Step 1: 프로필 에이전트 작성**

```python
# backend/app/agent/profile_agent.py
from __future__ import annotations

import json
import logging
from uuid import uuid4

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import create_embedding
from app.config import settings
from app.lib.anthropic_client import call_llm_json
from app.models.agent_interview import UserProfileEmbedding

logger = logging.getLogger(__name__)

TOP_K = 10
SIMILARITY_THRESHOLD = 0.85


async def search_profile(
    db: AsyncSession,
    user_id: str,
    query: str,
    top_k: int = TOP_K,
) -> list[dict]:
    """Search user profile embeddings by cosine similarity."""
    query_embedding = await create_embedding(query)
    embedding_str = "[" + ",".join(str(v) for v in query_embedding) + "]"

    result = await db.execute(
        text("""
            SELECT id, category, content, metadata,
                   1 - (embedding <=> :embedding::vector) AS similarity
            FROM user_profile_embeddings
            WHERE "userId" = :user_id
            ORDER BY embedding <=> :embedding::vector
            LIMIT :top_k
        """),
        {"user_id": user_id, "embedding": embedding_str, "top_k": top_k},
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


async def update_profile(
    db: AsyncSession,
    user_id: str,
    category: str,
    content: str,
    metadata: dict | None = None,
) -> str:
    """Upsert a profile embedding. If similar entry exists (>0.85), update it."""
    embedding = await create_embedding(content)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    # Check for similar existing entry
    result = await db.execute(
        text("""
            SELECT id, 1 - (embedding <=> :embedding::vector) AS similarity
            FROM user_profile_embeddings
            WHERE "userId" = :user_id AND category = :category
            ORDER BY embedding <=> :embedding::vector
            LIMIT 1
        """),
        {"user_id": user_id, "embedding": embedding_str, "category": category},
    )
    existing = result.fetchone()

    if existing and existing.similarity >= SIMILARITY_THRESHOLD:
        # Update existing
        await db.execute(
            text("""
                UPDATE user_profile_embeddings
                SET content = :content, embedding = :embedding::vector,
                    metadata = :metadata, "updatedAt" = NOW()
                WHERE id = :id
            """),
            {
                "id": str(existing.id),
                "content": content,
                "embedding": embedding_str,
                "metadata": json.dumps(metadata or {}),
            },
        )
        await db.commit()
        return str(existing.id)
    else:
        # Insert new
        new_id = str(uuid4())
        await db.execute(
            text("""
                INSERT INTO user_profile_embeddings (id, "userId", category, content, embedding, metadata)
                VALUES (:id, :user_id, :category, :content, :embedding::vector, :metadata)
            """),
            {
                "id": new_id,
                "user_id": user_id,
                "category": category,
                "content": content,
                "embedding": embedding_str,
                "metadata": json.dumps(metadata or {}),
            },
        )
        await db.commit()
        return new_id


async def load_user_profile(
    db: AsyncSession,
    user_id: str,
    resume_data: dict,
    job_posting_data: dict | None = None,
) -> dict:
    """Load user profile for interview start. Searches RAG with resume/job context."""
    # Build search query from resume + job posting
    search_parts = []
    if isinstance(resume_data, dict):
        skills = resume_data.get("skills", [])
        if skills:
            search_parts.append("기술: " + ", ".join(skills[:10]))
        projects = resume_data.get("projects", [])
        if projects:
            search_parts.append("프로젝트: " + ", ".join(p.get("name", "") for p in projects[:3]))
    if job_posting_data and isinstance(job_posting_data, dict):
        position = job_posting_data.get("position", "")
        if position:
            search_parts.append("포지션: " + position)

    query = " ".join(search_parts) if search_parts else "면접 준비 기술 역량"

    profiles = await search_profile(db, user_id, query)

    # Organize by category
    organized: dict[str, list[str]] = {
        "strengths": [],
        "weaknesses": [],
        "patterns": [],
        "context": [],
    }
    for p in profiles:
        cat = p["category"]
        key = cat + "s" if cat in ("strength", "weakness") else cat + "s"
        if key in organized:
            organized[key].append(p["content"])

    return organized


async def save_session_insights(
    db: AsyncSession,
    user_id: str,
    conversation_history: list[dict],
    session_id: str,
) -> None:
    """Analyze session results and save new insights to profile RAG."""
    if not conversation_history:
        return

    # Build summary for analysis
    summary_parts = []
    for entry in conversation_history:
        if entry.get("question") and entry.get("evaluation"):
            score = entry["evaluation"].get("overall_score", 0)
            summary_parts.append(
                f"질문: {entry['question']}\n점수: {score}\n피드백: {entry['evaluation'].get('brief_feedback', '')}"
            )

    if not summary_parts:
        return

    summary = "\n---\n".join(summary_parts)

    prompt = f"""다음 면접 세션 결과를 분석하여 이 사용자의 프로필 인사이트를 추출하세요.

<session_results>
{summary}
</session_results>

다음 JSON 형식으로 반환하세요:
{{
  "strengths": ["강점 1", "강점 2"],
  "weaknesses": ["약점 1", "약점 2"],
  "patterns": ["패턴 1"]
}}

- 각 항목은 구체적이고 기술적으로 작성 (예: "React useState/useReducer 설명이 정확하고 실무 사례 풍부")
- 이번 세션에서 새로 발견된 것만 포함
- 해당 카테고리에 인사이트가 없으면 빈 배열
"""

    try:
        insights = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)
    except Exception:
        logger.exception("Failed to extract session insights")
        return

    metadata = {"session_id": session_id}

    for strength in insights.get("strengths", []):
        if strength.strip():
            await update_profile(db, user_id, "strength", strength.strip(), metadata)

    for weakness in insights.get("weaknesses", []):
        if weakness.strip():
            await update_profile(db, user_id, "weakness", weakness.strip(), metadata)

    for pattern in insights.get("patterns", []):
        if pattern.strip():
            await update_profile(db, user_id, "pattern", pattern.strip(), metadata)
```

- [ ] **Step 2: 커밋**

```bash
git add backend/app/agent/profile_agent.py
git commit -m "feat(agent): 프로필 에이전트 — RAG 검색/저장/세션 인사이트 추출"
```

---

## Task 6: 에이전트 프롬프트

**Files:**
- Create: `backend/app/prompts/agent.py`

- [ ] **Step 1: 에이전트 전용 프롬프트 작성**

```python
# backend/app/prompts/agent.py
from __future__ import annotations

INTERVIEWER_SYSTEM_PROMPT = """당신은 시니어 개발자 면접관입니다.
지원자의 프로필, 이력서, 대화 히스토리를 참고하여 면접을 진행합니다.

## 규칙
- 질문은 한 번에 하나만 합니다.
- 지원자의 약점 영역을 우선 탐색하되, 강점도 확인합니다.
- 이전 답변의 깊이가 부족하면 꼬리질문으로 파고듭니다.
- 질문 난이도를 지원자 수준에 맞게 실시간 조정합니다.
- 모든 응답은 한국어로 합니다.
- 자연스럽고 격려하는 톤을 유지하되, 평가는 엄격히 합니다.

## 첫 질문 생성 시
- 지원자의 프로필(약점, 강점)을 참고하여 가장 적절한 첫 질문을 선택합니다.
- 이전 세션 데이터가 있다면, 이전에 약했던 주제부터 시작합니다.
- 처음 면접하는 지원자라면, 이력서의 주요 기술/프로젝트에서 시작합니다."""

INTERVIEWER_QUESTION_PROMPT = """지원자 컨텍스트:

<resume>
{resume}
</resume>

<job_posting>
{job_posting}
</job_posting>

<user_profile>
강점: {strengths}
약점: {weaknesses}
패턴: {patterns}
맥락: {context}
</user_profile>

<conversation_history>
{conversation_history}
</conversation_history>

위 컨텍스트를 참고하여 다음 면접 질문을 생성하세요.

반드시 다음 JSON만 반환하세요:
{{
  "question": "면접 질문 (한국어)",
  "intent": "이 질문을 하는 이유 (내부 메모, 지원자에게 보이지 않음)",
  "targetArea": "이 질문이 탐색하는 기술 영역",
  "difficulty": "easy | medium | hard"
}}"""

INTERVIEWER_DECIDE_PROMPT = """지원자 컨텍스트:

<conversation_history>
{conversation_history}
</conversation_history>

<last_evaluation>
{last_evaluation}
</last_evaluation>

현재 상태:
- 진행된 질문 수: {question_count} / 최대 {max_questions}
- 현재 꼬리질문 라운드: {follow_up_round} (최대 2)

다음 행동을 결정하세요.

규칙:
- depth 점수 < 80이고 follow_up_round < 2이면 → "follow_up" (꼬리질문으로 깊이 파기)
- 질문 수가 최대에 도달했으면 → "end"
- 그 외 → "next_question" (새 주제로 이동)

반드시 다음 JSON만 반환하세요:
{{
  "action": "follow_up" | "next_question" | "end",
  "reason": "이 결정의 이유 (내부 메모)"
}}"""

INTERVIEWER_FOLLOWUP_PROMPT = """지원자 컨텍스트:

<conversation_history>
{conversation_history}
</conversation_history>

<last_evaluation>
{last_evaluation}
</last_evaluation>

이전 답변의 깊이가 부족합니다. 꼬리질문을 생성하세요.

깊이 사다리:
- 답변이 "what"(무엇)만 → "why"(왜) 또는 "how"(어떻게) 질문
- 답변이 "how"를 설명 → 트레이드오프, 대안, 한계점 질문
- 답변이 원리를 설명 → 실제 경험, 적용 사례 질문

반드시 다음 JSON만 반환하세요:
{{
  "question": "꼬리질문 (한국어)",
  "intent": "이 꼬리질문의 의도 (내부 메모)"
}}"""

EVALUATOR_SYSTEM_PROMPT = """당신은 개발자 기술 면접 평가관입니다.
지원자의 답변을 공정하고 엄격하게 평가합니다.
과거 프로필 정보가 있다면, 성장 여부도 함께 언급합니다."""

EVALUATOR_PROMPT = """면접 질문:
{question}

지원자 답변:
{answer}

<user_profile>
강점: {strengths}
약점: {weaknesses}
</user_profile>

<conversation_history>
{conversation_history}
</conversation_history>

## 평가 기준 (가중치)
- clarity (전달력, 30%): 논리적 구조, 핵심 포인트 우선, 면접관이 바로 이해 가능
- accuracy (기술 정확성, 25%): 개념 정확, 오개념 없음
- practicality (실무 적용력, 25%): 실제 경험 연결, 구체적 사례
- depth (이해 깊이, 15%): 원리 설명, 트레이드오프 인식
- completeness (완성도, 5%): 핵심 포인트 커버

반드시 다음 JSON만 반환하세요:
{{
  "scores": {{
    "clarity": 0,
    "accuracy": 0,
    "practicality": 0,
    "depth": 0,
    "completeness": 0
  }},
  "overallScore": 0,
  "briefFeedback": "잘한 점 1가지 + 개선할 점 1가지, 2문장 이내",
  "detailedFeedback": "상세 피드백 3-5문장. 구체적 개선 제안 1개 이상 포함",
  "modelAnswer": "모범 답안 (150-300자, 구어체 존댓말)",
  "weaknessDetected": "새로 발견된 약점 (없으면 null)"
}}"""

REPORT_PROMPT = """다음 면접 세션의 전체 대화를 분석하여 종합 리포트를 생성하세요.

<conversation_history>
{conversation_history}
</conversation_history>

<user_profile>
강점: {strengths}
약점: {weaknesses}
</user_profile>

반드시 다음 JSON만 반환하세요:
{{
  "overallScore": 0,
  "summary": "전체 면접 종합 평가 (3-5문장)",
  "strengths": ["이번 면접에서 보여준 강점 1", "강점 2"],
  "improvements": ["개선이 필요한 부분 1", "부분 2"],
  "growthNotes": "이전 프로필 대비 성장한 부분 (프로필 데이터가 없으면 null)",
  "recommendations": ["다음 면접을 위한 구체적 추천 1", "추천 2"]
}}"""
```

- [ ] **Step 2: 커밋**

```bash
git add backend/app/prompts/agent.py
git commit -m "feat(prompts): 에이전트 전용 프롬프트 — 면접관/평가/리포트"
```

---

## Task 7: 면접관 에이전트 + 평가 에이전트

**Files:**
- Create: `backend/app/agent/interviewer_agent.py`
- Create: `backend/app/agent/evaluator_agent.py`

- [ ] **Step 1: 면접관 에이전트 작성**

```python
# backend/app/agent/interviewer_agent.py
from __future__ import annotations

import json
import logging

from app.config import settings
from app.lib.anthropic_client import call_llm_json
from app.prompts.agent import (
    INTERVIEWER_SYSTEM_PROMPT,
    INTERVIEWER_QUESTION_PROMPT,
    INTERVIEWER_DECIDE_PROMPT,
    INTERVIEWER_FOLLOWUP_PROMPT,
)

logger = logging.getLogger(__name__)


def _format_profile(profile: dict) -> dict[str, str]:
    """Format profile dict into prompt-friendly strings."""
    return {
        "strengths": "\n".join(profile.get("strengths", [])) or "데이터 없음",
        "weaknesses": "\n".join(profile.get("weaknesses", [])) or "데이터 없음",
        "patterns": "\n".join(profile.get("patterns", [])) or "데이터 없음",
        "context": "\n".join(profile.get("context", [])) or "데이터 없음",
    }


def _format_history(history: list[dict]) -> str:
    """Format conversation history for prompt."""
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


async def generate_question(
    resume: dict,
    job_posting: dict | None,
    user_profile: dict,
    conversation_history: list[dict],
) -> dict:
    """Generate next interview question based on full context."""
    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)

    resume_str = json.dumps(resume, ensure_ascii=False, indent=2) if isinstance(resume, dict) else str(resume)
    job_str = json.dumps(job_posting, ensure_ascii=False, indent=2) if job_posting else "채용공고 없음"

    prompt = INTERVIEWER_QUESTION_PROMPT.format(
        resume=resume_str,
        job_posting=job_str,
        strengths=profile_str["strengths"],
        weaknesses=profile_str["weaknesses"],
        patterns=profile_str["patterns"],
        context=profile_str["context"],
        conversation_history=history_str,
    )

    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.7,
    )


async def decide_next_action(
    conversation_history: list[dict],
    last_evaluation: dict,
    question_count: int,
    max_questions: int,
    follow_up_round: int,
) -> dict:
    """Decide next action: follow_up, next_question, or end."""
    prompt = INTERVIEWER_DECIDE_PROMPT.format(
        conversation_history=_format_history(conversation_history),
        last_evaluation=json.dumps(last_evaluation, ensure_ascii=False),
        question_count=question_count,
        max_questions=max_questions,
        follow_up_round=follow_up_round,
    )

    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )


async def generate_followup(
    conversation_history: list[dict],
    last_evaluation: dict,
) -> dict:
    """Generate follow-up question based on previous answer evaluation."""
    prompt = INTERVIEWER_FOLLOWUP_PROMPT.format(
        conversation_history=_format_history(conversation_history),
        last_evaluation=json.dumps(last_evaluation, ensure_ascii=False),
    )

    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.7,
    )
```

- [ ] **Step 2: 평가 에이전트 작성**

```python
# backend/app/agent/evaluator_agent.py
from __future__ import annotations

import json
import logging

from app.config import settings
from app.lib.anthropic_client import call_llm_json
from app.prompts.agent import EVALUATOR_PROMPT, REPORT_PROMPT

logger = logging.getLogger(__name__)


async def evaluate_answer(
    question: str,
    answer: str,
    user_profile: dict,
    conversation_history: list[dict],
) -> dict:
    """Evaluate a single answer with user profile context."""
    strengths = "\n".join(user_profile.get("strengths", [])) or "데이터 없음"
    weaknesses = "\n".join(user_profile.get("weaknesses", [])) or "데이터 없음"

    history_parts = []
    for entry in conversation_history:
        history_parts.append(f"Q: {entry.get('question', '')}")
        if entry.get("answer"):
            history_parts.append(f"A: {entry['answer']}")
    history_str = "\n".join(history_parts) if history_parts else "첫 질문입니다."

    prompt = EVALUATOR_PROMPT.format(
        question=question,
        answer=answer,
        strengths=strengths,
        weaknesses=weaknesses,
        conversation_history=history_str,
    )

    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )


async def generate_report(
    conversation_history: list[dict],
    user_profile: dict,
) -> dict:
    """Generate overall interview report."""
    history_parts = []
    for entry in conversation_history:
        history_parts.append(f"Q: {entry.get('question', '')}")
        if entry.get("answer"):
            history_parts.append(f"A: {entry['answer']}")
        if entry.get("evaluation"):
            ev = entry["evaluation"]
            history_parts.append(f"점수: {ev.get('overallScore', '?')}, 피드백: {ev.get('briefFeedback', '')}")
        history_parts.append("---")

    prompt = REPORT_PROMPT.format(
        conversation_history="\n".join(history_parts),
        strengths="\n".join(user_profile.get("strengths", [])) or "데이터 없음",
        weaknesses="\n".join(user_profile.get("weaknesses", [])) or "데이터 없음",
    )

    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.3,
    )
```

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/interviewer_agent.py backend/app/agent/evaluator_agent.py
git commit -m "feat(agent): 면접관 에이전트 + 평가 에이전트"
```

---

## Task 8: LangGraph 상태 + 그래프

**Files:**
- Create: `backend/app/agent/state.py`
- Create: `backend/app/agent/nodes.py`
- Create: `backend/app/agent/graph.py`

- [ ] **Step 1: 상태 정의**

```python
# backend/app/agent/state.py
from __future__ import annotations

from typing import TypedDict


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
    follow_up_round: int
    max_questions: int

    # 평가 에이전트가 채움
    current_evaluation: dict

    # 면접관 에이전트가 채움
    next_action: str  # "follow_up" | "next_question" | "end"

    # 대화 히스토리
    conversation_history: list[dict]

    # 최종 결과
    overall_report: dict | None

    # SSE 이벤트 큐 (노드가 이벤트를 여기에 쌓으면 라우터가 SSE로 전송)
    pending_events: list[dict]
```

- [ ] **Step 2: 노드 함수 작성**

```python
# backend/app/agent/nodes.py
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.state import InterviewState
from app.agent import profile_agent, interviewer_agent, evaluator_agent

logger = logging.getLogger(__name__)


async def load_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Load user profile from RAG."""
    profile = await profile_agent.load_user_profile(
        db,
        state["user_id"],
        state["resume"],
        state.get("job_posting"),
    )
    return {
        **state,
        "user_profile": profile,
        "pending_events": state.get("pending_events", []) + [
            {"event": "status", "data": {"phase": "profile_loaded"}},
        ],
    }


async def generate_question(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate next interview question."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_question"}})

    result = await interviewer_agent.generate_question(
        state["resume"],
        state.get("job_posting"),
        state["user_profile"],
        state.get("conversation_history", []),
    )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "followUpRound": 0,
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    })

    return {
        **state,
        "current_question": question,
        "question_count": question_count,
        "follow_up_round": 0,
        "pending_events": events,
    }


async def generate_followup(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate follow-up question."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_followup"}})

    result = await interviewer_agent.generate_followup(
        state.get("conversation_history", []),
        state.get("current_evaluation", {}),
    )

    question = result.get("question", "")
    follow_up_round = state.get("follow_up_round", 0) + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": state.get("question_count", 1),
            "followUpRound": follow_up_round,
        },
    })

    return {
        **state,
        "current_question": question,
        "follow_up_round": follow_up_round,
        "pending_events": events,
    }


async def evaluate_answer(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Evaluate user's answer."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "evaluating"}})

    evaluation = await evaluator_agent.evaluate_answer(
        state["current_question"],
        state["current_answer"],
        state.get("user_profile", {}),
        state.get("conversation_history", []),
    )

    # Append to conversation history
    history = list(state.get("conversation_history", []))
    history.append({
        "question": state["current_question"],
        "answer": state["current_answer"],
        "evaluation": evaluation,
        "question_number": state.get("question_count", 1),
        "follow_up_round": state.get("follow_up_round", 0),
    })

    events.append({
        "event": "evaluation",
        "data": {
            "overallScore": evaluation.get("overallScore", 0),
            "briefFeedback": evaluation.get("briefFeedback", ""),
            "detailedFeedback": evaluation.get("detailedFeedback", ""),
            "modelAnswer": evaluation.get("modelAnswer", ""),
            "scores": evaluation.get("scores", {}),
        },
    })

    return {
        **state,
        "current_evaluation": evaluation,
        "conversation_history": history,
        "pending_events": events,
    }


async def decide_next(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Decide next action after evaluation."""
    result = await interviewer_agent.decide_next_action(
        state.get("conversation_history", []),
        state.get("current_evaluation", {}),
        state.get("question_count", 0),
        state.get("max_questions", 7),
        state.get("follow_up_round", 0),
    )

    action = result.get("action", "next_question")

    return {
        **state,
        "next_action": action,
        "pending_events": state.get("pending_events", []),
    }


async def update_profile(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Save session insights to user profile RAG."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "updating_profile"}})

    await profile_agent.save_session_insights(
        db,
        state["user_id"],
        state.get("conversation_history", []),
        state["session_id"],
    )

    return {
        **state,
        "pending_events": events,
    }


async def generate_report(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate overall report."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_report"}})

    report = await evaluator_agent.generate_report(
        state.get("conversation_history", []),
        state.get("user_profile", {}),
    )

    events.append({"event": "complete", "data": {"report": report}})

    return {
        **state,
        "overall_report": report,
        "pending_events": events,
    }
```

- [ ] **Step 3: LangGraph 그래프 작성**

```python
# backend/app/agent/graph.py
from __future__ import annotations

from langgraph.graph import StateGraph, END

from app.agent.state import InterviewState


def _route_after_decide(state: InterviewState) -> str:
    """Route based on next_action decided by interviewer agent."""
    action = state.get("next_action", "end")
    if action == "follow_up":
        return "generate_followup"
    elif action == "next_question":
        return "generate_question"
    else:
        return "update_profile"


def build_interview_graph() -> StateGraph:
    """Build the LangGraph state machine for agent interview.

    Flow:
    START → load_profile → generate_question → (wait for answer externally)
    (answer submitted) → evaluate_answer → decide_next
        → follow_up → (wait for answer)
        → next_question → generate_question → (wait for answer)
        → end → update_profile → generate_report → END

    Note: The graph runs in two phases:
    1. "start" phase: load_profile → generate_question → pause
    2. "answer" phase: evaluate_answer → decide_next → (route) → pause or end
    """
    graph = StateGraph(InterviewState)

    # We use separate subgraphs for start and answer phases
    # since the user answers externally (not within the graph)
    return graph


def build_start_graph() -> StateGraph:
    """Phase 1: Load profile and generate first question."""
    graph = StateGraph(InterviewState)
    graph.add_node("load_profile", lambda state: state)  # placeholder
    graph.add_node("generate_question", lambda state: state)  # placeholder
    graph.set_entry_point("load_profile")
    graph.add_edge("load_profile", "generate_question")
    graph.add_edge("generate_question", END)
    return graph


def build_answer_graph() -> StateGraph:
    """Phase 2: Evaluate answer and decide next action."""
    graph = StateGraph(InterviewState)
    graph.add_node("evaluate_answer", lambda state: state)  # placeholder
    graph.add_node("decide_next", lambda state: state)  # placeholder
    graph.add_node("generate_question", lambda state: state)  # placeholder
    graph.add_node("generate_followup", lambda state: state)  # placeholder
    graph.add_node("update_profile", lambda state: state)  # placeholder
    graph.add_node("generate_report", lambda state: state)  # placeholder

    graph.set_entry_point("evaluate_answer")
    graph.add_edge("evaluate_answer", "decide_next")
    graph.add_conditional_edges("decide_next", _route_after_decide, {
        "generate_followup": "generate_followup",
        "generate_question": "generate_question",
        "update_profile": "update_profile",
    })
    graph.add_edge("generate_followup", END)
    graph.add_edge("generate_question", END)
    graph.add_edge("update_profile", "generate_report")
    graph.add_edge("generate_report", END)

    return graph
```

- [ ] **Step 4: 커밋**

```bash
git add backend/app/agent/state.py backend/app/agent/nodes.py backend/app/agent/graph.py
git commit -m "feat(agent): LangGraph 상태 머신 — start/answer 2단계 그래프"
```

---

## Task 9: 백엔드 라우터 — /api/agent-interview/*

**Files:**
- Create: `backend/app/routers/agent_interview.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: 에이전트 면접 라우터 작성**

```python
# backend/app/routers/agent_interview.py
from __future__ import annotations

import json
import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.agent import nodes
from app.agent.graph import build_start_graph, build_answer_graph, _route_after_decide
from app.agent.state import InterviewState
from app.models.agent_interview import AgentInterviewSession, AgentInterviewMessage
from app.models.resume import Resume
from app.models.interview import JobPosting
from app.services.credit import (
    CREDIT_COSTS,
    InsufficientCreditsError,
    deduct_credits,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------- Schemas ----------

class StartRequest(BaseModel):
    resumeId: str
    jobPostingId: str | None = None
    maxQuestions: int = Field(default=7, ge=3, le=15)
    textMode: bool = False


class AnswerRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=10000)


# ---------- POST /api/agent-interview/start ----------

@router.post("/api/agent-interview/start")
async def start_interview(
    body: StartRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start agent interview: load profile, generate first question."""
    # Verify resume
    result = await db.execute(
        select(Resume).where(Resume.id == body.resumeId, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(404, {"error": "이력서를 찾을 수 없습니다"})

    resume_data = resume.parsed_data or {}

    # Load job posting if provided
    job_posting_data = None
    if body.jobPostingId:
        jp_result = await db.execute(
            select(JobPosting).where(
                JobPosting.id == body.jobPostingId,
                JobPosting.user_id == user.id,
            )
        )
        jp = jp_result.scalar_one_or_none()
        if jp:
            job_posting_data = jp.parsed_data

    # Create session
    session_id = str(uuid4())
    session = AgentInterviewSession(
        id=session_id,
        user_id=user.id,
        resume_id=body.resumeId,
        job_posting_id=body.jobPostingId,
        max_questions=body.maxQuestions,
        text_mode=body.textMode,
    )
    db.add(session)
    await db.commit()

    # Build initial state
    initial_state: InterviewState = {
        "session_id": session_id,
        "user_id": user.id,
        "resume": resume_data,
        "job_posting": job_posting_data,
        "user_profile": {},
        "current_question": "",
        "current_answer": "",
        "question_count": 0,
        "follow_up_round": 0,
        "max_questions": body.maxQuestions,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": [],
        "overall_report": None,
        "pending_events": [],
    }

    async def event_generator():
        try:
            # Phase 1: load_profile → generate_question
            state = initial_state.copy()

            state["pending_events"] = [{"event": "status", "data": {"phase": "loading_profile"}}]
            yield {"event": "status", "data": json.dumps({"phase": "loading_profile"})}

            state = await nodes.load_profile(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            state = await nodes.generate_question(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Save first question to DB
            msg = AgentInterviewMessage(
                id=str(uuid4()),
                session_id=session_id,
                message_index=0,
                role="agent_question",
                content=state["current_question"],
                question_number=state["question_count"],
                follow_up_round=0,
            )
            db.add(msg)
            await db.commit()

            # Return session info
            yield {
                "event": "session",
                "data": json.dumps({
                    "sessionId": session_id,
                    "questionCount": state["question_count"],
                    "maxQuestions": state["max_questions"],
                }),
            }
        except Exception as e:
            logger.exception("Agent interview start failed")
            yield {"event": "error", "data": json.dumps({"error": "면접 시작에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/answer ----------

@router.post("/api/agent-interview/{session_id}/answer")
async def submit_answer(
    session_id: str,
    body: AnswerRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit answer: evaluate → decide next → generate next question or end."""
    # Verify session
    result = await db.execute(
        select(AgentInterviewSession)
        .where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status == "in_progress",
        )
        .options(selectinload(AgentInterviewSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    # Load resume
    resume_result = await db.execute(select(Resume).where(Resume.id == session.resume_id))
    resume = resume_result.scalar_one_or_none()
    resume_data = resume.parsed_data if resume else {}

    # Load job posting
    job_posting_data = None
    if session.job_posting_id:
        jp_result = await db.execute(select(JobPosting).where(JobPosting.id == session.job_posting_id))
        jp = jp_result.scalar_one_or_none()
        if jp:
            job_posting_data = jp.parsed_data

    # Rebuild state from DB messages
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history = []
    current_question = ""
    question_count = 0
    follow_up_round = 0

    for msg in messages:
        if msg.role == "agent_question":
            current_question = msg.content
            question_count = msg.question_number or 0
            follow_up_round = msg.follow_up_round or 0
        elif msg.role == "user_answer" and msg.evaluation:
            # Find matching question
            conversation_history.append({
                "question": current_question,
                "answer": msg.content,
                "evaluation": msg.evaluation,
                "question_number": msg.question_number,
                "follow_up_round": msg.follow_up_round or 0,
            })

    # Get last question from messages
    last_question_msg = None
    for msg in reversed(messages):
        if msg.role in ("agent_question", "agent_followup"):
            last_question_msg = msg
            break

    if not last_question_msg:
        raise HTTPException(400, {"error": "진행 중인 질문이 없습니다"})

    current_question = last_question_msg.content
    question_count = last_question_msg.question_number or 1
    follow_up_round = last_question_msg.follow_up_round or 0

    # Rebuild profile from RAG
    from app.agent.profile_agent import load_user_profile
    user_profile = await load_user_profile(db, user.id, resume_data, job_posting_data)

    state: InterviewState = {
        "session_id": session_id,
        "user_id": user.id,
        "resume": resume_data,
        "job_posting": job_posting_data,
        "user_profile": user_profile,
        "current_question": current_question,
        "current_answer": body.answer,
        "question_count": question_count,
        "follow_up_round": follow_up_round,
        "max_questions": session.max_questions or 7,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": conversation_history,
        "overall_report": None,
        "pending_events": [],
    }

    next_message_index = len(messages)

    async def event_generator():
        nonlocal state, next_message_index
        try:
            # Save user answer
            answer_msg = AgentInterviewMessage(
                id=str(uuid4()),
                session_id=session_id,
                message_index=next_message_index,
                role="user_answer",
                content=body.answer,
                question_number=question_count,
                follow_up_round=follow_up_round,
            )
            db.add(answer_msg)
            next_message_index += 1

            # Phase 2: evaluate → decide → route
            state = await nodes.evaluate_answer(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # Update answer message with evaluation
            answer_msg.evaluation = state["current_evaluation"]
            await db.commit()

            # Decide next action
            state = await nodes.decide_next(state, db)
            action = state.get("next_action", "end")

            if action == "follow_up":
                state = await nodes.generate_followup(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                # Save followup question
                fq_msg = AgentInterviewMessage(
                    id=str(uuid4()),
                    session_id=session_id,
                    message_index=next_message_index,
                    role="agent_followup",
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=state["follow_up_round"],
                )
                db.add(fq_msg)
                next_message_index += 1

            elif action == "next_question":
                state = await nodes.generate_question(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                # Save new question
                q_msg = AgentInterviewMessage(
                    id=str(uuid4()),
                    session_id=session_id,
                    message_index=next_message_index,
                    role="agent_question",
                    content=state["current_question"],
                    question_number=state["question_count"],
                    follow_up_round=0,
                )
                db.add(q_msg)
                next_message_index += 1

            else:  # end
                state = await nodes.update_profile(state, db)
                state = await nodes.generate_report(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                # Update session
                session.status = "completed"
                session.total_questions = state["question_count"]
                session.report_data = state.get("overall_report")
                if state.get("overall_report"):
                    session.overall_score = state["overall_report"].get("overallScore")

            await db.commit()

            yield {
                "event": "action",
                "data": json.dumps({
                    "action": action,
                    "questionCount": state.get("question_count", 0),
                    "maxQuestions": state.get("max_questions", 7),
                }),
            }

        except Exception as e:
            logger.exception("Agent interview answer processing failed")
            yield {"event": "error", "data": json.dumps({"error": "답변 처리에 실패했습니다"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/agent-interview/{session_id}/end ----------

@router.post("/api/agent-interview/{session_id}/end")
async def end_interview(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually end interview early."""
    result = await db.execute(
        select(AgentInterviewSession).where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
            AgentInterviewSession.status == "in_progress",
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    session.status = "completed"
    await db.commit()

    return {"status": "completed", "sessionId": session_id}


# ---------- GET /api/agent-interview/{session_id} ----------

@router.get("/api/agent-interview/{session_id}")
async def get_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get agent interview session with messages."""
    result = await db.execute(
        select(AgentInterviewSession)
        .where(
            AgentInterviewSession.id == session_id,
            AgentInterviewSession.user_id == user.id,
        )
        .options(selectinload(AgentInterviewSession.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, {"error": "세션을 찾을 수 없습니다"})

    messages = sorted(session.messages, key=lambda m: m.message_index)

    return {
        "id": session.id,
        "status": session.status,
        "totalQuestions": session.total_questions,
        "maxQuestions": session.max_questions,
        "overallScore": session.overall_score,
        "reportData": session.report_data,
        "createdAt": session.created_at.isoformat() if session.created_at else None,
        "messages": [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "evaluation": m.evaluation,
                "questionNumber": m.question_number,
                "followUpRound": m.follow_up_round,
                "audioUrl": m.audio_url,
                "createdAt": m.created_at.isoformat() if m.created_at else None,
            }
            for m in messages
        ],
    }


# ---------- GET /api/profile ----------

@router.get("/api/profile")
async def get_profile(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get user's AI profile summary."""
    from app.agent.profile_agent import search_profile

    profiles = await search_profile(db, user.id, "면접 역량 종합", top_k=20)

    organized: dict[str, list[str]] = {
        "strengths": [],
        "weaknesses": [],
        "patterns": [],
        "context": [],
    }
    for p in profiles:
        cat = p["category"]
        key = cat + "s" if cat in ("strength", "weakness") else cat + "s"
        if key in organized:
            organized[key].append(p["content"])

    return organized


# ---------- POST /api/profile/context ----------

class ProfileContextRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


@router.post("/api/profile/context")
async def add_profile_context(
    body: ProfileContextRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add explicit user context to profile."""
    from app.agent.profile_agent import update_profile

    entry_id = await update_profile(
        db,
        user.id,
        "context",
        body.content,
        {"source": "user_input"},
    )
    return {"id": entry_id, "status": "saved"}
```

- [ ] **Step 2: main.py에 라우터 등록**

`backend/app/main.py`에 추가:

```python
from app.routers.agent_interview import router as agent_interview_router
```

그리고 `app.include_router(nightly_study_router)` 아래에:

```python
app.include_router(agent_interview_router)
```

- [ ] **Step 3: 커밋**

```bash
git add backend/app/routers/agent_interview.py backend/app/main.py
git commit -m "feat(api): 에이전트 면접 라우터 — start/answer/end/session/profile SSE 엔드포인트"
```

---

## Task 10: 프론트엔드 — API 호출 + SSE 훅

**Files:**
- Create: `frontend/src/lib/agent-interview-api.ts`
- Create: `frontend/src/hooks/useAgentInterview.ts`

- [ ] **Step 1: API 호출 함수 작성**

```typescript
// frontend/src/lib/agent-interview-api.ts

export interface AgentStartParams {
  resumeId: string;
  jobPostingId?: string;
  maxQuestions?: number;
  textMode?: boolean;
}

export interface AgentAnswerParams {
  sessionId: string;
  answer: string;
}

export function startAgentInterview(params: AgentStartParams): EventSource {
  const url = "/api/agent-interview/start";
  // SSE requires GET, but we need POST with body
  // Use fetch + ReadableStream instead
  return createSSEFromPost(url, params);
}

export function submitAgentAnswer(params: AgentAnswerParams): EventSource {
  const url = `/api/agent-interview/${params.sessionId}/answer`;
  return createSSEFromPost(url, { answer: params.answer });
}

export async function endAgentInterview(sessionId: string) {
  const res = await fetch(`/api/agent-interview/${sessionId}/end`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error("면접 종료에 실패했습니다");
  return res.json();
}

export async function getAgentSession(sessionId: string) {
  const res = await fetch(`/api/agent-interview/${sessionId}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("세션을 불러올 수 없습니다");
  return res.json();
}

export async function getProfile() {
  const res = await fetch("/api/profile", { credentials: "include" });
  if (!res.ok) throw new Error("프로필을 불러올 수 없습니다");
  return res.json();
}

export async function addProfileContext(content: string) {
  const res = await fetch("/api/profile/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("프로필 저장에 실패했습니다");
  return res.json();
}

// Helper: POST-based SSE using fetch + ReadableStream
function createSSEFromPost(url: string, body: Record<string, unknown>): EventSource {
  // We return a custom EventSource-like object
  // The actual implementation uses fetch with streaming
  const controller = new AbortController();
  const eventTarget = new EventTarget();

  const listeners: Record<string, ((e: MessageEvent) => void)[]> = {};

  const source = {
    close() {
      controller.abort();
    },
    addEventListener(type: string, handler: (e: MessageEvent) => void) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type: string, handler: (e: MessageEvent) => void) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((h) => h !== handler);
      }
    },
  };

  (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        credentials: "include",
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: "요청 실패" }));
        for (const handler of listeners["error"] || []) {
          handler(new MessageEvent("error", { data: JSON.stringify(data) }));
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "message";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            for (const handler of listeners[currentEvent] || []) {
              handler(new MessageEvent(currentEvent, { data }));
            }
            currentEvent = "message";
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        for (const handler of listeners["error"] || []) {
          handler(new MessageEvent("error", { data: JSON.stringify({ error: "연결 실패" }) }));
        }
      }
    }
  })();

  return source as unknown as EventSource;
}
```

- [ ] **Step 2: SSE 훅 작성**

```typescript
// frontend/src/hooks/useAgentInterview.ts
import { useCallback, useRef, useState } from "react";
import {
  startAgentInterview,
  submitAgentAnswer,
  endAgentInterview,
  type AgentStartParams,
} from "@/lib/agent-interview-api";

export interface AgentMessage {
  role: "agent_question" | "user_answer" | "agent_evaluation" | "agent_followup";
  content: string;
  evaluation?: Record<string, unknown>;
  questionNumber?: number;
  followUpRound?: number;
}

type Phase =
  | "idle"
  | "loading_profile"
  | "generating_question"
  | "waiting_answer"
  | "evaluating"
  | "generating_followup"
  | "generating_report"
  | "completed"
  | "error";

export function useAgentInterview() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState(0);
  const [maxQuestions, setMaxQuestions] = useState(7);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const attachListeners = useCallback(
    (source: EventSource) => {
      sourceRef.current = source;

      source.addEventListener("status", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setPhase(data.phase as Phase);
      });

      source.addEventListener("session", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setSessionId(data.sessionId);
        setQuestionCount(data.questionCount);
        setMaxQuestions(data.maxQuestions);
      });

      source.addEventListener("question", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          {
            role: data.followUpRound > 0 ? "agent_followup" : "agent_question",
            content: data.question,
            questionNumber: data.questionNumber,
            followUpRound: data.followUpRound,
          },
        ]);
        setQuestionCount(data.questionNumber);
        setPhase("waiting_answer");
      });

      source.addEventListener("evaluation", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          {
            role: "agent_evaluation",
            content: data.briefFeedback,
            evaluation: data,
          },
        ]);
      });

      source.addEventListener("action", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        if (data.action === "end") {
          // Report will come via "complete" event
        }
      });

      source.addEventListener("complete", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setReport(data.report);
        setPhase("completed");
        cleanup();
      });

      source.addEventListener("error", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setError(data.error || "오류가 발생했습니다");
        } catch {
          setError("연결이 끊어졌습니다");
        }
        setPhase("error");
        cleanup();
      });
    },
    [cleanup],
  );

  const start = useCallback(
    (params: AgentStartParams) => {
      cleanup();
      setMessages([]);
      setReport(null);
      setError(null);
      setPhase("loading_profile");

      const source = startAgentInterview(params);
      attachListeners(source);
    },
    [cleanup, attachListeners],
  );

  const submitAnswer = useCallback(
    (answer: string) => {
      if (!sessionId) return;
      cleanup();

      setMessages((prev) => [
        ...prev,
        { role: "user_answer", content: answer },
      ]);
      setPhase("evaluating");

      const source = submitAgentAnswer({ sessionId, answer });
      attachListeners(source);
    },
    [sessionId, cleanup, attachListeners],
  );

  const endEarly = useCallback(async () => {
    if (!sessionId) return;
    cleanup();
    await endAgentInterview(sessionId);
    setPhase("completed");
  }, [sessionId, cleanup]);

  return {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions,
    report,
    error,
    start,
    submitAnswer,
    endEarly,
  };
}
```

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/lib/agent-interview-api.ts frontend/src/hooks/useAgentInterview.ts
git commit -m "feat(frontend): 에이전트 면접 API 클라이언트 + SSE 훅"
```

---

## Task 11: 프론트엔드 — 대화형 면접 UI 컴포넌트

**Files:**
- Create: `frontend/src/components/agent-interview/chat-message.tsx`
- Create: `frontend/src/components/agent-interview/agent-interview-panel.tsx`

- [ ] **Step 1: 대화 메시지 버블 컴포넌트**

```tsx
// frontend/src/components/agent-interview/chat-message.tsx
"use client";

import { cn } from "@/lib/utils";
import type { AgentMessage } from "@/hooks/useAgentInterview";

interface ChatMessageProps {
  message: AgentMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isAgent = message.role !== "user_answer";

  return (
    <div className={cn("flex w-full", isAgent ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3",
          isAgent
            ? "bg-muted text-foreground"
            : "bg-primary text-primary-foreground",
        )}
      >
        {message.role === "agent_evaluation" && message.evaluation ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">
                {(message.evaluation as Record<string, number>).overallScore}점
              </span>
            </div>
            <p className="text-sm">{message.content}</p>
            {(message.evaluation as Record<string, string>).detailedFeedback && (
              <p className="text-xs opacity-80">
                {(message.evaluation as Record<string, string>).detailedFeedback}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        )}

        {(message.role === "agent_question" || message.role === "agent_followup") &&
          message.questionNumber && (
            <span className="text-xs opacity-50 mt-1 block">
              질문 {message.questionNumber}
              {message.followUpRound ? ` (꼬리질문 ${message.followUpRound})` : ""}
            </span>
          )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 면접 진행 패널 컴포넌트**

```tsx
// frontend/src/components/agent-interview/agent-interview-panel.tsx
"use client";

import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Mic, Square, Send } from "lucide-react";
import { ChatMessage } from "./chat-message";
import { useAgentInterview } from "@/hooks/useAgentInterview";

interface AgentInterviewPanelProps {
  resumeId: string;
  jobPostingId?: string;
  maxQuestions?: number;
  textMode?: boolean;
  onComplete?: (sessionId: string) => void;
}

export function AgentInterviewPanel({
  resumeId,
  jobPostingId,
  maxQuestions = 7,
  textMode = false,
  onComplete,
}: AgentInterviewPanelProps) {
  const {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions: maxQ,
    report,
    error,
    start,
    submitAnswer,
    endEarly,
  } = useAgentInterview();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Start interview on mount
  useEffect(() => {
    start({ resumeId, jobPostingId, maxQuestions, textMode });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleTextSubmit = () => {
    const text = textInputRef.current?.value.trim();
    if (!text || phase !== "waiting_answer") return;
    submitAnswer(text);
    if (textInputRef.current) textInputRef.current.value = "";
  };

  const isProcessing = [
    "loading_profile",
    "generating_question",
    "evaluating",
    "generating_followup",
    "generating_report",
  ].includes(phase);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <h2 className="font-semibold">AI 코치 면접</h2>
          <p className="text-xs text-muted-foreground">
            질문 {questionCount} / {maxQ}
          </p>
        </div>
        {phase !== "completed" && (
          <Button variant="outline" size="sm" onClick={endEarly}>
            면접 종료
          </Button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}

        {isProcessing && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">
              {phase === "loading_profile" && "프로필 분석 중..."}
              {phase === "generating_question" && "질문 생성 중..."}
              {phase === "evaluating" && "답변 평가 중..."}
              {phase === "generating_followup" && "꼬리질문 생성 중..."}
              {phase === "generating_report" && "리포트 생성 중..."}
            </span>
          </div>
        )}

        {error && (
          <div className="text-destructive text-sm">{error}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {phase === "waiting_answer" && (
        <div className="border-t p-4">
          {textMode ? (
            <div className="flex gap-2">
              <textarea
                ref={textInputRef}
                className="flex-1 min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm resize-none"
                placeholder="답변을 입력하세요..."
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleTextSubmit();
                  }
                }}
              />
              <Button onClick={handleTextSubmit} size="icon">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center">
              음성 답변 기능은 기존 마이크 훅과 연동하여 구현됩니다.
              텍스트 모드로 전환하려면 설정에서 textMode를 활성화하세요.
            </p>
          )}
        </div>
      )}

      {/* Complete */}
      {phase === "completed" && report && (
        <div className="border-t p-4">
          <Button
            className="w-full"
            onClick={() => sessionId && onComplete?.(sessionId)}
          >
            리포트 확인하기
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/agent-interview/chat-message.tsx frontend/src/components/agent-interview/agent-interview-panel.tsx
git commit -m "feat(ui): 에이전트 면접 대화형 UI — ChatMessage + AgentInterviewPanel"
```

---

## Task 12: 프론트엔드 — 페이지 라우트 + 사이드바

**Files:**
- Create: `frontend/src/app/agent-interview/setup/page.tsx`
- Create: `frontend/src/app/agent-interview/session/[id]/page.tsx`
- Modify: `frontend/src/components/layout/sidebar.tsx`

- [ ] **Step 1: 설정 페이지 작성**

```tsx
// frontend/src/app/agent-interview/setup/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useQuery } from "@tanstack/react-query";

export default function AgentInterviewSetupPage() {
  const router = useRouter();
  const [resumeId, setResumeId] = useState("");
  const [maxQuestions, setMaxQuestions] = useState("7");
  const [textMode, setTextMode] = useState(false);

  const { data: resumes } = useQuery({
    queryKey: ["resumes"],
    queryFn: async () => {
      const res = await fetch("/api/resume", { credentials: "include" });
      if (!res.ok) throw new Error("이력서 목록을 불러올 수 없습니다");
      return res.json();
    },
  });

  const handleStart = () => {
    if (!resumeId) return;
    const params = new URLSearchParams({
      resumeId,
      maxQuestions,
      textMode: String(textMode),
    });
    router.push(`/agent-interview/session/new?${params}`);
  };

  return (
    <div className="container max-w-2xl py-8">
      <Card>
        <CardHeader>
          <CardTitle>AI 코치 면접</CardTitle>
          <CardDescription>
            AI가 당신을 기억하고, 맞춤형 면접을 진행합니다
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>이력서 선택 (필수)</Label>
            <Select value={resumeId} onValueChange={setResumeId}>
              <SelectTrigger>
                <SelectValue placeholder="이력서를 선택하세요" />
              </SelectTrigger>
              <SelectContent>
                {resumes?.map((r: { id: string; name: string }) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>질문 수</Label>
            <Select value={maxQuestions} onValueChange={setMaxQuestions}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[3, 5, 7, 10].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}개
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>텍스트 모드</Label>
            <Switch checked={textMode} onCheckedChange={setTextMode} />
          </div>

          <Button
            className="w-full"
            disabled={!resumeId}
            onClick={handleStart}
          >
            면접 시작
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: 세션 페이지 작성**

```tsx
// frontend/src/app/agent-interview/session/[id]/page.tsx
"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { AgentInterviewPanel } from "@/components/agent-interview/agent-interview-panel";

export default function AgentInterviewSessionPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const resumeId = searchParams.get("resumeId") || "";
  const jobPostingId = searchParams.get("jobPostingId") || undefined;
  const maxQuestions = Number(searchParams.get("maxQuestions")) || 7;
  const textMode = searchParams.get("textMode") === "true";

  if (!resumeId) {
    router.replace("/agent-interview/setup");
    return null;
  }

  return (
    <div className="h-[calc(100vh-4rem)]">
      <AgentInterviewPanel
        resumeId={resumeId}
        jobPostingId={jobPostingId}
        maxQuestions={maxQuestions}
        textMode={textMode}
        onComplete={(sessionId) => {
          router.push(`/agent-interview/session/${sessionId}`);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 3: 사이드바에 메뉴 추가**

`frontend/src/components/layout/sidebar.tsx`에서 기존 면접 관련 메뉴 근처에 "AI 코치 면접" 항목 추가. 아이콘은 `Bot` (lucide-react) 사용. 경로: `/agent-interview/setup`.

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/app/agent-interview/ frontend/src/components/layout/sidebar.tsx
git commit -m "feat(pages): 에이전트 면접 설정/세션 페이지 + 사이드바 메뉴"
```

---

## Task 13: Docker + 의존성 통합

**Files:**
- Modify: `backend/Dockerfile` (if exists) or `docker-compose.yml`

- [ ] **Step 1: Docker 이미지에서 langgraph, pgvector 설치 확인**

현재 `docker-compose.yml`의 backend 서비스에서 `pip install` 단계에 새 의존성이 포함되는지 확인.
`pyproject.toml`에 이미 추가했으므로, 이미지 리빌드만 필요.

Run: `cd C:/Users/djgnf/Desktop/window_project/voice_training && docker compose build backend`
Expected: langgraph, pgvector 포함하여 빌드 성공

- [ ] **Step 2: 컨테이너 재시작 + 엔드포인트 확인**

Run: `docker compose up -d && curl -s http://localhost:81/api/health`
Expected: `{"status": "ok"}`

- [ ] **Step 3: 커밋 (필요 시)**

Dockerfile 수정이 있었다면 커밋.

---

## Task 14: 수동 통합 테스트

- [ ] **Step 1: 마이그레이션 실행 확인**

Supabase SQL Editor에서 마이그레이션 실행 후, 테이블 존재 확인:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('user_profile_embeddings', 'agent_interview_sessions', 'agent_interview_messages');
```

Expected: 3개 테이블 반환

- [ ] **Step 2: pgvector 확장 확인**

```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

Expected: vector 확장 활성화됨

- [ ] **Step 3: 에이전트 면접 시작 테스트**

브라우저에서 `/agent-interview/setup` 접속 → 이력서 선택 → 텍스트 모드 ON → 면접 시작.
Expected: 프로필 로딩 → 첫 질문 생성 → 대화형 UI에 질문 표시

- [ ] **Step 4: 답변 제출 + 평가 테스트**

텍스트 모드로 답변 입력 → 전송.
Expected: 평가 결과 표시 → 다음 질문 또는 꼬리질문 생성

- [ ] **Step 5: 면접 종료 + 프로필 저장 확인**

면접 끝까지 진행 또는 "면접 종료" 클릭.
Expected: 리포트 생성 + `user_profile_embeddings` 테이블에 데이터 삽입 확인

```sql
SELECT category, content FROM user_profile_embeddings WHERE "userId" = '사용자ID' ORDER BY "createdAt" DESC;
```
