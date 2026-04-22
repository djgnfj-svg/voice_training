from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from app.agent.interview import graph
from app.agent.interview.state import InterviewState


def make_minimal_state(**overrides: Any) -> InterviewState:
    state: InterviewState = {
        "session_id": "harness-session",
        "user_id": "harness-user",
        "resume": {
            "summary": "Backend developer",
            "skills": ["Python", "FastAPI"],
            "projects": [{"name": "VoicePrep", "description": "Interview training service"}],
        },
        "job_posting": None,
        "user_profile": {},
        "current_question": "이 프로젝트에서 맡은 핵심 역할은 무엇인가요?",
        "current_answer": "FastAPI 기반 API와 면접 평가 흐름을 구현했습니다.",
        "question_count": 1,
        "max_questions": 3,
        "current_evaluation": {},
        "next_action": "",
        "conversation_history": [],
        "overall_report": None,
        "profile_context": [],
        "loop_count": 0,
        "actions_taken": [],
        "pending_events": [],
        "resume_id": "harness-resume",
        "fit_analysis": {"avoid_topics": []},
        "has_resume_embeddings": False,
        "current_resume_chunks": [],
        "phase": "scan",
        "scan_plan": [
            {
                "project_ref": "VoicePrep",
                "query": "VoicePrep FastAPI",
                "reason": "project_order",
            }
        ],
        "dive_plan": [],
        "scan_evaluations": [],
        "current_scan_idx": 0,
        "current_dive_idx": 0,
        "current_dive_depth": 0,
    }
    state.update(overrides)
    return state


@pytest.mark.asyncio
async def test_start_graph_runs_initial_interview_flow(monkeypatch):
    calls: list[str] = []

    async def load_profile(state, db):
        calls.append("load_profile")
        return {**state, "user_profile": {"context": ["ok"]}}

    async def fit_analysis(state, db):
        calls.append("fit_analysis")
        return {**state, "fit_analysis": {"avoid_topics": []}, "has_resume_embeddings": False}

    async def build_scan_plan(state, db):
        calls.append("build_scan_plan")
        return {**state, "scan_plan": state["scan_plan"], "phase": "scan"}

    async def scan_ask(state, db):
        calls.append("scan_ask")
        return {**state, "current_question": "첫 질문", "question_count": 1}

    monkeypatch.setattr(graph, "load_profile", load_profile)
    monkeypatch.setattr(graph, "fit_analysis", fit_analysis)
    monkeypatch.setattr(graph, "build_scan_plan", build_scan_plan)
    monkeypatch.setattr(graph, "scan_ask", scan_ask)

    out = await graph.run_start_graph(make_minimal_state(question_count=0), db=object())

    assert calls == ["load_profile", "fit_analysis", "build_scan_plan", "scan_ask"]
    assert out["current_question"] == "첫 질문"
    assert out["question_count"] == 1


@pytest.mark.asyncio
async def test_answer_graph_routes_scan_to_next_question(monkeypatch):
    calls: list[str] = []

    async def evaluate_answer(state, db):
        calls.append("evaluate")
        return {**state, "current_evaluation": {"overallScore": 80}}

    async def scan_next(state, db):
        calls.append("scan_next")
        return {**state, "next_action": "scan_ask", "current_scan_idx": 1}

    async def scan_ask(state, db):
        calls.append("scan_ask")
        return {**state, "current_question": "다음 질문", "question_count": 2}

    monkeypatch.setattr(graph, "evaluate_answer", evaluate_answer)
    monkeypatch.setattr(graph, "scan_next", scan_next)
    monkeypatch.setattr(graph, "scan_ask", scan_ask)

    out = await graph.run_answer_graph(make_minimal_state(), db=object())

    assert calls == ["evaluate", "scan_next", "scan_ask"]
    assert out["next_action"] == "scan_ask"
    assert out["current_question"] == "다음 질문"


@pytest.mark.asyncio
async def test_langchain_tools_can_be_called(monkeypatch):
    async def search_profile(db, user_id, query, top_k=5):
        return [{"user_id": user_id, "content": query, "top_k": top_k}]

    async def search_resume(db, user_id, resume_id, query, top_k=3):
        return [{"user_id": user_id, "resume_id": resume_id, "content": query, "top_k": top_k}]

    monkeypatch.setattr("app.agent.interview.graph.profile_memory.search_profile", search_profile)
    monkeypatch.setattr("app.agent.interview.graph.resume_memory.search_resume", search_resume)

    search_profile_tool, search_resume_tool = graph.make_interview_tools(object(), "user-1")

    profile_json = await search_profile_tool.ainvoke({"query": "FastAPI", "top_k": 2})
    resume_json = await search_resume_tool.ainvoke(
        {"resume_id": "resume-1", "query": "프로젝트", "top_k": 1}
    )

    assert '"content": "FastAPI"' in profile_json
    assert '"resume_id": "resume-1"' in resume_json


@pytest.mark.asyncio
async def test_langgraph_tool_node_executes_interview_tool(monkeypatch):
    async def search_profile(db, user_id, query, top_k=5):
        return [{"user_id": user_id, "content": query, "top_k": top_k}]

    monkeypatch.setattr("app.agent.interview.graph.profile_memory.search_profile", search_profile)

    state = {
        "messages": [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "call-1",
                        "name": "search_profile",
                        "args": {"query": "FastAPI", "top_k": 2},
                    }
                ],
            )
        ]
    }

    out = await graph.run_tool_calling_graph(state, db=object(), user_id="user-1")

    assert isinstance(out["messages"][-1], ToolMessage)
    assert '"content": "FastAPI"' in out["messages"][-1].content
