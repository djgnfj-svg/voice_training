"""답변 평가 파이프라인 — LangGraph로 transcript 보정 → 프롬프트 분기 → 평가."""
from __future__ import annotations

import json
import logging
from typing import Any, Literal, TypedDict

from langgraph.graph import END, StateGraph

from app.agent import tracing
from app.lib.llm_client import call_llm_json
from app.lib.transcript_correct import correct_transcript
from app.prompts.evaluation import (
    BEHAVIORAL_EVALUATION_PROMPT,
    DEEP_TECHNICAL_EVALUATION_PROMPT,
    FOLLOWUP_EVALUATION_PROMPT,
    TECHNICAL_EVALUATION_PROMPT,
)

logger = logging.getLogger(__name__)


PromptKind = Literal["followup", "deep", "behavioral", "technical"]


class EvalState(TypedDict, total=False):
    question_text: str
    answer_transcript: str
    interview_type: str
    deep_mode: bool
    related_key_points: list[str] | None
    previous_context: dict | None

    corrected_text: str
    was_changed: bool
    prompt_kind: PromptKind
    prompt: str
    evaluation: dict[str, Any]


async def _correct(state: EvalState) -> dict[str, Any]:
    corrected = await correct_transcript(state["answer_transcript"], state["question_text"])
    return {
        "corrected_text": corrected,
        "was_changed": corrected != state["answer_transcript"],
    }


def _select_prompt(state: EvalState) -> PromptKind:
    if state.get("previous_context"):
        return "followup"
    if state.get("deep_mode"):
        return "deep"
    if state.get("interview_type") == "BEHAVIORAL":
        return "behavioral"
    return "technical"


_TEMPLATES: dict[PromptKind, str] = {
    "followup": FOLLOWUP_EVALUATION_PROMPT,
    "deep": DEEP_TECHNICAL_EVALUATION_PROMPT,
    "behavioral": BEHAVIORAL_EVALUATION_PROMPT,
    "technical": TECHNICAL_EVALUATION_PROMPT,
}


def _build_prompt(state: EvalState) -> dict[str, Any]:
    kind = state["prompt_kind"]
    prompt = (
        _TEMPLATES[kind]
        .replace("{question}", state["question_text"])
        .replace("{answer}", state["corrected_text"])
    )

    if kind == "followup":
        ctx = state["previous_context"] or {}
        lines = [
            f"원래 질문: {ctx.get('originalQuestion', '')}",
            f"원래 답변: {ctx.get('originalAnswer', '')}",
        ]
        for fh in ctx.get("followUpHistory", []) or []:
            lines.append(f"꼬리질문: {fh['question']}")
            lines.append(f"답변: {fh['answer']}")
        prompt = prompt.replace("{previousContext}", "\n".join(lines))
    elif kind == "deep":
        kps = state.get("related_key_points") or []
        kp_str = "\n".join(f"- {kp}" for kp in kps) if kps else "(참고 핵심 포인트 없음)"
        prompt = prompt.replace("{relatedKeyPoints}", kp_str)

    return {"prompt": prompt}


async def _call_llm(state: EvalState) -> dict[str, Any]:
    try:
        raw = await call_llm_json(state["prompt"], temperature=0.3)
        evaluation: dict[str, Any] = (
            raw if isinstance(raw, dict) else {"error": "unexpected format"}
        )
    except (json.JSONDecodeError, ValueError) as e:
        logger.error("Failed to parse evaluation response: %s", e)
        raise ValueError("Failed to evaluate answer") from e

    if state.get("was_changed"):
        evaluation["correctedTranscript"] = state["corrected_text"]
    return {"evaluation": evaluation}


def _build_graph():
    g = StateGraph(EvalState)
    g.add_node("correct", _correct)
    g.add_node("set_followup", lambda s: {"prompt_kind": "followup"})
    g.add_node("set_deep", lambda s: {"prompt_kind": "deep"})
    g.add_node("set_behavioral", lambda s: {"prompt_kind": "behavioral"})
    g.add_node("set_technical", lambda s: {"prompt_kind": "technical"})
    g.add_node("build_prompt", _build_prompt)
    g.add_node("call_llm", _call_llm)

    g.set_entry_point("correct")
    g.add_conditional_edges(
        "correct",
        _select_prompt,
        {
            "followup": "set_followup",
            "deep": "set_deep",
            "behavioral": "set_behavioral",
            "technical": "set_technical",
        },
    )
    for node in ("set_followup", "set_deep", "set_behavioral", "set_technical"):
        g.add_edge(node, "build_prompt")
    g.add_edge("build_prompt", "call_llm")
    g.add_edge("call_llm", END)
    return g.compile()


_GRAPH = _build_graph()


async def run_evaluation_graph(
    *,
    question_text: str,
    answer_transcript: str,
    interview_type: str,
    deep_mode: bool = False,
    related_key_points: list[str] | None = None,
    previous_context: dict | None = None,
) -> dict[str, Any]:
    async def _call():
        final = await _GRAPH.ainvoke(
            {
                "question_text": question_text,
                "answer_transcript": answer_transcript,
                "interview_type": interview_type,
                "deep_mode": deep_mode,
                "related_key_points": related_key_points,
                "previous_context": previous_context,
            }
        )
        return final["evaluation"]

    result, _ = await tracing.traced_graph_call(
        name="evaluation_pipeline.evaluate",
        metadata={"feature": "evaluation", "graph_name": "evaluate", "interview_type": interview_type},
        call=_call,
    )
    return result
