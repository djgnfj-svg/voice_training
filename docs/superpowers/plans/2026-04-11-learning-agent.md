# Learning Agent (오늘의 학습 에이전트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 Nightly Study를 에이전트 기반 AI 튜터로 완전 대체. 질문 뱅크 제거, 동적 질문 생성, 프로필 RAG 연동, 한 주제를 깊이 파고드는 음성 학습 시스템.

**Architecture:** 에이전트 면접의 `state → nodes → SSE` 패턴을 복사하되 학습 전용 노드(teach, assess, check_credit)를 신규 작성. `profile_agent`와 `call_llm_json`은 공유. 기존 nightly-study URL 유지하면서 내부 구현만 교체.

**Tech Stack:** FastAPI + SSE (sse_starlette) + Claude API (call_llm_json) + pgvector RAG (profile_agent) + Edge TTS + Web Speech API + Next.js + shadcn/ui

---

## File Structure

### Backend — 신규 생성

| File | Responsibility |
|------|---------------|
| `backend/app/agent/learning_state.py` | `LearningState` TypedDict 정의 |
| `backend/app/agent/learning_nodes.py` | 5개 노드 함수 (load_profile, teach, assess, check_credit, update_profile) |
| `backend/app/agent/tutor_agent.py` | teach/assess LLM 호출 래퍼 |
| `backend/app/prompts/learning_agent.py` | 튜터/평가 프롬프트 상수 |
| `backend/app/routers/learning_agent.py` | 4개 API 엔드포인트 (start, respond, end, status) |
| `backend/app/models/learning_agent.py` | `LearningAgentSession`, `LearningAgentMessage` SQLAlchemy 모델 |

### Backend — 수정

| File | Change |
|------|--------|
| `backend/app/models/__init__.py` | 새 모델 import 추가 |
| `backend/app/models/enums.py` | `ActivityType`에 `LEARNING_AGENT` 추가 |
| `backend/app/main.py` | 새 라우터 등록, 기존 nightly_study 라우터 제거 |

### Backend — 삭제

| File | Reason |
|------|--------|
| `backend/app/routers/nightly_study.py` | 새 라우터로 대체 |
| `backend/app/prompts/nightly_study.py` | 새 프롬프트로 대체 |
| `backend/data/questions/*.json` (7개) | 동적 생성으로 대체 |

### Frontend — 신규 생성

| File | Responsibility |
|------|---------------|
| `frontend/src/lib/learning-agent-api.ts` | SSE API 클라이언트 (createSSEFromPost 재사용) |
| `frontend/src/hooks/useLearningAgent.ts` | 학습 세션 상태 관리 훅 |

### Frontend — 교체 (기존 URL, 새 구현)

| File | Change |
|------|--------|
| `frontend/src/app/(authenticated)/nightly-study/page.tsx` | 새 설정 페이지 (카테고리 선택 제거, 바로 시작) |
| `frontend/src/app/(authenticated)/nightly-study/session/page.tsx` | 에이전트 기반 세션 페이지 |

### Frontend — 수정

| File | Change |
|------|--------|
| `frontend/src/components/layout/sidebar.tsx` | 메뉴 유지 (변경 없을 수 있음) |

### Frontend — 삭제

| File | Reason |
|------|--------|
| `frontend/src/hooks/useNightlyStudy.ts` | `useLearningAgent`로 대체 |
| `frontend/src/components/nightly-study/topic-selector.tsx` | 자유 입력으로 대체 |

### DB Migration

| Change | Detail |
|--------|--------|
| Prisma schema | `LearningAgentSession`, `LearningAgentMessage` 모델 추가 |
| Enum | `ActivityType`에 `LEARNING_AGENT` 추가 |

---

## Task 1: DB 모델 및 마이그레이션

**Files:**
- Create: `backend/app/models/learning_agent.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/models/enums.py`
- Modify: `frontend/prisma/schema.prisma`

- [ ] **Step 1: Prisma 스키마에 새 모델 추가**

`frontend/prisma/schema.prisma`에 추가:

```prisma
model LearningAgentSession {
  id              String   @id @default(uuid())
  userId          String
  topic           String?
  status          String   @default("active")    // active | completed | abandoned
  llmCallCount    Int      @default(0)
  creditDeducted  Boolean  @default(false)
  isFreeSession   Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user     User                    @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages LearningAgentMessage[]

  @@index([userId])
  @@index([userId, createdAt])
  @@map("learning_agent_sessions")
}

model LearningAgentMessage {
  id           String   @id @default(uuid())
  sessionId    String
  messageIndex Int
  role         String   // tutor | user
  content      String   @db.Text
  phase        String?  // explain | check | deepen | apply | wrap_up
  assessment   Json?
  createdAt    DateTime @default(now())

  session LearningAgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, messageIndex])
  @@index([sessionId])
  @@map("learning_agent_messages")
}
```

`User` 모델에 relation 추가:

```prisma
model User {
  // ... 기존 필드 ...
  learningAgentSessions LearningAgentSession[]
}
```

`ActivityType` enum에 추가:

```prisma
enum ActivityType {
  MODEL_ANSWER
  NIGHTLY_STUDY
  LEARNING_AGENT
}
```

- [ ] **Step 2: Prisma 마이그레이션 실행**

```bash
cd frontend && set -a && source .env && set +a && npx prisma migrate dev --name add_learning_agent
```

Expected: Migration created and applied successfully.

- [ ] **Step 3: SQLAlchemy 모델 생성 — `learning_agent.py`**

`backend/app/models/learning_agent.py`:

```python
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class LearningAgentSession(Base):
    __tablename__ = "learning_agent_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column("userId", String, ForeignKey("users.id", ondelete="CASCADE"))
    topic: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active")
    llm_call_count: Mapped[int] = mapped_column("llmCallCount", Integer, default=0)
    credit_deducted: Mapped[bool] = mapped_column("creditDeducted", Boolean, default=False)
    is_free_session: Mapped[bool] = mapped_column("isFreeSession", Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt",
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    messages: Mapped[list["LearningAgentMessage"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class LearningAgentMessage(Base):
    __tablename__ = "learning_agent_messages"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(
        "sessionId", String, ForeignKey("learning_agent_sessions.id", ondelete="CASCADE")
    )
    message_index: Mapped[int] = mapped_column("messageIndex", Integer)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    phase: Mapped[str | None] = mapped_column(String(20), nullable=True)
    assessment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    session: Mapped["LearningAgentSession"] = relationship(back_populates="messages")

    __table_args__ = (UniqueConstraint("sessionId", "messageIndex"),)
```

- [ ] **Step 4: enums.py에 ActivityType 추가**

`backend/app/models/enums.py`에서 `ActivityType`에 `LEARNING_AGENT = "LEARNING_AGENT"` 추가.

- [ ] **Step 5: `__init__.py`에 새 모델 import 추가**

`backend/app/models/__init__.py`에 추가:

```python
from app.models.learning_agent import LearningAgentSession, LearningAgentMessage
```

