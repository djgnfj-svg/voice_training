from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Annotated, AsyncGenerator, Callable, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import tracing
from app.config import settings
from app.agent.learning_coach.learning_memory import search_learning_memory, insert_learning_memory
from app.agent.learning_coach.curriculum_seed import generate_and_insert_seed, normalize_goal
from app.agent.learning_coach.spaced_repetition import apply_proficiency_delta, compute_next_review
from app.agent.learning_coach.session_summary import generate_session_summary, update_streak_after_session
from app.prompts.learning_coach import AGENTIC_SYSTEM_PROMPT

logger = logging.getLogger(__name__)
KST = timezone(timedelta(hours=9))


class LearningGraphState(TypedDict, total=False):
    messages: Annotated[list[BaseMessage], add_messages]
    session_id: str
    user_id: str
    user_utterance: str
    persist_user: bool
    context: dict[str, Any]
    final_text: str
    tool_log: list[dict[str, Any]]
    langsmith_run_id: str | None


class InitProfileArgs(BaseModel):
    current_goal: str = Field(..., min_length=1, max_length=200)
    domain: str | None = Field(default=None, max_length=100)


class UpdateProfileArgs(BaseModel):
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    current_goal: str | None = Field(default=None, max_length=200)
    summary: str | None = Field(default=None, max_length=1000)


class PlanNextSessionArgs(BaseModel):
    session_intent: str = Field(default="review", max_length=80)
    focus: str | None = Field(default=None, max_length=200)
    reason: str | None = Field(default=None, max_length=500)


class SelectNodeArgs(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    rationale: str | None = Field(default=None, max_length=500)


class RetrieveMemoryArgs(BaseModel):
    query: str = Field(..., min_length=1, max_length=1000)
    top_k: int = Field(default=3, ge=1, le=8)
    category: str | None = Field(default=None)
    node_id: str | None = Field(default=None)


class UpdateMasteryArgs(BaseModel):
    node_id: str | None = None
    delta: int = Field(default=0, ge=-20, le=20)
    correct: bool = False
    mode: str = Field(default="quiz")


class SummarizeSessionArgs(BaseModel):
    summary: str = Field(..., min_length=1, max_length=2000)
    highlights: dict[str, Any] = Field(default_factory=dict)
    voice_briefing: str | None = Field(default=None, max_length=2000)


class DefaultToolCallingLLM:
    def __init__(self) -> None:
        self._client: AsyncOpenAI | None = None

    def _get_client(self) -> AsyncOpenAI:
        if self._client is None:
            if not settings.OPENAI_API_KEY:
                raise RuntimeError("OPENAI_API_KEY is not configured")
            self._client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        return self._client

    async def ainvoke(self, messages: list[BaseMessage], tools_schema: list[dict[str, Any]]) -> AIMessage:
        openai_messages = [_to_openai_message(m) for m in messages]
        response = await self._get_client().chat.completions.create(
            model=settings.AGENT_MODEL,
            messages=openai_messages,
            tools=tools_schema,
            tool_choice="auto",
            temperature=0.4,
            max_tokens=1200,
        )
        msg = response.choices[0].message
        tool_calls = []
        for call in msg.tool_calls or []:
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            tool_calls.append({"id": call.id, "name": call.function.name, "args": args})
        return AIMessage(content=msg.content or "", tool_calls=tool_calls)


def _to_openai_message(message: BaseMessage) -> dict[str, Any]:
    if isinstance(message, SystemMessage):
        return {"role": "system", "content": message.content}
    if isinstance(message, HumanMessage):
        return {"role": "user", "content": message.content}
    if isinstance(message, ToolMessage):
        return {"role": "tool", "tool_call_id": message.tool_call_id, "content": message.content}
    if isinstance(message, AIMessage):
        out: dict[str, Any] = {"role": "assistant", "content": message.content or ""}
        if message.tool_calls:
            out["tool_calls"] = [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": json.dumps(tc.get("args") or {})},
                }
                for tc in message.tool_calls
            ]
        return out
    return {"role": "user", "content": str(message.content)}


def _tool_schema(name: str, description: str, model: type[BaseModel]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": model.model_json_schema(),
        },
    }


