# backend/app/agent/interviewer_agent.py
from __future__ import annotations

import json
import logging

from app.config import settings
from app.lib.llm_client import call_llm_json
from app.prompts.agent import (
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
    fit_analysis: dict | None = None,
    resume_chunks: list[dict] | None = None,
    has_embeddings: bool = False,
    current_focus_topic: str = "",
) -> dict:
    """면접 질문 생성. has_embeddings에 따라 SLIM/FALLBACK 분기."""
    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)
    job_str = json.dumps(job_posting, ensure_ascii=False, indent=2) if job_posting else "채용공고 없음"

    if has_embeddings and resume_chunks:
        from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM
        chunks_str = "\n\n".join(c.get("content", "") for c in resume_chunks)
        fit_str = json.dumps(fit_analysis, ensure_ascii=False, indent=2) if fit_analysis else "Fit Analysis 없음"
        avoid_str = ", ".join((fit_analysis or {}).get("avoid_topics", [])) or "(없음)"
        prompt = INTERVIEWER_QUESTION_PROMPT_SLIM.format(
            summary=resume.get("summary", "") if isinstance(resume, dict) else "",
            skills=", ".join(str(s) for s in (resume.get("skills") or [])) if isinstance(resume, dict) else "",
            resume_chunks=chunks_str,
            job_posting=job_str,
            fit_analysis=fit_str,
            strengths=profile_str["strengths"],
            weaknesses=profile_str["weaknesses"],
            patterns=profile_str["patterns"],
            conversation_history=history_str,
            current_focus_topic=current_focus_topic or "(자유 선택)",
            avoid_topics=avoid_str,
        )
    else:
        from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_FALLBACK
        resume_str = json.dumps(resume, ensure_ascii=False, indent=2) if isinstance(resume, dict) else str(resume)
        prompt = INTERVIEWER_QUESTION_PROMPT_FALLBACK.format(
            resume=resume_str,
            job_posting=job_str,
            strengths=profile_str["strengths"],
            weaknesses=profile_str["weaknesses"],
            patterns=profile_str["patterns"],
            context=profile_str["context"],
            conversation_history=history_str,
        )

    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


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