- [ ] **Step 6: Docker 컨테이너 재시작으로 모델 로드 확인**

```bash
docker compose restart backend
docker compose logs backend --tail=20
```

Expected: 에러 없이 서버 시작.

- [ ] **Step 7: 커밋**

```bash
git add backend/app/models/learning_agent.py backend/app/models/__init__.py backend/app/models/enums.py frontend/prisma/schema.prisma frontend/prisma/migrations/
git commit -m "feat: LearningAgentSession/Message DB 모델 + Prisma 마이그레이션"
```

---

## Task 2: LearningState + 프롬프트

**Files:**
- Create: `backend/app/agent/learning_state.py`
- Create: `backend/app/prompts/learning_agent.py`

- [ ] **Step 1: LearningState 정의**

`backend/app/agent/learning_state.py`:

```python
from typing import TypedDict


class LearningState(TypedDict, total=False):
    session_id: str
    user_id: str
    topic: str
    user_profile: dict
    conversation_history: list[dict]
    current_phase: str  # "explain" | "check" | "deepen" | "apply" | "wrap_up"
    llm_call_count: int
    credit_activated: bool
    is_free_session: bool
    pending_events: list[dict]
```

- [ ] **Step 2: 튜터 프롬프트 작성**

`backend/app/prompts/learning_agent.py`:

```python
TUTOR_GREETING_PROMPT = """당신은 친근하고 전문적인 AI 학습 튜터입니다.
사용자가 오늘 무엇을 공부하고 싶은지 물어보세요.

## 사용자 프로필 (이전 학습 기록)
{user_profile}

## 지침
- 한국어로 대화하세요
- 반말(~해요 체)로 자연스럽게 말하세요
- 이전 학습 기록이 있으면 간단히 언급하며 인사하세요
- "오늘은 어떤 걸 공부하고 싶어요?" 같은 자연스러운 질문으로 시작하세요
- 이모지 사용 금지
- 3문장 이내로 짧게

JSON으로 응답:
{{"message": "인사 + 주제 질문"}}"""

TUTOR_TEACH_PROMPT = """당신은 친근하고 전문적인 AI 학습 튜터입니다.
사용자가 선택한 주제를 깊이 있게 가르치고 있습니다.

## 주제
{topic}

## 현재 Phase
{phase}

## 사용자 프로필
{user_profile}

## 대화 기록
{conversation_history}

## 사용자의 마지막 발화
{user_message}

## Phase별 행동 지침

### explain (핵심 개념 설명)
- 이 개념이 왜 존재하는지, 어떻게 동작하는지 체계적으로 설명
- 비유나 실생활 예시로 이해를 도움
- 핵심 포인트를 명확하게 짚어줌
- 너무 길지 않게 4-6문장

### check (이해 확인)
- 사용자가 설명할 수 있는 질문을 던짐
- 단답이 아니라 사고 과정을 유도
- "~를 설명해볼 수 있어요?" 형태
- 2-3문장

### deepen (심화)
- 내부 동작 원리, 엣지 케이스, 흔한 실수
- 관련 개념과의 연결
- "사실 여기서 중요한 건..." 형태
- 4-6문장

### apply (응용/면접)
- 실무에서 어떻게 쓰이는지
- 면접에서 어떻게 출제되는지
- 구체적 코드 예시나 시나리오
- 4-6문장

### wrap_up (정리)
- 오늘 배운 내용 3줄 요약
- 다음에 이어서 볼 주제 제안
- 격려
- 3-5문장

## 공통 지침
- 한국어, 반말(~해요 체)
- 이모지 사용 금지
- 하나의 주제를 깊이 파고들기. 다른 주제로 넘어가지 말 것
- 사용자가 이해한 부분은 반복하지 말고 다음 깊이로 진행

JSON으로 응답:
{{"message": "튜터 발화 내용"}}"""

TUTOR_ASSESS_PROMPT = """사용자의 발화를 분석하여 이해도를 판단하세요.

## 주제
{topic}

## 현재 Phase
{current_phase}

## 대화 기록
{conversation_history}

## 사용자의 발화
{user_message}

## 판단 기준
- none: 완전히 모르거나 관련 없는 답변
- partial: 일부 이해했지만 핵심을 놓침
- solid: 핵심을 정확히 이해함
- deep: 핵심 + 응용/확장까지 이해함

## Phase 전환 규칙
- understanding이 "none" 또는 "partial" → next_phase: "explain" (보충 설명)
- understanding이 "solid" → next_phase: "deepen" (심화)
- understanding이 "deep" → next_phase: "apply" (응용)
- 사용자가 종료 의사 표현 ("그만", "끝", "다음에" 등) → next_phase: "wrap_up"
- 사용자가 새 주제를 말하면 → next_phase: "new_topic", new_topic 필드에 주제명

## 특수 케이스: 첫 턴 (주제 선택)
대화 기록이 비어있고 사용자가 주제를 말하고 있다면:
- understanding: "topic_selected"
- next_phase: "explain"
- topic: 사용자가 말한 주제

JSON으로 응답:
{{"understanding": "none|partial|solid|deep|topic_selected", "weak_points": ["구체적 약점"], "next_phase": "explain|check|deepen|apply|wrap_up|new_topic", "topic": "주제명 (topic_selected일 때만)", "reasoning": "판단 근거 1문장"}}"""

TUTOR_SUMMARY_PROMPT = """학습 세션을 요약하세요.

## 주제
{topic}

## 대화 기록
{conversation_history}

## 사용자 프로필
{user_profile}

## 지침
- 오늘 다룬 핵심 내용 정리
- 사용자가 잘 이해한 부분 (강점)
- 아직 보충이 필요한 부분 (약점)
- 다음 학습 추천 주제

JSON으로 응답:
{{"topicCovered": "다룬 주제", "keyPoints": ["핵심 내용 1", "핵심 내용 2", ...], "strengths": ["잘 이해한 부분"], "weaknesses": ["보충 필요한 부분"], "nextTopicSuggestion": "다음 추천 주제", "encouragement": "격려 메시지"}}"""

TUTOR_PROFILE_INSIGHT_PROMPT = """학습 세션에서 사용자의 학습 인사이트를 추출하세요.

## 주제
{topic}

## 대화 기록
{conversation_history}

## 지침
RAG 프로필에 저장할 인사이트를 추출합니다.
각 카테고리별로 의미 있는 내용만 추출하세요. 해당 없으면 빈 배열.

JSON으로 응답:
{{"strengths": ["이 주제에서 발견된 강점"], "weaknesses": ["발견된 약점/오해"], "learning_progress": ["주제: 어디까지 학습했는지 요약"]}}"""
```

- [ ] **Step 3: 커밋**

```bash
git add backend/app/agent/learning_state.py backend/app/prompts/learning_agent.py
git commit -m "feat: LearningState 정의 + 튜터 에이전트 프롬프트"
```

---

## Task 3: Tutor Agent (LLM 호출 래퍼)

