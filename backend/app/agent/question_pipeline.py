"""질문 플랜/생성 파이프라인 — LangGraph로 분기/순차 LLM 호출 관리."""
from __future__ import annotations

import json
import logging
from typing import Any, Literal, TypedDict

from langgraph.graph import END, StateGraph
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import tracing
from app.lib.llm_client import call_llm_json
from app.models.interview import JobPosting
from app.models.resume import Resume
from app.prompts.question_generation import (
    DEEP_INTERVIEW_PLAN_PROMPT,
    DEEP_INTERVIEW_QUESTION_PROMPT,
    GENERAL_QUESTION_PROMPT,
    INTERVIEW_PLAN_PROMPT,
    QUESTION_GENERATION_PROMPT,
    RESUME_ONLY_PLAN_PROMPT,
    RESUME_ONLY_QUESTION_PROMPT,
)
from app.services.matching import analyze_match

logger = logging.getLogger(__name__)


PlanMode = Literal["deep", "with_job", "resume_only"]
GenMode = Literal["deep", "tailored", "resume", "general"]


def _dump(obj: Any, fallback: str) -> str:
    if obj is None:
        return fallback
    return json.dumps(obj, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Plan graph
# ---------------------------------------------------------------------------

class PlanState(TypedDict, total=False):
    db: AsyncSession
    user_id: str
    resume_id: str
    job_posting_id: str | None
    deep_mode: bool

    parsed_resume: dict | None
    parsed_job_posting: dict | None
    company_analysis: dict | None
    matching_analysis: dict | None

    mode: PlanMode
    plan: dict[str, Any]


async def _plan_load_resume(state: PlanState) -> dict[str, Any]:
    db = state["db"]
    result = await db.execute(
        select(Resume).where(Resume.id == state["resume_id"], Resume.user_id == state["user_id"])
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise ValueError("Resume not found")
    return {"parsed_resume": resume.parsed_data}


def _plan_route(state: PlanState) -> PlanMode:
    if state.get("deep_mode"):
        if not state.get("parsed_resume"):
            raise ValueError("Resume has no parsed data")
        return "deep"
    if state.get("job_posting_id"):
        return "with_job"
    if not state.get("parsed_resume"):
        raise ValueError("Resume has no parsed data")
    return "resume_only"


async def _plan_load_job(state: PlanState) -> dict[str, Any]:
    db = state["db"]
    query = select(JobPosting).where(JobPosting.id == state["job_posting_id"])
    if state.get("user_id") is not None:
        query = query.where(JobPosting.user_id == state["user_id"])
    result = await db.execute(query)
    job_posting = result.scalar_one_or_none()
    if not job_posting:
        raise ValueError("Job posting not found")

    parsed_jp = job_posting.parsed_data
    parsed_resume = state.get("parsed_resume")
    matching = (
        await analyze_match(parsed_jp, parsed_resume)
        if parsed_resume and parsed_jp
        else None
    )
    return {
        "parsed_job_posting": parsed_jp,
        "company_analysis": job_posting.company_analysis,
        "matching_analysis": matching,
    }


async def _plan_call_llm(state: PlanState) -> dict[str, Any]:
    mode = state["mode"]
    if mode == "deep":
        prompt = DEEP_INTERVIEW_PLAN_PROMPT.replace(
            "{parsedResume}", _dump(state["parsed_resume"], "")
        )
    elif mode == "with_job":
        prompt = (
            INTERVIEW_PLAN_PROMPT.replace(
                "{parsedJobPosting}", _dump(state.get("parsed_job_posting"), "")
            )
            .replace("{companyAnalysis}", _dump(state.get("company_analysis"), "회사 분석 없음"))
            .replace("{parsedResume}", _dump(state.get("parsed_resume"), "이력서 없음"))
            .replace("{matchingAnalysis}", _dump(state.get("matching_analysis"), "매칭 분석 없음"))
        )
    else:  # resume_only
        prompt = RESUME_ONLY_PLAN_PROMPT.replace(
            "{parsedResume}", _dump(state["parsed_resume"], "")
        )

    raw = await call_llm_json(prompt, temperature=0.3)
    plan = raw if isinstance(raw, dict) else {}

    deep = mode == "deep"
    max_q = 5 if deep else 15
    default_q = 4 if deep else 5
    total = min(max(plan.get("totalQuestions", default_q), 3), max_q)

    return {
        "plan": {
            "type": plan.get("type", "TECHNICAL"),
            "categories": plan.get("categories", ["general"]),
            "difficulty": plan.get("difficulty", "INTERMEDIATE"),
            "totalQuestions": total,
            "reasoning": plan.get("reasoning", ""),
            "focusAreas": plan.get("focusAreas"),
        }
    }


def _build_plan_graph():
    g = StateGraph(PlanState)
    g.add_node("load_resume", _plan_load_resume)
    g.add_node("set_mode_deep", lambda s: {"mode": "deep"})
    g.add_node("set_mode_resume", lambda s: {"mode": "resume_only"})
    g.add_node("load_job", _plan_load_job)
    g.add_node("set_mode_job", lambda s: {"mode": "with_job"})
    g.add_node("call_llm", _plan_call_llm)

    g.set_entry_point("load_resume")
    g.add_conditional_edges(
        "load_resume",
        _plan_route,
        {
            "deep": "set_mode_deep",
            "with_job": "load_job",
            "resume_only": "set_mode_resume",
        },
    )
    g.add_edge("load_job", "set_mode_job")
    g.add_edge("set_mode_deep", "call_llm")
    g.add_edge("set_mode_resume", "call_llm")
    g.add_edge("set_mode_job", "call_llm")
    g.add_edge("call_llm", END)
    return g.compile()


_PLAN_GRAPH = _build_plan_graph()


async def run_plan_graph(
    db: AsyncSession,
    *,
    resume_id: str,
    user_id: str,
    job_posting_id: str | None = None,
    deep_mode: bool = False,
) -> dict[str, Any]:
    async def _call():
        final = await _PLAN_GRAPH.ainvoke(
            {
                "db": db,
                "user_id": user_id,
                "resume_id": resume_id,
                "job_posting_id": job_posting_id,
                "deep_mode": deep_mode,
            }
        )
        return final["plan"]

    result, _ = await tracing.traced_graph_call(
        name="question_pipeline.plan",
        metadata={"feature": "question", "graph_name": "plan", "user_id": user_id},
        call=_call,
    )
    return result


# ---------------------------------------------------------------------------
# Generate graph
# ---------------------------------------------------------------------------

class GenState(TypedDict, total=False):
    db: AsyncSession
    user_id: str
    resume_id: str
    job_posting_id: str | None
    deep_mode: bool

    type_: str
    categories: list[str]
    difficulty: str
    total_questions: int

    parsed_resume: dict | None
    parsed_job_posting: dict | None
    company_analysis: dict | None
    matching_analysis: dict | None

    mode: GenMode
    questions: list[dict[str, Any]]


async def _gen_load_resume(state: GenState) -> dict[str, Any]:
    db = state["db"]
    result = await db.execute(
        select(Resume).where(Resume.id == state["resume_id"], Resume.user_id == state["user_id"])
    )
    resume = result.scalar_one_or_none()
    return {"parsed_resume": resume.parsed_data if resume else None}


def _gen_route(state: GenState) -> GenMode:
    if state.get("deep_mode") and state.get("parsed_resume"):
        return "deep"
    if state.get("job_posting_id"):
        return "tailored"
    if state.get("parsed_resume"):
        return "resume"
    return "general"


async def _gen_load_job(state: GenState) -> dict[str, Any]:
    db = state["db"]
    query = select(JobPosting).where(JobPosting.id == state["job_posting_id"])
    if state.get("user_id") is not None:
        query = query.where(JobPosting.user_id == state["user_id"])
    result = await db.execute(query)
    job_posting = result.scalar_one_or_none()
    if not job_posting:
        raise ValueError("Job posting not found")
    parsed_jp = job_posting.parsed_data
    parsed_resume = state.get("parsed_resume")
    matching = (
        await analyze_match(parsed_jp, parsed_resume)
        if parsed_resume and parsed_jp
        else None
    )
    return {
        "parsed_job_posting": parsed_jp,
        "company_analysis": job_posting.company_analysis,
        "matching_analysis": matching,
    }


async def _gen_call_llm(state: GenState) -> dict[str, Any]:
    mode = state["mode"]
    type_ = state["type_"]
    categories = state["categories"]
    difficulty = state["difficulty"]
    total = state["total_questions"]
    cats_join = ", ".join(categories)

    if mode == "deep":
        prompt = (
            DEEP_INTERVIEW_QUESTION_PROMPT.replace(
                "{matchedTopics}",
                "(확정된 문제은행 없음. 이력서와 카테고리를 기반으로 자유롭게 생성)",
            )
            .replace("{categories}", cats_join)
            .replace("{difficulty}", difficulty)
            .replace("{totalQuestions}", str(total))
            .replace("{parsedResume}", _dump(state["parsed_resume"], ""))
        )
        default_source = None
    elif mode == "tailored":
        prompt = (
            QUESTION_GENERATION_PROMPT.replace("{interviewType}", type_)
            .replace("{categories}", cats_join)
            .replace("{difficulty}", difficulty)
            .replace("{totalQuestions}", str(total))
            .replace("{parsedJobPosting}", _dump(state.get("parsed_job_posting"), ""))
            .replace("{parsedResume}", _dump(state.get("parsed_resume"), "이력서 없음"))
            .replace("{matchingAnalysis}", _dump(state.get("matching_analysis"), "매칭 분석 없음"))
            .replace("{companyAnalysis}", _dump(state.get("company_analysis"), "회사 분석 없음"))
        )
        default_source = None
    elif mode == "resume":
        prompt = (
            RESUME_ONLY_QUESTION_PROMPT.replace("{interviewType}", type_)
            .replace("{categories}", cats_join)
            .replace("{difficulty}", difficulty)
            .replace("{totalQuestions}", str(total))
            .replace("{parsedResume}", _dump(state["parsed_resume"], ""))
        )
        default_source = None
    else:  # general
        prompt = (
            GENERAL_QUESTION_PROMPT.replace("{interviewType}", type_)
            .replace("{categories}", cats_join)
            .replace("{difficulty}", difficulty)
            .replace("{totalQuestions}", str(total))
        )
        default_source = "general"

    raw = await call_llm_json(prompt, temperature=0.7)
    items = (
        raw if isinstance(raw, list)
        else raw.get("questions", []) if isinstance(raw, dict)
        else []
    )

    deep = mode == "deep"
    result: list[dict[str, Any]] = []
    for index, q in enumerate(items):
        item: dict[str, Any] = {
            "index": index,
            "text": q.get("text", ""),
            "source": q.get("source") or default_source or ("deep_technical" if deep else "general"),
            "category": q.get("category") or (categories[0] if categories else "general"),
            "difficulty": q.get("difficulty") or difficulty,
        }
        if deep and q.get("relatedKeyPoints"):
            item["relatedKeyPoints"] = q["relatedKeyPoints"]
        result.append(item)

    return {"questions": result}


def _build_gen_graph():
    g = StateGraph(GenState)
    g.add_node("load_resume", _gen_load_resume)
    g.add_node("set_mode_deep", lambda s: {"mode": "deep"})
    g.add_node("set_mode_resume", lambda s: {"mode": "resume"})
    g.add_node("set_mode_general", lambda s: {"mode": "general"})
    g.add_node("load_job", _gen_load_job)
    g.add_node("set_mode_tailored", lambda s: {"mode": "tailored"})
    g.add_node("call_llm", _gen_call_llm)

    g.set_entry_point("load_resume")
    g.add_conditional_edges(
        "load_resume",
        _gen_route,
        {
            "deep": "set_mode_deep",
            "tailored": "load_job",
            "resume": "set_mode_resume",
            "general": "set_mode_general",
        },
    )
    g.add_edge("load_job", "set_mode_tailored")
    for node in ("set_mode_deep", "set_mode_resume", "set_mode_general", "set_mode_tailored"):
        g.add_edge(node, "call_llm")
    g.add_edge("call_llm", END)
    return g.compile()


_GEN_GRAPH = _build_gen_graph()


async def run_generate_graph(
    db: AsyncSession,
    *,
    type_: str,
    categories: list[str],
    difficulty: str,
    total_questions: int,
    resume_id: str,
    user_id: str,
    job_posting_id: str | None = None,
    deep_mode: bool = False,
) -> list[dict[str, Any]]:
    async def _call():
        final = await _GEN_GRAPH.ainvoke(
            {
                "db": db,
                "user_id": user_id,
                "resume_id": resume_id,
                "job_posting_id": job_posting_id,
                "deep_mode": deep_mode,
                "type_": type_,
                "categories": categories,
                "difficulty": difficulty,
                "total_questions": total_questions,
            }
        )
        return final["questions"]

    result, _ = await tracing.traced_graph_call(
        name="question_pipeline.generate",
        metadata={"feature": "question", "graph_name": "generate", "user_id": user_id},
        call=_call,
    )
    return result
