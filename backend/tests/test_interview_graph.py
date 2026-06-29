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
            "projects": [
                {"name": "VoicePrep", "description": "Interview training service"}
            ],
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
        "rubric_plan": [
            {
                "id": "r1",
                "label": "FastAPI API 설계",
                "jd_requirement": "FastAPI 기반 API",
                "importance": "must",
                "has_evidence": True,
                "evidence_refs": ["FastAPI"],
                "query": "FastAPI API 설계",
            }
        ],
        "coverage": [
            {
                "id": "r1",
                "label": "FastAPI API 설계",
                "importance": "must",
                "has_evidence": True,
                "status": "pending",
                "depth_score": None,
            }
        ],
        "current_rubric_idx": 0,
        "current_item_depth": 1,
    }
    state.update(overrides)
    return state


@pytest.mark.asyncio
async def test_fit_analysis_node_uses_module(monkeypatch):
    async def run_fit_analysis(resume, jd):
        return {"skill_match": None, "avoid_topics": ["legacy"]}

    async def has_resume_embeddings(db, resume_id):
        return True

    monkeypatch.setattr(graph.fit_analysis_module, "run_fit_analysis", run_fit_analysis)
    monkeypatch.setattr(
        graph.resume_memory, "has_resume_embeddings", has_resume_embeddings
    )

    out = await graph.fit_analysis(
        make_minimal_state(resume_id="resume-1"), db=object()
    )

    assert out["fit_analysis"] == {"skill_match": None, "avoid_topics": ["legacy"]}
    assert out["has_resume_embeddings"] is True


@pytest.mark.asyncio
async def test_start_graph_runs_initial_interview_flow(monkeypatch):
    calls: list[str] = []

    async def load_profile(state, db):
        calls.append("load_profile")
        return {**state, "user_profile": {"context": ["ok"]}}

    async def fit_analysis(state, db):
        calls.append("fit_analysis")
        return {
            **state,
            "fit_analysis": {"avoid_topics": []},
            "has_resume_embeddings": False,
        }

    async def build_rubric_plan(state, db):
        calls.append("build_rubric_plan")
        return {**state, "rubric_plan": state["rubric_plan"]}

    async def rubric_ask(state, db):
        calls.append("rubric_ask")
        return {**state, "current_question": "첫 질문", "question_count": 1}

    monkeypatch.setattr(graph, "load_profile", load_profile)
    monkeypatch.setattr(graph, "fit_analysis", fit_analysis)
    monkeypatch.setattr(graph, "build_rubric_plan", build_rubric_plan)
    monkeypatch.setattr(graph, "rubric_ask", rubric_ask)

    out = await graph.run_start_graph(make_minimal_state(question_count=0), db=object())

    assert calls == ["load_profile", "fit_analysis", "build_rubric_plan", "rubric_ask"]
    assert out["current_question"] == "첫 질문"
    assert out["question_count"] == 1


@pytest.mark.asyncio
async def test_answer_graph_routes_to_next_question(monkeypatch):
    calls: list[str] = []

    async def evaluate_answer(state, db):
        calls.append("evaluate")
        return {
            **state,
            "current_evaluation": {"scores": {"depth": 85}, "overallScore": 80},
        }

    async def coverage_next(state, db):
        calls.append("coverage_next")
        return {**state, "next_action": "rubric_ask", "current_rubric_idx": 1}

    async def rubric_ask(state, db):
        calls.append("rubric_ask")
        return {**state, "current_question": "다음 질문", "question_count": 2}

    monkeypatch.setattr(graph, "evaluate_answer", evaluate_answer)
    monkeypatch.setattr(graph, "coverage_next", coverage_next)
    monkeypatch.setattr(graph, "rubric_ask", rubric_ask)

    out = await graph.run_answer_graph(make_minimal_state(), db=object())

    assert calls == ["evaluate", "coverage_next", "rubric_ask"]
    assert out["next_action"] == "rubric_ask"
    assert out["current_question"] == "다음 질문"


@pytest.mark.asyncio
async def test_coverage_next_digs_when_shallow():
    state = make_minimal_state(
        current_item_depth=1,
        current_evaluation={"scores": {"depth": 40}},
    )
    out = await graph.coverage_next(state, db=object())
    # 같은 항목을 한 번 더 판다 (dig).
    assert out["next_action"] == "rubric_ask"
    assert out["current_rubric_idx"] == 0
    assert out["coverage"][0]["status"] == "covered"


@pytest.mark.asyncio
async def test_coverage_next_ends_when_no_pending():
    state = make_minimal_state(
        current_item_depth=2,
        current_evaluation={"scores": {"depth": 90}},
    )
    out = await graph.coverage_next(state, db=object())
    assert out["next_action"] == "end"


def test_select_next_rubric_item_skips_extra_gaps():
    coverage = [
        {"has_evidence": True, "status": "covered"},
        {"has_evidence": False, "status": "covered"},  # gap #1 already asked
        {"has_evidence": False, "status": "pending"},  # extra gap -> unverified
        {"has_evidence": True, "status": "pending"},  # next askable
    ]
    idx = graph._select_next_rubric_item(coverage)
    assert idx == 3
    assert coverage[2]["status"] == "unverified"


def test_select_next_rubric_item_counts_skipped_gap_toward_cap():
    # /skip은 gap을 'unverified'로 표기한다. gap_asked가 'unverified'를 세지 않으면
    # gap-cap이 우회되어 두 번째 gap이 출제된다(OQ-3 위반). unverified도 세야 한다.
    coverage = [
        {"has_evidence": False, "status": "unverified"},  # gap #1 skipped
        {"has_evidence": False, "status": "pending"},  # must NOT be asked (cap reached)
    ]
    idx = graph._select_next_rubric_item(coverage)
    assert idx is None
    assert coverage[1]["status"] == "unverified"


@pytest.mark.asyncio
async def test_langchain_tools_can_be_called(monkeypatch):
    async def search_profile(db, user_id, query, top_k=5):
        return [{"user_id": user_id, "content": query, "top_k": top_k}]

    async def search_resume(db, user_id, resume_id, query, top_k=3):
        return [
            {
                "user_id": user_id,
                "resume_id": resume_id,
                "content": query,
                "top_k": top_k,
            }
        ]

    monkeypatch.setattr(
        "app.agent.interview.graph.profile_memory.search_profile", search_profile
    )
    monkeypatch.setattr(
        "app.agent.interview.graph.resume_memory.search_resume", search_resume
    )

    search_profile_tool, search_resume_tool = graph.make_interview_tools(
        object(), "user-1"
    )

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

    monkeypatch.setattr(
        "app.agent.interview.graph.profile_memory.search_profile", search_profile
    )

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