**Files:**
- Create: `backend/app/agent/tutor_agent.py`

- [ ] **Step 1: tutor_agent.py 작성**

`backend/app/agent/tutor_agent.py`:

```python
import json
import logging

from app.config import settings
from app.lib.anthropic_client import call_llm_json
from app.prompts.learning_agent import (
    TUTOR_ASSESS_PROMPT,
    TUTOR_GREETING_PROMPT,
    TUTOR_PROFILE_INSIGHT_PROMPT,
    TUTOR_SUMMARY_PROMPT,
    TUTOR_TEACH_PROMPT,
)

logger = logging.getLogger(__name__)


async def generate_greeting(user_profile: dict) -> dict:
    """세션 시작 인사 + 주제 질문 생성."""
    profile_str = json.dumps(user_profile, ensure_ascii=False) if user_profile else "이전 학습 기록 없음"
    prompt = TUTOR_GREETING_PROMPT.replace("{user_profile}", profile_str)
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def generate_teaching(
    topic: str,
    phase: str,
    user_profile: dict,
    conversation_history: list[dict],
    user_message: str,
) -> dict:
    """phase에 따라 설명/심화/응용/정리 생성."""
    prompt = (
        TUTOR_TEACH_PROMPT.replace("{topic}", topic)
        .replace("{phase}", phase)
        .replace("{user_profile}", json.dumps(user_profile, ensure_ascii=False) if user_profile else "없음")
        .replace("{conversation_history}", json.dumps(conversation_history, ensure_ascii=False) if conversation_history else "없음")
        .replace("{user_message}", user_message)
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def assess_understanding(
    topic: str,
    current_phase: str,
    conversation_history: list[dict],
    user_message: str,
) -> dict:
    """사용자 이해도 판단 + 다음 phase 결정."""
    prompt = (
        TUTOR_ASSESS_PROMPT.replace("{topic}", topic or "미정")
        .replace("{current_phase}", current_phase)
        .replace("{conversation_history}", json.dumps(conversation_history, ensure_ascii=False) if conversation_history else "없음")
        .replace("{user_message}", user_message)
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)


async def generate_summary(
    topic: str,
    conversation_history: list[dict],
    user_profile: dict,
) -> dict:
    """세션 요약 생성."""
    prompt = (
        TUTOR_SUMMARY_PROMPT.replace("{topic}", topic or "자유 주제")
        .replace("{conversation_history}", json.dumps(conversation_history, ensure_ascii=False))
        .replace("{user_profile}", json.dumps(user_profile, ensure_ascii=False) if user_profile else "없음")
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.5)


async def extract_profile_insights(
    topic: str,
    conversation_history: list[dict],
) -> dict:
    """프로필 RAG에 저장할 인사이트 추출."""
    prompt = (
        TUTOR_PROFILE_INSIGHT_PROMPT.replace("{topic}", topic or "자유 주제")
        .replace("{conversation_history}", json.dumps(conversation_history, ensure_ascii=False))
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)
```

- [ ] **Step 2: 커밋**

```bash
git add backend/app/agent/tutor_agent.py
git commit -m "feat: tutor_agent — 학습 에이전트 LLM 호출 래퍼"
```

---

## Task 4: Learning Nodes

**Files:**
- Create: `backend/app/agent/learning_nodes.py`

- [ ] **Step 1: learning_nodes.py 작성**

`backend/app/agent/learning_nodes.py`:

```python
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import tutor_agent
from app.agent.learning_state import LearningState
from app.agent.profile_agent import search_profile, update_profile as upsert_profile

logger = logging.getLogger(__name__)

FREE_LLM_CALL_LIMIT = 3


async def load_profile(state: LearningState, db: AsyncSession) -> LearningState:
    """RAG에서 사용자 프로필을 검색."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "loading_profile"}})

    query = state.get("topic") or "학습 프로필"
    results = await search_profile(db, state["user_id"], query, top_k=10)

    profile = {"strengths": [], "weaknesses": [], "patterns": [], "context": [], "learning_progress": []}
    for r in results:
        cat = r.get("category", "context")
        if cat in profile:
            profile[cat].append(r["content"])

    events.append({"event": "status", "data": {"phase": "profile_loaded"}})

    return {**state, "user_profile": profile, "pending_events": events}


async def greet(state: LearningState, db: AsyncSession) -> LearningState:
    """세션 시작 인사. '오늘 뭐 공부할래?' 질문."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "greeting"}})

    result = await tutor_agent.generate_greeting(state.get("user_profile", {}))
    message = result.get("message", "오늘은 어떤 걸 공부하고 싶어요?")

    events.append({"event": "tutor", "data": {"message": message, "phase": "greeting"}})

    history = list(state.get("conversation_history", []))
    history.append({"role": "tutor", "content": message, "phase": "greeting"})

    return {
        **state,
        "conversation_history": history,
        "llm_call_count": state.get("llm_call_count", 0) + 1,
        "pending_events": events,
    }


async def assess(state: LearningState, db: AsyncSession, user_message: str) -> LearningState:
    """사용자 발화 이해도 판단 + 다음 phase 결정."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "assessing"}})

    assessment = await tutor_agent.assess_understanding(
        topic=state.get("topic", ""),
        current_phase=state.get("current_phase", "greeting"),
        conversation_history=state.get("conversation_history", []),
        user_message=user_message,
    )

    next_phase = assessment.get("next_phase", "explain")
    topic = state.get("topic")

    # 첫 턴: 주제 선택
    if assessment.get("understanding") == "topic_selected":
        topic = assessment.get("topic", user_message)
        next_phase = "explain"

    # 새 주제 요청
    if next_phase == "new_topic":
        topic = assessment.get("topic", user_message)
        next_phase = "explain"

    history = list(state.get("conversation_history", []))
    history.append({"role": "user", "content": user_message, "assessment": assessment})

    return {
        **state,
        "topic": topic,
        "current_phase": next_phase,
        "conversation_history": history,
        "llm_call_count": state.get("llm_call_count", 0) + 1,
        "pending_events": events,
    }


async def teach(state: LearningState, db: AsyncSession) -> LearningState:
    """현재 phase에 맞는 튜터 발화 생성."""
    events = list(state.get("pending_events", []))
    phase = state.get("current_phase", "explain")
    events.append({"event": "status", "data": {"phase": f"teaching_{phase}"}})

    # 주제 변경 시 RAG 재검색
    if state.get("topic") and not state.get("_profile_loaded_for_topic"):
        profile_state = await load_profile({**state, "topic": state["topic"]}, db)
        state = {**state, "user_profile": profile_state["user_profile"], "_profile_loaded_for_topic": True}

    last_user_msg = ""
    for msg in reversed(state.get("conversation_history", [])):
        if msg["role"] == "user":
            last_user_msg = msg["content"]
            break

    result = await tutor_agent.generate_teaching(
        topic=state.get("topic", ""),
        phase=phase,
        user_profile=state.get("user_profile", {}),
        conversation_history=state.get("conversation_history", []),
        user_message=last_user_msg,
    )
    message = result.get("message", "")

    events.append({"event": "tutor", "data": {"message": message, "phase": phase}})

    history = list(state.get("conversation_history", []))
    history.append({"role": "tutor", "content": message, "phase": phase})

    return {
        **state,
        "conversation_history": history,
        "llm_call_count": state.get("llm_call_count", 0) + 1,
        "pending_events": events,
    }


async def check_credit(state: LearningState, db: AsyncSession) -> LearningState:
    """무료 한도 체크. 초과 시 credit_prompt 이벤트 발생."""
    events = list(state.get("pending_events", []))

    if state.get("credit_activated") or not state.get("is_free_session"):
        return {**state, "pending_events": events}

    if state.get("llm_call_count", 0) >= FREE_LLM_CALL_LIMIT:
        events.append({
            "event": "credit_prompt",
            "data": {"message": "여기서부터 더 깊이 들어가면 크레딧이 사용돼요. 계속할까요?"},
        })

    return {**state, "pending_events": events}


async def wrap_up(state: LearningState, db: AsyncSession) -> LearningState:
    """세션 정리: 요약 생성 + 프로필 업데이트."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "wrapping_up"}})

    topic = state.get("topic", "")
    history = state.get("conversation_history", [])
    profile = state.get("user_profile", {})

    # 대화가 충분하면 요약 + 프로필 저장
    summary = {}
    if len(history) >= 3 and topic:
        summary = await tutor_agent.generate_summary(topic, history, profile)

        # 프로필 인사이트 추출 → RAG 저장
        try:
            insights = await tutor_agent.extract_profile_insights(topic, history)
            user_id = state["user_id"]

            for strength in insights.get("strengths", []):
                await upsert_profile(db, user_id, "strength", strength, {"source": "learning", "topic": topic})
            for weakness in insights.get("weaknesses", []):
                await upsert_profile(db, user_id, "weakness", weakness, {"source": "learning", "topic": topic})
            for progress in insights.get("learning_progress", []):
                await upsert_profile(db, user_id, "learning_progress", progress, {"source": "learning", "topic": topic})
        except Exception:
            logger.exception("Failed to save learning profile insights")

    events.append({"event": "complete", "data": {"summary": summary}})

    return {**state, "pending_events": events}
```

