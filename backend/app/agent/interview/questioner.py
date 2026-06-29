# backend/app/agent/interview/questioner.py
from __future__ import annotations

import json
import logging

from app.agent.interview.state import RubricItem
from app.config import settings
from app.lib.llm_client import call_llm_json
from app.prompts.agent import (
    INTERVIEWER_FOLLOWUP_PROMPT,
    build_question_messages,
)

logger = logging.getLogger(__name__)


def _format_profile(profile: dict) -> dict[str, str]:
    return {
        "strengths": "\n".join(profile.get("strengths", [])) or "데이터 없음",
        "weaknesses": "\n".join(profile.get("weaknesses", [])) or "데이터 없음",
        "patterns": "\n".join(profile.get("patterns", [])) or "데이터 없음",
        "context": "\n".join(profile.get("context", [])) or "데이터 없음",
    }


def _format_history(history: list[dict]) -> str:
    if not history:
        return "첫 질문입니다."
    parts = []
    for entry in history:
        parts.append(
            f"[질문 {entry.get('question_number', '?')}] {entry.get('question', '')}"
        )
        if entry.get("answer"):
            parts.append(f"[답변] {entry['answer']}")
        if entry.get("evaluation"):
            ev = entry["evaluation"]
            parts.append(
                f"[평가] 점수: {ev.get('overallScore', '?')}, 피드백: {ev.get('briefFeedback', '')}"
            )
    return "\n".join(parts)


def _format_rubric_plan(item: RubricItem, item_idx: int, total_items: int) -> str:
    """질문 프롬프트의 '현재 주제 플랜' 슬롯 — 현재 JD 루브릭 항목 컨텍스트."""
    if item.get("has_evidence"):
        mode = "근거 있음(evidence)"
        evidence = (
            ", ".join(item.get("evidence_refs") or []) or "(이력서 RAG 발췌 참고)"
        )
        instruction = (
            f"이 JD 요구역량을 이력서 근거({evidence})와 연결해, 그 경험에서의 "
            f"의사결정·근거·트레이드오프를 묻는 질문 1개를 만드세요."
        )
    else:
        mode = "근거 없음(gap)"
        instruction = (
            "이력서에 직접 경험이 보이지 않는 JD 요구역량입니다. 비난조 없이 유사 경험·학습·"
            "대응 전략을 확인하는 질문 1개를 만드세요."
        )
    return (
        f"JD 루브릭 항목 {item_idx + 1}/{total_items}\n"
        f"검증 역량(label): {item['label']}\n"
        f"JD 요구 원문: {item['jd_requirement']}\n"
        f"중요도: {item['importance']}\n"
        f"모드: {mode}\n"
        f"지시: {instruction} 질문에 JD 요구역량이 드러나도록 하세요."
    )


async def generate_rubric_question(
    resume: dict,
    job_posting: dict | None,
    user_profile: dict,
    conversation_history: list[dict],
    rubric_item: RubricItem,
    item_idx: int,
    total_items: int,
    resume_chunks: list[dict],
    avoid_topics: list[str],
) -> dict:
    """JD 루브릭 항목 검증 질문 생성 (항목의 첫 질문)."""
    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)
    job_str = (
        json.dumps(job_posting, ensure_ascii=False, indent=2)
        if job_posting
        else "채용공고 없음"
    )
    chunks_str = (
        "\n\n".join(c.get("content", "") for c in resume_chunks) or "(청크 없음)"
    )
    plan_str = _format_rubric_plan(rubric_item, item_idx, total_items)
    avoid_str = ", ".join(avoid_topics) or "(없음)"

    stable, variable = build_question_messages(
        summary=resume.get("summary", "") if isinstance(resume, dict) else "",
        skills=", ".join(str(s) for s in (resume.get("skills") or []))
        if isinstance(resume, dict)
        else "",
        job_posting=job_str,
        strengths=profile_str["strengths"],
        weaknesses=profile_str["weaknesses"],
        patterns=profile_str["patterns"],
        resume_chunks=chunks_str,
        current_topic_plan=plan_str,
        conversation_history=history_str,
        avoid_topics=avoid_str,
    )

    return await call_llm_json(
        cached_context=stable,
        variable=variable,
        model=settings.AGENT_MODEL,
        temperature=0.7,
        tag="interview.questioner.rubric_question",
    )


async def generate_dig_deeper(
    conversation_history: list[dict],
    last_evaluation: dict,
) -> dict:
    """루브릭 항목 안에서 파고드는 꼬리질문. INTERVIEWER_FOLLOWUP_PROMPT 재활용."""
    prompt = INTERVIEWER_FOLLOWUP_PROMPT.format(
        conversation_history=_format_history(conversation_history),
        last_evaluation=json.dumps(last_evaluation, ensure_ascii=False),
    )
    return await call_llm_json(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.7,
        tag="interview.questioner.dig_deeper",
    )