def _default_tools_schema() -> list[dict[str, Any]]:
    return [
        _tool_schema("init_profile", "Create the learner profile and first goal.", InitProfileArgs),
        _tool_schema("update_learning_profile", "Update strengths, weaknesses, goal, and learner summary.", UpdateProfileArgs),
        _tool_schema("plan_next_session", "Choose the next study intent and target from profile, memory, and mastery.", PlanNextSessionArgs),
        _tool_schema("select_or_create_curriculum_node", "Select an existing node or create a topic node for this session.", SelectNodeArgs),
        _tool_schema("retrieve_learning_memory", "Retrieve prior learning memories from vector RAG.", RetrieveMemoryArgs),
        _tool_schema("update_mastery", "Record answer correctness and update spaced repetition mastery.", UpdateMasteryArgs),
        _tool_schema("summarize_session", "Persist an end-of-session summary.", SummarizeSessionArgs),
    ]


def _json_result(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


def _trace_meta(session_id: str | None, user_id: str, graph_name: str) -> dict[str, Any]:
    return {
        "feature": "learning_coach",
        "graph_name": graph_name,
        "session_id": session_id,
        "user_id": user_id,
        "phase": graph_name,
    }


def _kst_today() -> date:
    return datetime.now(KST).date()


async def _apply_mastery_update(
    db: AsyncSession,
    user_id: str,
    node_id: str,
    delta: int,
    correct: bool,
    mode: str,
) -> int:
    row = (await db.execute(
        text("""
            SELECT proficiency, success_count, failure_count, streak_count
            FROM node_mastery
            WHERE user_id=:u AND node_id=:n
        """),
        {"u": user_id, "n": node_id},
    )).one_or_none()

    now = datetime.now(timezone.utc)
    if row is None:
        new_prof = apply_proficiency_delta(0, delta)
        success = 1 if correct else 0
        failure = 0 if correct else 1
        streak = 1 if correct else 0
        await db.execute(
            text("""
                INSERT INTO node_mastery
                    (user_id, node_id, proficiency, success_count, failure_count,
                     streak_count, last_studied_at, next_review_at, last_mode)
                VALUES (:u, :n, :p, :s, :f, :sc, :ls, :nr, :lm)
            """),
            {
                "u": user_id,
                "n": node_id,
                "p": new_prof,
                "s": success,
                "f": failure,
                "sc": streak,
                "ls": now,
                "nr": compute_next_review(new_prof, now),
                "lm": mode,
            },
        )
    else:
        new_prof = apply_proficiency_delta(row.proficiency, delta)
        await db.execute(
            text("""
                UPDATE node_mastery
                SET proficiency=:p, success_count=:s, failure_count=:f,
                    streak_count=:sc, last_studied_at=:ls,
                    next_review_at=:nr, last_mode=:lm
                WHERE user_id=:u AND node_id=:n
            """),
            {
                "p": new_prof,
                "s": row.success_count + (1 if correct else 0),
                "f": row.failure_count + (0 if correct else 1),
                "sc": (row.streak_count + 1) if correct else 0,
                "ls": now,
                "nr": compute_next_review(new_prof, now),
                "lm": mode,
                "u": user_id,
                "n": node_id,
            },
        )
    await db.commit()
    return new_prof


def _make_tools(db: AsyncSession, session_id: str, user_id: str):
    @tool("init_profile", args_schema=InitProfileArgs)
    async def init_profile(current_goal: str, domain: str | None = None) -> str:
        """Create the learner profile and first active learning goal."""
        goal_row = (await db.execute(
            text("SELECT id FROM learning_goals WHERE user_id=:u AND status='active' LIMIT 1"),
            {"u": user_id},
        )).one_or_none()
        if goal_row is None:
            result = await db.execute(
                text("""
                    INSERT INTO learning_goals (user_id, title, normalized_goal, status)
                    VALUES (:u, :t, :n, 'active')
                    RETURNING id
                """),
                {"u": user_id, "t": current_goal, "n": normalize_goal(current_goal)},
            )
            goal_id = str(result.one().id)
            await generate_and_insert_seed(db, goal_id, current_goal, commit=False)
        else:
            goal_id = str(goal_row.id)

        await db.execute(
            text("""
                INSERT INTO learning_user_profiles (user_id, current_goal, domain, strengths, weaknesses, preferences, summary)
                VALUES (:u, :g, :d, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, NULL)
                ON CONFLICT (user_id) DO UPDATE SET
                    current_goal=:g, domain=:d, updated_at=NOW()
            """),
            {"u": user_id, "g": current_goal, "d": domain},
        )
        await db.execute(text("UPDATE learning_sessions SET goal_id=:g WHERE id=:s"), {"g": goal_id, "s": session_id})
        await db.commit()
        return _json_result({"profile_created": True, "goal_id": goal_id, "current_goal": current_goal})

    @tool("update_learning_profile", args_schema=UpdateProfileArgs)
    async def update_learning_profile(
        strengths: list[str] | None = None,
        weaknesses: list[str] | None = None,
        current_goal: str | None = None,
        summary: str | None = None,
    ) -> str:
        """Update profile facts accumulated during a session."""
        await db.execute(
            text("""
                INSERT INTO learning_user_profiles (user_id, current_goal, strengths, weaknesses, preferences, summary)
                VALUES (:u, :g, CAST(:st AS jsonb), CAST(:wk AS jsonb), '{}'::jsonb, :sum)
                ON CONFLICT (user_id) DO UPDATE SET
                    current_goal=COALESCE(:g, learning_user_profiles.current_goal),
                    strengths=CAST(:st AS jsonb),
                    weaknesses=CAST(:wk AS jsonb),
                    summary=COALESCE(:sum, learning_user_profiles.summary),
                    updated_at=NOW()
            """),
            {
                "u": user_id,
                "g": current_goal,
                "st": json.dumps(strengths or [], ensure_ascii=False),
                "wk": json.dumps(weaknesses or [], ensure_ascii=False),
                "sum": summary,
            },
        )
        await db.commit()
        return _json_result({"profile_updated": True})

    @tool("plan_next_session", args_schema=PlanNextSessionArgs)
    async def plan_next_session(
        session_intent: str = "review",
        focus: str | None = None,
        reason: str | None = None,
    ) -> str:
        """Persist and return a conservative next-session plan."""
        ctx = await _load_context(db, session_id, user_id)
        node = await _pick_target_node(db, user_id, ctx.get("goal_id"), focus)
        await db.execute(
            text("""
                UPDATE learning_sessions
                SET session_intent=:i, target_node_id=:n
                WHERE id=:s
            """),
            {"i": session_intent, "n": node["id"] if node else None, "s": session_id},
        )
        await db.commit()
        return _json_result({"session_intent": session_intent, "target_node": node, "reason": reason})

    @tool("select_or_create_curriculum_node", args_schema=SelectNodeArgs)
    async def select_or_create_curriculum_node(
        title: str,
        description: str | None = None,
        rationale: str | None = None,
    ) -> str:
        """Select an existing curriculum node or create a new one."""
        ctx = await _load_context(db, session_id, user_id)
        goal_id = ctx.get("goal_id")
        if not goal_id:
            return _json_result({"error": "no_active_goal"})
        existing = (await db.execute(
            text("""
                SELECT id, title, description, depth_level FROM curriculum_nodes
                WHERE goal_id=:g AND lower(title)=lower(:t)
                LIMIT 1
            """),
            {"g": goal_id, "t": title},
        )).one_or_none()
        if existing:
            node = {
                "id": str(existing.id),
                "title": existing.title,
                "description": existing.description,
                "depth_level": existing.depth_level,
            }
        else:
            result = await db.execute(
                text("""
                    INSERT INTO curriculum_nodes (goal_id, title, description, depth_level, source, keywords)
                    VALUES (:g, :t, :d, 1, 'extended', :k)
                    RETURNING id
                """),
                {
                    "g": goal_id,
                    "t": title,
                    "d": description or rationale or title,
                    "k": [title.lower()],
                },
            )
            node = {"id": str(result.one().id), "title": title, "description": description or title, "depth_level": 1}
        await db.execute(text("UPDATE learning_sessions SET target_node_id=:n WHERE id=:s"), {"n": node["id"], "s": session_id})
        await db.commit()
        return _json_result({"target_node": node})

    @tool("retrieve_learning_memory", args_schema=RetrieveMemoryArgs)
    async def retrieve_learning_memory(
        query: str,
        top_k: int = 3,
        category: str | None = None,
        node_id: str | None = None,
    ) -> str:
        """Search learning_embeddings and return prior relevant memories."""
        hits = await search_learning_memory(db, user_id, query, top_k=top_k, category=category, node_id=node_id)
        return _json_result({"query": query, "hit_count": len(hits), "hits": hits})

    @tool("update_mastery", args_schema=UpdateMasteryArgs)
    async def update_mastery(
        node_id: str | None = None,
        delta: int = 0,
        correct: bool = False,
        mode: str = "quiz",
    ) -> str:
        """Update node mastery after an answer or due review."""
        ctx = await _load_context(db, session_id, user_id)
        target_node_id = node_id or ctx.get("target_node_id")
        if not target_node_id:
            return _json_result({"error": "no_target_node"})
        proficiency = await _apply_mastery_update(db, user_id, target_node_id, delta, correct, mode)
        return _json_result({"node_id": target_node_id, "proficiency": proficiency})

    @tool("summarize_session", args_schema=SummarizeSessionArgs)
    async def summarize_session(summary: str, highlights: dict[str, Any] | None = None, voice_briefing: str | None = None) -> str:
        """Persist the session summary and a searchable memory."""
        await db.execute(
            text("""
                UPDATE learning_sessions
                SET summary=:sum, highlights=CAST(:h AS jsonb), voice_briefing=:vb
                WHERE id=:s
            """),
            {
                "s": session_id,
                "sum": summary,
                "h": json.dumps(highlights or {}, ensure_ascii=False),
                "vb": voice_briefing,
            },
        )
        await db.commit()
        await insert_learning_memory(db, user_id, "explanation", summary, metadata={"session_id": session_id})
        return _json_result({"summarized": True})

    return [
        init_profile,
        update_learning_profile,
        plan_next_session,
        select_or_create_curriculum_node,
        retrieve_learning_memory,
        update_mastery,
        summarize_session,
    ]


async def _load_context(db: AsyncSession, session_id: str, user_id: str) -> dict[str, Any]:
    session_row = (await db.execute(
        text("""
            SELECT ls.goal_id, ls.turn_count, ls.session_intent, ls.target_node_id, lg.title AS goal_title
            FROM learning_sessions ls
            LEFT JOIN learning_goals lg ON lg.id = ls.goal_id
            WHERE ls.id=:s AND ls.user_id=:u
        """),
        {"s": session_id, "u": user_id},
    )).one_or_none()
    profile_row = (await db.execute(
        text("SELECT current_goal, domain, strengths, weaknesses, summary FROM learning_user_profiles WHERE user_id=:u"),
        {"u": user_id},
    )).one_or_none()
    recent_rows = (await db.execute(
        text("""
            SELECT summary, highlights FROM learning_sessions
            WHERE user_id=:u AND status='completed' AND summary IS NOT NULL
            ORDER BY started_at DESC LIMIT 3
        """),
        {"u": user_id},
    )).fetchall()
    weakness_rows = (await db.execute(
        text("""
            SELECT cn.id, cn.title, nm.proficiency, nm.next_review_at
            FROM node_mastery nm
            JOIN curriculum_nodes cn ON cn.id = nm.node_id
            WHERE nm.user_id=:u
            ORDER BY
                CASE WHEN nm.next_review_at IS NOT NULL AND nm.next_review_at <= NOW() THEN 0 ELSE 1 END,
                nm.proficiency ASC,
                nm.last_studied_at DESC NULLS LAST
            LIMIT 5
        """),
        {"u": user_id},
    )).fetchall()
    target_node = None
    if session_row and session_row.target_node_id:
        node_row = (await db.execute(
            text("SELECT id, title, description FROM curriculum_nodes WHERE id=:n"),
            {"n": str(session_row.target_node_id)},
        )).one_or_none()
        if node_row:
            target_node = {"id": str(node_row.id), "title": node_row.title, "description": node_row.description}

    return {
        "goal_id": str(session_row.goal_id) if session_row and session_row.goal_id else None,
        "goal_title": session_row.goal_title if session_row else None,
        "turn_count": session_row.turn_count if session_row else 0,
        "session_intent": session_row.session_intent if session_row else None,
        "target_node_id": str(session_row.target_node_id) if session_row and session_row.target_node_id else None,
        "target_node": target_node,
        "profile": dict(profile_row._mapping) if profile_row else None,
        "recent_summaries": [dict(r._mapping) for r in recent_rows],
        "weak_nodes": [dict(r._mapping) | {"id": str(r.id)} for r in weakness_rows],
    }


async def _pick_target_node(db: AsyncSession, user_id: str, goal_id: str | None, focus: str | None) -> dict[str, Any] | None:
    if not goal_id:
        return None
    if focus:
        row = (await db.execute(
            text("""
                SELECT id, title, description, depth_level FROM curriculum_nodes
                WHERE goal_id=:g AND (title ILIKE :q OR :q = ANY(keywords))
                ORDER BY depth_level ASC LIMIT 1
            """),
            {"g": goal_id, "q": f"%{focus}%"},
        )).one_or_none()
        if row:
            return {"id": str(row.id), "title": row.title, "description": row.description, "depth_level": row.depth_level}
    row = (await db.execute(
        text("""
            SELECT cn.id, cn.title, cn.description, cn.depth_level
            FROM curriculum_nodes cn
            LEFT JOIN node_mastery nm ON nm.node_id = cn.id AND nm.user_id=:u
            WHERE cn.goal_id=:g
            ORDER BY
                CASE WHEN nm.next_review_at IS NOT NULL AND nm.next_review_at <= NOW() THEN 0 ELSE 1 END,
                nm.proficiency ASC NULLS FIRST,
                cn.depth_level ASC
            LIMIT 1
        """),
        {"u": user_id, "g": goal_id},
    )).one_or_none()
    if not row:
        return None
    return {"id": str(row.id), "title": row.title, "description": row.description, "depth_level": row.depth_level}


async def pick_start_node(db: AsyncSession, user_id: str, goal_id: str | None) -> dict[str, Any] | None:
    if not goal_id:
        return None
    row = (await db.execute(
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
        {"u": user_id, "g": goal_id},
    )).one_or_none()
    if not row:
        return None
    return {"id": str(row.id), "title": row.title, "description": row.description}


async def store_session_insights(db: AsyncSession, session_id: str, user_id: str) -> None:
    rows = (await db.execute(
        text("""
            SELECT content, node_id FROM learning_messages
            WHERE session_id=:s AND role='assistant'
            ORDER BY message_index DESC LIMIT 2
        """),
        {"s": session_id},
    )).fetchall()
    for row in rows:
        if row.content:
            await insert_learning_memory(
                db,
                user_id=user_id,
                category="connection",
                content=row.content[:1000],
                node_id=str(row.node_id) if row.node_id else None,
                metadata={"session_id": session_id},
            )


def build_learning_graph(db: AsyncSession, llm: Any | None = None):
    llm = llm or DefaultToolCallingLLM()
    tools_schema = _default_tools_schema()

    async def load_context(state: LearningGraphState) -> dict[str, Any]:
        ctx = await _load_context(db, state["session_id"], state["user_id"])
        system = AGENTIC_SYSTEM_PROMPT + "\n\nContext JSON:\n" + json.dumps(ctx, ensure_ascii=False, default=str)
        messages: list[BaseMessage] = [SystemMessage(content=system)]
        if state.get("user_utterance"):
            messages.append(HumanMessage(content=state["user_utterance"]))
        return {"context": ctx, "messages": messages}

    async def agent(state: LearningGraphState) -> dict[str, Any]:
        if hasattr(llm, "ainvoke"):
            try:
                ai = await llm.ainvoke(state["messages"], tools_schema=tools_schema)
            except TypeError:
                ai = await llm.ainvoke(state["messages"])
        else:
            ai = await DefaultToolCallingLLM().ainvoke(state["messages"], tools_schema)
        return {"messages": [ai], "final_text": ai.content if isinstance(ai.content, str) else ""}

    def route_after_agent(state: LearningGraphState) -> str:
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return "persist"

    async def persist(state: LearningGraphState) -> dict[str, Any]:
        return await _persist_graph_turn(db, state)

    builder = StateGraph(LearningGraphState)
    builder.add_node("load_context", load_context)
    builder.add_node("agent", agent)
    builder.add_node("tools", _DynamicToolNode(db))
    builder.add_node("persist", persist)
    builder.set_entry_point("load_context")
    builder.add_edge("load_context", "agent")
    builder.add_conditional_edges("agent", route_after_agent, {"tools": "tools", "persist": "persist"})
    builder.add_edge("tools", "agent")
    builder.add_edge("persist", END)
    return builder.compile()


class _DynamicToolNode:
    """ToolNode wrapper that binds db/session/user from each graph state."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def __call__(self, state: LearningGraphState) -> dict[str, Any]:
        node = ToolNode(_make_tools(self._db, state["session_id"], state["user_id"]))
        return await node.ainvoke(state)


async def _persist_graph_turn(db: AsyncSession, state: LearningGraphState) -> dict[str, Any]:
    session_id = state["session_id"]
    user_utterance = state.get("user_utterance") or ""
    final_text = (state.get("final_text") or "").strip() or "좋아요. 계속 이어가 볼게요."
    last_idx = (await db.execute(
        text("SELECT COALESCE(MAX(message_index), -1) AS idx FROM learning_messages WHERE session_id=:s"),
        {"s": session_id},
    )).one().idx
    next_idx = last_idx + 1
    if state.get("persist_user", True) and user_utterance:
        await db.execute(
            text("""
                INSERT INTO learning_messages (session_id, message_index, role, content)
                VALUES (:s, :i, 'user', :c)
            """),
            {"s": session_id, "i": next_idx, "c": user_utterance},
        )
        next_idx += 1

    tool_log = _extract_tool_log(state.get("messages", []))
    context = await _load_context(db, session_id, state["user_id"])
    node_id = context.get("target_node_id")
    await db.execute(
        text("""
            INSERT INTO learning_messages (session_id, message_index, role, content, mode, tool_calls, node_id)
            VALUES (:s, :i, 'assistant', :c, :m, CAST(:t AS jsonb), :n)
        """),
        {
            "s": session_id,
            "i": next_idx,
            "c": final_text,
            "m": "agentic",
            "t": json.dumps({"tool_log": tool_log}, ensure_ascii=False),
            "n": node_id,
        },
    )
    await db.execute(
        text("""
            UPDATE learning_sessions
            SET turn_count=turn_count + :inc,
                graph_state=CAST(:gs AS jsonb)
            WHERE id=:s
        """),
        {
            "s": session_id,
            "inc": 1 if state.get("persist_user", True) else 0,
            "gs": json.dumps({"last_tools": tool_log}, ensure_ascii=False),
        },
    )
    await db.commit()
    return {"final_text": final_text, "tool_log": tool_log}


def _extract_tool_log(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls or []:
                out.append({"type": "call", "name": call.get("name"), "args": call.get("args") or {}})
        elif isinstance(message, ToolMessage):
            out.append({"type": "result", "name": message.name, "content": message.content})
    return out


async def run_agent_turn(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    user_utterance: str,
    *,
    persist_user: bool = True,
    llm: Any | None = None,
) -> dict[str, Any]:
    graph = build_learning_graph(db, llm=llm)
    state = {
        "session_id": session_id,
        "user_id": user_id,
        "user_utterance": user_utterance,
        "persist_user": persist_user,
        "messages": [],
    }
    result, run_id = await tracing.traced_graph_call(
        name="learning_coach.turn",
        metadata=_trace_meta(session_id, user_id, "turn"),
        call=lambda: graph.ainvoke(state),
    )
    if run_id:
        result["langsmith_run_id"] = run_id
        await db.execute(
            text("UPDATE learning_sessions SET langsmith_run_id=:rid WHERE id=:s"),
            {"rid": run_id, "s": session_id},
        )
        await db.commit()
    return result


async def run_start_graph(db: AsyncSession, user_id: str) -> dict[str, Any]:
    async def _start() -> dict[str, Any]:
        await db.execute(text("SELECT id FROM users WHERE id=:u FOR UPDATE"), {"u": user_id})
        await db.execute(
            text("UPDATE learning_sessions SET status='completed', ended_at=NOW() WHERE user_id=:u AND status='active'"),
            {"u": user_id},
        )
        await db.commit()

        goal_row = (await db.execute(
            text("SELECT id, title FROM learning_goals WHERE user_id=:u AND status='active'"),
            {"u": user_id},
        )).one_or_none()
        goal_id = str(goal_row.id) if goal_row else None
        initial_mode = "learning" if goal_id else "onboarding"
        target_node = await pick_start_node(db, user_id, goal_id) if goal_id else None

        row = (await db.execute(
            text("""
                INSERT INTO learning_sessions
                    (user_id, goal_id, is_free_session, status, target_node_id)
                VALUES (:u, :g, TRUE, 'active', :n)
                RETURNING id
            """),
            {"u": user_id, "g": goal_id, "n": target_node["id"] if target_node else None},
        )).one()
        session_id = str(row.id)
        await db.commit()

        try:
            result = await run_agent_turn(
                db=db,
                session_id=session_id,
                user_id=user_id,
                user_utterance="세션 시작",
                persist_user=False,
            )
            first_text = result.get("final_text") or ""
        except Exception:
            logger.exception("agentic start failed")
            await db.rollback()
            if initial_mode == "onboarding":
                first_text = "안녕하세요. 먼저 학습 목표와 현재 준비 중인 분야를 짧게 말해 주세요."
            elif target_node:
                first_text = f"다시 이어가 볼게요. 오늘은 '{target_node['title']}'부터 볼까요?"
            else:
                first_text = "오늘 학습을 시작해 볼까요?"
            await db.execute(
                text("""
                    INSERT INTO learning_messages (session_id, message_index, role, content, mode, node_id)
                    VALUES (:s, 0, 'assistant', :c, :m, :n)
                """),
                {"s": session_id, "c": first_text, "m": initial_mode, "n": target_node["id"] if target_node else None},
            )
            await db.commit()

        return {
            "sessionId": session_id,
            "initialMode": initial_mode,
            "targetNode": target_node,
            "firstMessage": first_text,
        }

    result, run_id = await tracing.traced_graph_call(
        name="learning_coach.start",
        metadata=_trace_meta(None, user_id, "start"),
        call=_start,
    )
    if run_id:
        await db.execute(
            text("UPDATE learning_sessions SET langsmith_run_id=:rid WHERE id=:s"),
            {"rid": run_id, "s": result["sessionId"]},
        )
        await db.commit()
        result["langsmithRunId"] = run_id
    return result


async def run_end_graph(db: AsyncSession, session_id: str, user_id: str) -> dict[str, Any]:
    async def _end() -> dict[str, Any]:
        summary_data = await generate_session_summary(db, session_id)
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
        await db.commit()
        streak_state = await update_streak_after_session(db, user_id, _kst_today())
        await store_session_insights(db, session_id, user_id)
        return {
            "summary": summary_data["summary"],
            "highlights": summary_data["highlights"],
            "voiceBriefing": summary_data["voice_briefing"],
            "streakUpdated": streak_state,
        }

    result, run_id = await tracing.traced_graph_call(
        name="learning_coach.end",
        metadata=_trace_meta(session_id, user_id, "end"),
        call=_end,
    )
    if run_id:
        await db.execute(
            text("UPDATE learning_sessions SET langsmith_run_id=:rid WHERE id=:s"),
            {"rid": run_id, "s": session_id},
        )
        await db.commit()
        result["langsmithRunId"] = run_id
    return result


async def stream_agent_turn(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    user_utterance: str,
    *,
    persist_user: bool = True,
) -> AsyncGenerator[dict[str, Any], None]:
    yield {"type": "phase", "data": {"phase": "thinking", "label": "생각하는 중"}}
    result = await run_agent_turn(db, session_id, user_id, user_utterance, persist_user=persist_user)
    yield {"type": "text", "data": result.get("final_text") or ""}
    yield {
        "type": "meta",
        "data": {
            "mode": "agentic",
            "tools": [x for x in result.get("tool_log", []) if x.get("type") == "call"],
        },
    }
    yield {"type": "end", "data": {}}