- [ ] **Step 2: 커밋**

```bash
git add backend/app/agent/learning_nodes.py
git commit -m "feat: learning_nodes — 학습 에이전트 노드 함수 5개"
```

---

## Task 5: 백엔드 라우터

**Files:**
- Create: `backend/app/routers/learning_agent.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: learning_agent.py 라우터 작성**

`backend/app/routers/learning_agent.py`:

```python
import json
import logging
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.agent import learning_nodes
from app.agent.learning_state import LearningState
from app.config import settings
from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.activity import ActivityLog, ActivityItem
from app.models.learning_agent import LearningAgentMessage, LearningAgentSession
from app.services.credit import can_start_session, deduct_for_feature, CREDIT_COSTS
from app.services.daily_progress import record_progress

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/nightly-study", tags=["learning-agent"])


def _get_kst_midnight() -> datetime:
    kst = timezone(timedelta(hours=9))
    now_kst = datetime.now(kst)
    midnight_kst = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_kst.astimezone(timezone.utc)


async def _check_daily_limit(db: AsyncSession, user_id: str) -> bool:
    """오늘 무료 세션을 이미 사용했는지 확인. True면 사용 가능."""
    if settings.is_dev:
        return True
    kst_midnight = _get_kst_midnight()
    stmt = select(LearningAgentSession).where(
        LearningAgentSession.user_id == user_id,
        LearningAgentSession.is_free_session == True,
        LearningAgentSession.created_at >= kst_midnight,
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none() is None


# --- Schemas ---

class RespondBody(BaseModel):
    answer: str
    credit_confirmed: bool = False


# --- Endpoints ---

@router.post("/start")
async def start_session(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    is_free = await _check_daily_limit(db, user.id)

    if not is_free:
        # 크레딧 확인
        credit_check = await can_start_session(db, user.id)
        if not credit_check["allowed"]:
            raise HTTPException(402, {"error": "크레딧이 부족해요.", "code": "INSUFFICIENT_CREDITS"})

    session_id = str(uuid4())
    session = LearningAgentSession(
        id=session_id,
        user_id=user.id,
        status="active",
        is_free_session=is_free,
    )
    db.add(session)
    await db.commit()

    state: LearningState = {
        "session_id": session_id,
        "user_id": user.id,
        "topic": None,
        "user_profile": {},
        "conversation_history": [],
        "current_phase": "greeting",
        "llm_call_count": 0,
        "credit_activated": not is_free,
        "is_free_session": is_free,
        "pending_events": [],
    }

    async def event_generator():
        try:
            nonlocal state
            yield {"event": "session", "data": json.dumps({"sessionId": session_id, "isFree": is_free})}

            # 프로필 로드 (주제 없이 전체 프로필)
            state = await learning_nodes.load_profile(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # 인사 생성
            state = await learning_nodes.greet(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # 인사 메시지 DB 저장
            greeting_msg = state["conversation_history"][-1]
            msg = LearningAgentMessage(
                id=str(uuid4()),
                session_id=session_id,
                message_index=0,
                role="tutor",
                content=greeting_msg["content"],
                phase="greeting",
            )
            db.add(msg)
            session_obj = await db.get(LearningAgentSession, session_id)
            session_obj.llm_call_count = state.get("llm_call_count", 0)
            await db.commit()

        except Exception as e:
            logger.exception("Error in start_session")
            yield {"event": "error", "data": json.dumps({"error": "세션 시작 중 오류가 발생했어요."})}

    return EventSourceResponse(event_generator())


@router.post("/{session_id}/respond")
async def respond(
    session_id: str,
    body: RespondBody,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(LearningAgentSession, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(404, {"error": "세션을 찾을 수 없어요."})
    if session.status != "active":
        raise HTTPException(400, {"error": "이미 종료된 세션이에요."})

    # DB에서 state 재구성
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history = []
    topic = session.topic
    current_phase = "greeting"

    for msg in messages:
        entry = {"role": msg.role, "content": msg.content, "phase": msg.phase}
        if msg.assessment:
            entry["assessment"] = msg.assessment
        conversation_history.append(entry)
        if msg.phase and msg.role == "tutor":
            current_phase = msg.phase

    state: LearningState = {
        "session_id": session_id,
        "user_id": user.id,
        "topic": topic,
        "user_profile": {},
        "conversation_history": conversation_history,
        "current_phase": current_phase,
        "llm_call_count": session.llm_call_count,
        "credit_activated": session.credit_deducted or not session.is_free_session,
        "is_free_session": session.is_free_session,
        "pending_events": [],
    }

    # 크레딧 확인 응답 처리
    if body.credit_confirmed:
        state["credit_activated"] = True

    async def event_generator():
        try:
            nonlocal state
            next_msg_index = len(messages)

            # 프로필 로드
            state = await learning_nodes.load_profile(state, db)
            state["pending_events"] = []

            # 1. 사용자 발화 저장
            user_msg = LearningAgentMessage(
                id=str(uuid4()),
                session_id=session_id,
                message_index=next_msg_index,
                role="user",
                content=body.answer,
            )
            db.add(user_msg)
            next_msg_index += 1

            # 2. 이해도 평가
            state = await learning_nodes.assess(state, db, body.answer)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # assess 결과 user 메시지에 저장
            last_assessment = None
            for msg in reversed(state["conversation_history"]):
                if msg["role"] == "user" and msg.get("assessment"):
                    last_assessment = msg["assessment"]
                    break
            if last_assessment:
                user_msg.assessment = last_assessment
                user_msg.phase = state.get("current_phase")

            # 주제 업데이트
            if state.get("topic") and state["topic"] != topic:
                session.topic = state["topic"]

            # 3. wrap_up이면 세션 종료
            if state.get("current_phase") == "wrap_up":
                state = await learning_nodes.wrap_up(state, db)
                for ev in state.get("pending_events", []):
                    yield {"event": ev["event"], "data": json.dumps(ev["data"])}
                state["pending_events"] = []

                # 세션 상태 업데이트
                session.status = "completed"
                session.llm_call_count = state.get("llm_call_count", 0)

                # 크레딧 차감
                if state.get("credit_activated") and not session.credit_deducted:
                    try:
                        await deduct_for_feature(
                            db, user.id, session_id,
                            "학습 에이전트 세션", CREDIT_COSTS["SESSION"],
                        )
                        session.credit_deducted = True
                    except Exception:
                        logger.exception("Credit deduction failed")

                # ActivityLog 저장
                await _save_activity(db, user.id, session, state)

                await db.commit()
                return

            # 4. 크레딧 체크
            state = await learning_nodes.check_credit(state, db)
            has_credit_prompt = any(
                ev["event"] == "credit_prompt" for ev in state.get("pending_events", [])
            )
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # 크레딧 프롬프트가 발생했으면 여기서 중단 (사용자 응답 대기)
            if has_credit_prompt and not state.get("credit_activated"):
                session.llm_call_count = state.get("llm_call_count", 0)
                await db.commit()
                return

            # 5. 튜터 발화 생성
            state = await learning_nodes.teach(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            # 튜터 메시지 DB 저장
            tutor_msg_content = state["conversation_history"][-1]
            tutor_msg = LearningAgentMessage(
                id=str(uuid4()),
                session_id=session_id,
                message_index=next_msg_index,
                role="tutor",
                content=tutor_msg_content["content"],
                phase=state.get("current_phase"),
            )
            db.add(tutor_msg)

            session.llm_call_count = state.get("llm_call_count", 0)
            await db.commit()

        except Exception as e:
            logger.exception("Error in respond")
            yield {"event": "error", "data": json.dumps({"error": "응답 처리 중 오류가 발생했어요."})}

    return EventSourceResponse(event_generator())


@router.post("/{session_id}/end")
async def end_session(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(LearningAgentSession, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(404, {"error": "세션을 찾을 수 없어요."})
    if session.status != "active":
        raise HTTPException(400, {"error": "이미 종료된 세션이에요."})

    # DB에서 state 재구성
    messages = sorted(session.messages, key=lambda m: m.message_index)
    conversation_history = [
        {"role": msg.role, "content": msg.content, "phase": msg.phase}
        for msg in messages
    ]

    state: LearningState = {
        "session_id": session_id,
        "user_id": user.id,
        "topic": session.topic,
        "user_profile": {},
        "conversation_history": conversation_history,
        "current_phase": "wrap_up",
        "llm_call_count": session.llm_call_count,
        "credit_activated": session.credit_deducted or not session.is_free_session,
        "is_free_session": session.is_free_session,
        "pending_events": [],
    }

    async def event_generator():
        try:
            nonlocal state

            # 프로필 로드
            state = await learning_nodes.load_profile(state, db)
            state["pending_events"] = []

            # wrap_up
            state = await learning_nodes.wrap_up(state, db)
            for ev in state.get("pending_events", []):
                yield {"event": ev["event"], "data": json.dumps(ev["data"])}
            state["pending_events"] = []

            session.status = "completed"
            session.llm_call_count = state.get("llm_call_count", 0)

            if state.get("credit_activated") and not session.credit_deducted:
                try:
                    await deduct_for_feature(
                        db, user.id, session_id,
                        "학습 에이전트 세션", CREDIT_COSTS["SESSION"],
                    )
                    session.credit_deducted = True
                except Exception:
                    logger.exception("Credit deduction failed")

            await _save_activity(db, user.id, session, state)
            await db.commit()

        except Exception as e:
            logger.exception("Error in end_session")
            yield {"event": "error", "data": json.dumps({"error": "세션 종료 중 오류가 발생했어요."})}

    return EventSourceResponse(event_generator())


@router.get("/status")
async def get_status(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    can_free = await _check_daily_limit(db, user.id)
    return {"dailyLimitReached": not can_free}


async def _save_activity(
    db: AsyncSession,
    user_id: str,
    session: LearningAgentSession,
    state: LearningState,
) -> None:
    """ActivityLog + DailyProgress 저장."""
    # 완료 이벤트에서 summary 추출
    summary = {}
    for ev in state.get("pending_events", []):
        if ev["event"] == "complete":
            summary = ev["data"].get("summary", {})

    activity = ActivityLog(
        id=str(uuid4()),
        user_id=user_id,
        type="LEARNING_AGENT",
        metadata_={
            "topic": session.topic,
            "llmCallCount": session.llm_call_count,
            "summary": summary,
        },
    )
    db.add(activity)
    await db.flush()

    # 대화에서 질문/답변 쌍 추출
    history = state.get("conversation_history", [])
    idx = 0
    for i, msg in enumerate(history):
        if msg["role"] == "tutor" and msg.get("phase") in ("check", "explain"):
            user_answer = ""
            if i + 1 < len(history) and history[i + 1]["role"] == "user":
                user_answer = history[i + 1]["content"]
            item = ActivityItem(
                id=str(uuid4()),
                activity_log_id=activity.id,
                index=idx,
                question=msg["content"],
                answer=user_answer,
                extra={"phase": msg.get("phase"), "topic": session.topic},
            )
            db.add(item)
            idx += 1

    await record_progress(
        db,
        user_id=user_id,
        session_data={
            "subjectId": "learning-agent",
            "totalQuestions": idx,
            "correctCount": 0,
            "durationSeconds": 0,
            "topicsStudied": [session.topic] if session.topic else [],
        },
    )
```

- [ ] **Step 2: main.py에 라우터 등록, 기존 nightly_study 제거**

`backend/app/main.py`에서:
- `from app.routers.nightly_study import router as nightly_study_router` → `from app.routers.learning_agent import router as learning_agent_router` 로 변경
- `app.include_router(nightly_study_router)` → `app.include_router(learning_agent_router)` 로 변경

- [ ] **Step 3: Docker 재시작 + import 확인**

```bash
docker compose restart backend && docker compose logs backend --tail=30
```

Expected: 에러 없이 서버 시작.

- [ ] **Step 4: 커밋**

```bash
git add backend/app/routers/learning_agent.py backend/app/main.py
git commit -m "feat: 학습 에이전트 라우터 — start/respond/end/status 엔드포인트"
```

---

## Task 6: 프론트엔드 API 클라이언트

**Files:**
- Create: `frontend/src/lib/learning-agent-api.ts`

- [ ] **Step 1: learning-agent-api.ts 작성**

`frontend/src/lib/learning-agent-api.ts`:

```typescript
import { createSSEFromPost } from "./agent-interview-api";

export interface LearningRespondParams {
  sessionId: string;
  answer: string;
  creditConfirmed?: boolean;
}

export function startLearningSession() {
  return createSSEFromPost("/api/nightly-study/start", {});
}

export function respondToLearning(params: LearningRespondParams) {
  return createSSEFromPost(
    `/api/nightly-study/${params.sessionId}/respond`,
    {
      answer: params.answer,
      credit_confirmed: params.creditConfirmed ?? false,
    }
  );
}

export function endLearningSession(sessionId: string) {
  return createSSEFromPost(`/api/nightly-study/${sessionId}/end`, {});
}

export async function getLearningStatus(): Promise<{ dailyLimitReached: boolean }> {
  const res = await fetch("/api/nightly-study/status", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch status");
  return res.json();
}
```

- [ ] **Step 2: `createSSEFromPost`가 export되는지 확인**

`frontend/src/lib/agent-interview-api.ts`에서 `createSSEFromPost`가 export되어 있는지 확인. 안 되어 있으면 `export` 추가.

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/lib/learning-agent-api.ts
git commit -m "feat: 학습 에이전트 프론트 API 클라이언트"
```

---

## Task 7: 프론트엔드 훅

**Files:**
- Create: `frontend/src/hooks/useLearningAgent.ts`

- [ ] **Step 1: useLearningAgent.ts 작성**

`frontend/src/hooks/useLearningAgent.ts`:

```typescript
import { useCallback, useRef, useState } from "react";

import {
  endLearningSession,
  respondToLearning,
  startLearningSession,
} from "@/lib/learning-agent-api";

export type LearningPhase =
  | "idle"
  | "connecting"
  | "tutor-speaking"
  | "user-speaking"
  | "processing"
  | "credit-confirm"
  | "completing"
  | "summary"
  | "error";

export interface LearningMessage {
  role: "tutor" | "user";
  content: string;
  phase?: string;
}

export interface LearningSummary {
  topicCovered?: string;
  keyPoints?: string[];
  strengths?: string[];
  weaknesses?: string[];
  nextTopicSuggestion?: string;
  encouragement?: string;
}

export function useLearningAgent() {
  const [phase, setPhase] = useState<LearningPhase>("idle");
  const [messages, setMessages] = useState<LearningMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isFreeSession, setIsFreeSession] = useState(false);
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<ReturnType<typeof startLearningSession> | null>(null);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const attachListeners = useCallback(
    (source: ReturnType<typeof startLearningSession>) => {
      source.addEventListener("session", (data: string) => {
        const parsed = JSON.parse(data);
        setSessionId(parsed.sessionId);
        setIsFreeSession(parsed.isFree ?? false);
      });

      source.addEventListener("status", (data: string) => {
        const parsed = JSON.parse(data);
        // status 이벤트는 내부 처리 단계 — phase를 직접 바꾸지 않음
        // processing 상태는 유지
        if (parsed.phase === "profile_loaded") {
          setPhase("processing");
        }
      });

      source.addEventListener("tutor", (data: string) => {
        const parsed = JSON.parse(data);
        setMessages((prev) => [
          ...prev,
          { role: "tutor", content: parsed.message, phase: parsed.phase },
        ]);
        setPhase("tutor-speaking");
      });

      source.addEventListener("credit_prompt", (data: string) => {
        const parsed = JSON.parse(data);
        setMessages((prev) => [
          ...prev,
          { role: "tutor", content: parsed.message, phase: "credit_prompt" },
        ]);
        setPhase("credit-confirm");
      });

      source.addEventListener("complete", (data: string) => {
        const parsed = JSON.parse(data);
        setSummary(parsed.summary || null);
        setPhase("summary");
        cleanup();
      });

      source.addEventListener("error", (data: string) => {
        try {
          const parsed = JSON.parse(data);
          setError(parsed.error || "오류가 발생했어요.");
        } catch {
          setError("오류가 발생했어요.");
        }
        setPhase("error");
        cleanup();
      });
    },
    [cleanup]
  );

  const start = useCallback(() => {
    cleanup();
    setPhase("connecting");
    setMessages([]);
    setSessionId(null);
    setSummary(null);
    setError(null);

    const source = startLearningSession();
    sourceRef.current = source;
    attachListeners(source);
  }, [cleanup, attachListeners]);

  const submitAnswer = useCallback(
    (answer: string, creditConfirmed = false) => {
      if (!sessionId) return;
      cleanup();

      setMessages((prev) => [...prev, { role: "user", content: answer }]);
      setPhase("processing");

      const source = respondToLearning({
        sessionId,
        answer,
        creditConfirmed,
      });
      sourceRef.current = source;
      attachListeners(source);
    },
    [sessionId, cleanup, attachListeners]
  );

  const confirmCredit = useCallback(() => {
    // 크레딧 확인 후 빈 응답으로 계속 진행
    if (!sessionId) return;
    cleanup();
    setPhase("processing");

    const source = respondToLearning({
      sessionId,
      answer: "계속할게요",
      creditConfirmed: true,
    });
    sourceRef.current = source;
    attachListeners(source);
  }, [sessionId, cleanup, attachListeners]);

  const declineCredit = useCallback(() => {
    // 크레딧 거절 → 세션 종료
    if (!sessionId) return;
    cleanup();
    setPhase("completing");

    const source = endLearningSession(sessionId);
    sourceRef.current = source;
    attachListeners(source);
  }, [sessionId, cleanup, attachListeners]);

  const endEarly = useCallback(() => {
    if (!sessionId) return;
    cleanup();
    setPhase("completing");

    const source = endLearningSession(sessionId);
    sourceRef.current = source;
    attachListeners(source);
  }, [sessionId, cleanup, attachListeners]);

  return {
    phase,
    messages,
    sessionId,
    isFreeSession,
    summary,
    error,
    start,
    submitAnswer,
    confirmCredit,
    declineCredit,
    endEarly,
    setPhase,
  };
}
```

- [ ] **Step 2: 커밋**

```bash
git add frontend/src/hooks/useLearningAgent.ts
git commit -m "feat: useLearningAgent 훅 — 학습 에이전트 상태 관리"
```

---

## Task 8: 프론트엔드 페이지

**Files:**
- Rewrite: `frontend/src/app/(authenticated)/nightly-study/page.tsx`
- Rewrite: `frontend/src/app/(authenticated)/nightly-study/session/page.tsx`

- [ ] **Step 1: 설정 페이지 재작성**

`frontend/src/app/(authenticated)/nightly-study/page.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Moon, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getLearningStatus } from "@/lib/learning-agent-api";
import { MicCheckDialog } from "@/components/interview/mic-check-dialog";
import { useState } from "react";

export default function NightlyStudyPage() {
  const router = useRouter();
  const [showMicCheck, setShowMicCheck] = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ["learning-status"],
    queryFn: getLearningStatus,
  });

  const handleStart = () => {
    setShowMicCheck(true);
  };

  const handleMicConfirm = () => {
    setShowMicCheck(false);
    router.push("/nightly-study/session");
  };

  return (
    <div className="container max-w-2xl mx-auto py-8 px-4">
      <div className="flex items-center gap-3 mb-8">
        <Moon className="h-8 w-8" />
        <div>
          <h1 className="text-2xl font-bold">오늘의 학습</h1>
          <p className="text-muted-foreground">
            AI 튜터와 음성으로 대화하며 깊이 있게 공부해요
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>학습 시작</CardTitle>
          <CardDescription>
            공부하고 싶은 주제를 AI 튜터에게 자유롭게 말해보세요.
            어떤 주제든 괜찮아요.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.dailyLimitReached ? (
            <div className="text-sm text-muted-foreground bg-muted p-4 rounded-lg">
              오늘의 무료 학습을 이미 완료했어요. 추가 학습은 크레딧이 필요해요.
            </div>
          ) : (
            <div className="text-sm text-muted-foreground bg-muted p-4 rounded-lg">
              매일 1회 무료로 학습할 수 있어요. 더 깊이 공부하고 싶으면 크레딧으로 이어갈 수 있어요.
            </div>
          )}

          <Button
            onClick={handleStart}
            disabled={isLoading}
            className="w-full"
            size="lg"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <ArrowRight className="h-4 w-4 mr-2" />
            )}
            {status?.dailyLimitReached ? "크레딧으로 학습 시작" : "무료 학습 시작"}
          </Button>
        </CardContent>
      </Card>

      <MicCheckDialog
        open={showMicCheck}
        onClose={() => setShowMicCheck(false)}
        onConfirm={handleMicConfirm}
      />
    </div>
  );
}
```

- [ ] **Step 2: 세션 페이지 재작성**

`frontend/src/app/(authenticated)/nightly-study/session/page.tsx`:

```tsx
"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Square, GraduationCap, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLearningAgent, LearningMessage } from "@/hooks/useLearningAgent";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { normalizeTranscript } from "@/lib/transcript";

export default function LearningSessionPage() {
  const router = useRouter();
  const agent = useLearningAgent();
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hadSpeechRef = useRef(false);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);
  const startedRef = useRef(false);

  // 세션 시작 (1회)
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      agent.start();
    }
  }, []);

  // 메시지 스크롤
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agent.messages]);

  // 튜터 발화 TTS 재생
  useEffect(() => {
    if (agent.phase === "tutor-speaking") {
      const lastMsg = agent.messages[agent.messages.length - 1];
      if (lastMsg?.role === "tutor") {
        tts.speak(lastMsg.content).then(() => {
          // TTS 완료 후 사용자 음성 입력 시작
          if (agent.phase === "tutor-speaking") {
            agent.setPhase("user-speaking");
            speech.resetTranscript();
            hadSpeechRef.current = false;
            speech.startListening();
          }
        });
      }
    }
  }, [agent.phase, agent.messages.length]);

  // 음성 입력 감지
  useEffect(() => {
    if (speech.transcript || speech.interimTranscript) {
      hadSpeechRef.current = true;
    }
  }, [speech.transcript, speech.interimTranscript]);

  // 침묵 3초 자동 제출
  useEffect(() => {
    if (agent.phase !== "user-speaking" || !hadSpeechRef.current) return;

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    if (speech.transcript && !speech.interimTranscript) {
      silenceTimerRef.current = setTimeout(() => {
        handleSubmit();
      }, 3000);
    }

    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, [speech.transcript, speech.interimTranscript, agent.phase]);

  // 비활성 3분 자동 종료
  useEffect(() => {
    if (agent.phase === "user-speaking" || agent.phase === "tutor-speaking") {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = setTimeout(() => {
        handleEndEarly();
      }, 180_000);
    }
    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [agent.phase, speech.transcript]);

  const handleSubmit = useCallback(() => {
    const text = normalizeTranscript(speech.transcript);
    if (!text) return;

    speech.stopListening();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    agent.submitAnswer(text);
  }, [speech.transcript, agent.submitAnswer]);

  const handleEndEarly = useCallback(() => {
    speech.stopListening();
    tts.stop();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    agent.endEarly();
  }, [agent.endEarly]);

  // 탭 닫기 방지
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (agent.phase !== "idle" && agent.phase !== "summary" && agent.phase !== "error") {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [agent.phase]);

  // --- 렌더링 ---

  if (agent.phase === "error") {
    return (
      <div className="container max-w-2xl mx-auto py-8 px-4 text-center">
        <p className="text-destructive mb-4">{agent.error}</p>
        <Button onClick={() => router.push("/nightly-study")}>돌아가기</Button>
      </div>
    );
  }

  if (agent.phase === "summary") {
    return (
      <div className="container max-w-2xl mx-auto py-8 px-4">
        <Card>
          <CardHeader>
            <CardTitle>학습 완료</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {agent.summary && (
              <>
                {agent.summary.topicCovered && (
                  <div>
                    <h3 className="font-semibold mb-1">다룬 주제</h3>
                    <p className="text-muted-foreground">{agent.summary.topicCovered}</p>
                  </div>
                )}
                {agent.summary.keyPoints && agent.summary.keyPoints.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-1">핵심 내용</h3>
                    <ul className="list-disc pl-5 text-sm space-y-1">
                      {agent.summary.keyPoints.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {agent.summary.strengths && agent.summary.strengths.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-1">잘 이해한 부분</h3>
                    <ul className="list-disc pl-5 text-sm space-y-1">
                      {agent.summary.strengths.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {agent.summary.weaknesses && agent.summary.weaknesses.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-1">보충이 필요한 부분</h3>
                    <ul className="list-disc pl-5 text-sm space-y-1">
                      {agent.summary.weaknesses.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {agent.summary.nextTopicSuggestion && (
                  <div>
                    <h3 className="font-semibold mb-1">다음 추천</h3>
                    <p className="text-muted-foreground">{agent.summary.nextTopicSuggestion}</p>
                  </div>
                )}
                {agent.summary.encouragement && (
                  <p className="text-sm italic text-muted-foreground mt-4">
                    {agent.summary.encouragement}
                  </p>
                )}
              </>
            )}
            <Button onClick={() => router.push("/nightly-study")} className="w-full mt-4">
              돌아가기
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] max-w-2xl mx-auto px-4 py-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5" />
          <span className="font-semibold">AI 튜터</span>
          {agent.isFreeSession && (
            <span className="text-xs bg-muted px-2 py-0.5 rounded">무료</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleEndEarly}
          disabled={agent.phase === "idle" || agent.phase === "connecting" || agent.phase === "completing"}
        >
          <Square className="h-4 w-4 mr-1" />
          그만하기
        </Button>
      </div>

      {/* 대화 영역 */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-4">
        {agent.messages.map((msg: LearningMessage, i: number) => (
          <div
            key={i}
            className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "tutor" && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                <GraduationCap className="h-4 w-4" />
              </div>
            )}
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : msg.phase === "credit_prompt"
                    ? "bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700"
                    : "bg-muted"
              }`}
            >
              {msg.content}
            </div>
            {msg.role === "user" && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <User className="h-4 w-4" />
              </div>
            )}
          </div>
        ))}

        {/* 실시간 음성 입력 표시 */}
        {agent.phase === "user-speaking" && (speech.transcript || speech.interimTranscript) && (
          <div className="flex gap-2 justify-end">
            <div className="max-w-[80%] rounded-lg px-4 py-2 text-sm bg-primary/60 text-primary-foreground">
              {speech.transcript}
              {speech.interimTranscript && (
                <span className="opacity-60">{speech.interimTranscript}</span>
              )}
            </div>
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <User className="h-4 w-4" />
            </div>
          </div>
        )}

        {/* 처리 중 표시 */}
        {(agent.phase === "processing" || agent.phase === "connecting" || agent.phase === "completing") && (
          <div className="flex gap-2 justify-start">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
              <GraduationCap className="h-4 w-4" />
            </div>
            <div className="bg-muted rounded-lg px-4 py-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
              생각하는 중...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 하단 컨트롤 */}
      <div className="flex-shrink-0">
        {agent.phase === "credit-confirm" && (
          <div className="flex gap-2">
            <Button onClick={agent.confirmCredit} className="flex-1">
              계속 학습하기 (크레딧 사용)
            </Button>
            <Button onClick={agent.declineCredit} variant="outline" className="flex-1">
              여기서 마치기
            </Button>
          </div>
        )}

        {agent.phase === "user-speaking" && (
          <div className="text-center">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground mb-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              듣고 있어요...
            </div>
            <Button variant="outline" size="sm" onClick={handleSubmit}>
              답변 완료
            </Button>
          </div>
        )}

        {agent.phase === "tutor-speaking" && (
          <div className="text-center text-sm text-muted-foreground">
            AI 튜터가 말하고 있어요...
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/app/\(authenticated\)/nightly-study/page.tsx frontend/src/app/\(authenticated\)/nightly-study/session/page.tsx
git commit -m "feat: 오늘의 학습 페이지 — 에이전트 기반 UI로 교체"
```

---

## Task 9: 기존 코드 정리

**Files:**
- Delete: `backend/app/routers/nightly_study.py`
- Delete: `backend/app/prompts/nightly_study.py`
- Delete: `backend/data/questions/` (7개 JSON)
- Delete: `frontend/src/hooks/useNightlyStudy.ts`
- Delete: `frontend/src/components/nightly-study/topic-selector.tsx`

- [ ] **Step 1: 백엔드 삭제 대상 파일 제거**

```bash
rm backend/app/routers/nightly_study.py
rm backend/app/prompts/nightly_study.py
rm -rf backend/data/questions/
```

- [ ] **Step 2: 프론트엔드 삭제 대상 파일 제거**

```bash
rm frontend/src/hooks/useNightlyStudy.ts
rm frontend/src/components/nightly-study/topic-selector.tsx
```

- [ ] **Step 3: 삭제된 파일 import 참조 확인 및 수정**

`backend/app/main.py`에서 `nightly_study` import가 제거되었는지 확인 (Task 5에서 이미 처리).

프론트엔드에서 `useNightlyStudy` 또는 `TopicSelector` import하는 파일이 있는지 grep으로 확인:

```bash
cd frontend && grep -r "useNightlyStudy\|topic-selector\|TopicSelector" src/ --include="*.ts" --include="*.tsx" -l
```

발견되면 해당 import 제거.

- [ ] **Step 4: 기존 nightly-study 컴포넌트 중 재사용 가능한 것 확인**

`frontend/src/components/nightly-study/` 디렉토리에서 `conversation-view.tsx`와 `study-summary-card.tsx`가 남아있는지 확인. 세션 페이지에서 직접 구현했으므로 더 이상 필요 없으면 삭제:

```bash
rm -rf frontend/src/components/nightly-study/
```

- [ ] **Step 5: Docker 재빌드 + 전체 확인**

```bash
docker compose up -d --build
docker compose logs backend --tail=30
docker compose logs frontend --tail=30
```

Expected: 양쪽 모두 에러 없이 시작.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "chore: 기존 Nightly Study 코드 정리 — 질문 뱅크, 라우터, 훅, 컴포넌트 제거"
```

---

## Task 10: 통합 테스트 및 마무리

**Files:**
- Possibly modify: `frontend/src/lib/agent-interview-api.ts` (createSSEFromPost export 확인)
- Possibly modify: `frontend/src/components/layout/sidebar.tsx` (세션 경로 숨김 확인)

- [ ] **Step 1: `createSSEFromPost` export 확인/수정**

`frontend/src/lib/agent-interview-api.ts`에서 `createSSEFromPost`가 named export인지 확인. 아니면 `export` 키워드 추가.

- [ ] **Step 2: 사이드바 세션 경로 숨김 확인**

`frontend/src/components/layout/sidebar.tsx`에서 `pathname === '/nightly-study/session'` 조건이 이미 있는지 확인. 있으면 변경 불필요.

- [ ] **Step 3: 프론트엔드 빌드 확인**

```bash
cd frontend && npm run build
```

Expected: 빌드 성공, TypeScript 에러 없음.

- [ ] **Step 4: 수동 E2E 테스트**

브라우저에서 `http://localhost:81/nightly-study` 접속:

1. "학습 시작" 버튼 클릭
2. 마이크 확인 다이얼로그 통과
3. 세션 페이지에서 AI 인사 확인 (TTS 재생)
4. "이벤트 루프 알려줘" 같은 주제를 음성으로 말함
5. AI 튜터가 설명을 시작하는지 확인
6. 2~3라운드 대화 후 크레딧 전환 안내가 나오는지 확인
7. "그만하기" 버튼으로 세션 종료, 요약 화면 확인

- [ ] **Step 5: 최종 커밋 (필요 시)**

```bash
git add -A
git commit -m "fix: 학습 에이전트 통합 테스트 후 수정사항"
```
