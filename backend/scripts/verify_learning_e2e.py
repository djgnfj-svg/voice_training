from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from langchain_core.messages import AIMessage

import app.agent.nightly_study.ns_graph as ns_graph


@dataclass
class Row:
    id: Any = None
    goal_id: Any = None
    goal_title: str | None = None
    turn_count: int = 0
    session_intent: str | None = None
    target_node_id: Any = None
    current_goal: str | None = None
    domain: str | None = None
    strengths: list[str] | None = None
    weaknesses: list[str] | None = None
    summary: str | None = None
    highlights: dict | None = None
    title: str | None = None
    description: str | None = None
    depth_level: int = 0
    proficiency: int = 0
    next_review_at: Any = None
    idx: int = -1

    @property
    def _mapping(self) -> dict[str, Any]:
        return self.__dict__


class Result:
    def __init__(self, rows: list[Row] | None = None) -> None:
        self.rows = rows or []

    def one_or_none(self):
        return self.rows[0] if self.rows else None

    def one(self):
        if not self.rows:
            raise AssertionError("expected one row")
        return self.rows[0]

    def fetchall(self):
        return self.rows


class FakeDB:
    def __init__(self, *, has_profile: bool, has_goal: bool = True, target_node_id: str | None = None) -> None:
        self.has_profile = has_profile
        self.has_goal = has_goal
        self.goal_id = UUID("00000000-0000-0000-0000-000000000001") if has_goal else None
        self.node_id = UUID(target_node_id or "00000000-0000-0000-0000-000000000002")
        self.exec_log: list[tuple[str, dict]] = []
        self.commits = 0

    async def execute(self, stmt, params: dict | None = None):
        sql = str(stmt).lower()
        params = params or {}
        self.exec_log.append((sql, params))
        if "select ls.goal_id" in sql:
            return Result([Row(goal_id=self.goal_id, goal_title="Backend CS", turn_count=1, target_node_id=self.node_id)])
        if "select current_goal" in sql:
            if not self.has_profile:
                return Result()
            return Result([Row(current_goal="Backend CS", domain="backend", strengths=["HTTP"], weaknesses=["DB"], summary="previous")])
        if "from learning_sessions" in sql and "status='completed'" in sql:
            return Result([Row(summary="DB index 蹂듭뒿 ?꾩슂", highlights={"headline": "index"})])
        if "from node_mastery" in sql and "join curriculum_nodes" in sql:
            return Result([Row(id=self.node_id, title="DB Index", proficiency=25)])
        if "select id from learning_goals" in sql:
            return Result([Row(id=self.goal_id)]) if self.has_goal else Result()
        if "insert into learning_goals" in sql:
            self.goal_id = UUID("00000000-0000-0000-0000-000000000001")
            self.has_goal = True
            return Result([Row(id=self.goal_id)])
        if "select id, title, description, depth_level from curriculum_nodes" in sql:
            return Result([Row(id=self.node_id, title=params.get("t") or "DB Index", description="index basics", depth_level=1)])
        if "select cn.id" in sql and "from curriculum_nodes" in sql:
            return Result([Row(id=self.node_id, title="DB Index", description="index basics", depth_level=1)])
        if "coalesce(max(message_index)" in sql:
            return Result([Row(idx=-1)])
        if "returning id" in sql:
            return Result([Row(id=self.node_id)])
        return Result()

    async def commit(self):
        self.commits += 1


class MockLLM:
    def __init__(self, messages: list[AIMessage]) -> None:
        self.messages = messages
        self.calls = 0

    async def ainvoke(self, _messages, tools_schema=None):
        if self.calls >= len(self.messages):
            raise AssertionError("mock LLM exhausted")
        msg = self.messages[self.calls]
        self.calls += 1
        return msg


def tool_msg(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"id": call_id, "name": name, "args": args}])


async def run_case(name: str, db: FakeDB, llm: MockLLM):
    out = await ns_graph.run_agent_turn(
        db=db,
        session_id="00000000-0000-0000-0000-000000000100",
        user_id="user-1",
        user_utterance="?뚯뒪???낅젰",
        llm=llm,
    )
    calls = [x["name"] for x in out["tool_log"] if x.get("type") == "call"]
    print(f"{name}: {calls}")
    return out, calls


async def main() -> None:
    rag_queries: list[dict] = []
    mastery_updates: list[dict] = []

    async def fake_seed(*args, **kwargs):
        return 3

    async def fake_search(db, user_id, query, top_k=3, category=None, node_id=None):
        rag_queries.append({"query": query, "top_k": top_k, "category": category, "node_id": node_id})
        return [{"id": "mem-1", "category": "misconception", "content": "?몃뜳???좏깮???쏀븿", "similarity": 0.91}]

    async def fake_mastery(db, user_id, node_id, delta, correct, mode):
        mastery_updates.append({"node_id": node_id, "delta": delta, "correct": correct, "mode": mode})
        return 42

    async def fake_insert_memory(*args, **kwargs):
        return "mem-new"

    ns_graph.generate_and_insert_seed = fake_seed
    ns_graph.search_learning_memory = fake_search
    ns_graph.tool_evaluate_answer = fake_mastery
    ns_graph.insert_learning_memory = fake_insert_memory

    out, calls = await run_case(
        "profile init",
        FakeDB(has_profile=False, has_goal=False),
        MockLLM([
            tool_msg("init_profile", {"current_goal": "Backend CS", "domain": "backend"}, "c1"),
            tool_msg("update_learning_profile", {"weaknesses": ["DB"], "strengths": ["HTTP"], "summary": "init"}, "c2"),
            AIMessage(content="紐⑺몴瑜??≪븯?댁슂. DB 湲곗큹遺???쒖옉??蹂쇨쾶??"),
        ]),
    )
    assert calls == ["init_profile", "update_learning_profile"]
    assert "紐⑺몴" in out["final_text"]

    out, calls = await run_case(
        "second session rag",
        FakeDB(has_profile=True),
        MockLLM([
            tool_msg("retrieve_learning_memory", {"query": "DB index ?쎌젏", "top_k": 3}, "c1"),
            tool_msg("plan_next_session", {"session_intent": "weakness_reinforcement", "focus": "DB Index"}, "c2"),
            AIMessage(content="吏???쎌젏??DB ?몃뜳?ㅻ? ?댁뼱??蹂쇨쾶??"),
        ]),
    )
    assert calls == ["retrieve_learning_memory", "plan_next_session"]
    assert rag_queries[-1]["query"] == "DB index ?쎌젏"
    assert any(x.get("type") == "result" and "hit_count" in x.get("content", "") for x in out["tool_log"])

    _, calls = await run_case(
        "weakness node",
        FakeDB(has_profile=True),
        MockLLM([
            tool_msg("plan_next_session", {"session_intent": "weakness_reinforcement", "focus": "DB Index"}, "c1"),
            tool_msg("select_or_create_curriculum_node", {"title": "DB Index", "description": "index basics"}, "c2"),
            AIMessage(content="DB Index ?몃뱶濡?吏꾪뻾?좉쾶??"),
        ]),
    )
    assert calls == ["plan_next_session", "select_or_create_curriculum_node"]

    _, calls = await run_case(
        "due review mastery",
        FakeDB(has_profile=True),
        MockLLM([
            tool_msg("retrieve_learning_memory", {"query": "due review DB Index"}, "c1"),
            tool_msg("update_mastery", {"node_id": "00000000-0000-0000-0000-000000000002", "delta": 5, "correct": True, "mode": "review"}, "c2"),
            AIMessage(content="蹂듭뒿 寃곌낵瑜?諛섏쁺?덉뼱??"),
        ]),
    )
    assert calls == ["retrieve_learning_memory", "update_mastery"]
    assert mastery_updates[-1]["delta"] == 5

    print("learning e2e ok")


if __name__ == "__main__":
    asyncio.run(main())
