# backend/app/agent/interviewer_agent.py
from __future__ import annotations

import json
import logging

from app.agent.state import DiveTopic, ScanItem
from app.config import settings
from app.lib.llm_client import call_llm_json
from app.prompts.agent import (
    INTERVIEWER_DECIDE_IN_TOPIC_PROMPT,
    INTERVIEWER_FOLLOWUP_PROMPT,
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
        parts.append(f"[질문 {entry.get('question_number', '?')}] {entry.get('question', '')}")
        if entry.get("answer"):
            parts.append(f"[답변] {entry['answer']}")
        if entry.get("evaluation"):
            ev = entry["evaluation"]
            parts.append(f"[평가] 점수: {ev.get('overallScore', '?')}, 피드백: {ev.get('briefFeedback', '')}")
    return "\n".join(parts)


def _format_scan_plan(scan_item: ScanItem, scan_idx: int, total_scans: int) -> str:
    return (
        f"페이즈: SCAN ({scan_idx + 1}/{total_scans})\n"
        f"프로젝트: {scan_item['project_ref']}\n"
        f"선정 이유: {scan_item['reason']}\n"
        f"지시: 이 프로젝트에 대한 '핵심 기여 또는 기술 선택 이유' 성격의 열린 질문 1개. "
        f"딥다이브 전이므로 지원자 답변의 폭을 확인하는 단계."
    )


def _format_dive_plan(dive_topic: DiveTopic, depth: int) -> str:
    angle_hint = {
        "weakness": "직전 훑기 답변이 얕았거나 약점이 드러난 주제. what → why → 트레이드오프/실패 사다리로 파세요.",
        "strength": "직전 훑기 답변이 탄탄한 주제. 핵심 의사결정, 대안 비교, 심층 트레이드오프로 파세요.",
    }.get(dive_topic["angle"], "")
    return (
        f"페이즈: DIVE\n"
        f"주제: {dive_topic['topic']}\n"
        f"프로젝트: {dive_topic['project_ref']}\n"
        f"각도: {dive_topic['angle']}\n"
        f"주제 내 질문: {depth + 1} / 3\n"
        f"지시: {angle_hint} 새 주제 도입 금지. 같은 프로젝트 안에서만 파세요."
    )


async def generate_scan_question(
    resume: dict,
    job_posting: dict | None,
    user_profile: dict,
    conversation_history: list[dict],
    scan_item: ScanItem,
    scan_idx: int,
    total_scans: int,
    resume_chunks: list[dict],
    avoid_topics: list[str],
) -> dict:
    """훑기 페이즈 질문 생성."""
    from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM

    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)
    job_str = json.dumps(job_posting, ensure_ascii=False, indent=2) if job_posting else "채용공고 없음"
    chunks_str = "\n\n".join(c.get("content", "") for c in resume_chunks) or "(청크 없음)"
    plan_str = _format_scan_plan(scan_item, scan_idx, total_scans)
    avoid_str = ", ".join(avoid_topics) or "(없음)"

    prompt = INTERVIEWER_QUESTION_PROMPT_SLIM.format(
        summary=resume.get("summary", "") if isinstance(resume, dict) else "",
        skills=", ".join(str(s) for s in (resume.get("skills") or [])) if isinstance(resume, dict) else "",
        resume_chunks=chunks_str,
        job_posting=job_str,
        current_topic_plan=plan_str,
        strengths=profile_str["strengths"],
        weaknesses=profile_str["weaknesses"],
        patterns=profile_str["patterns"],
        conversation_history=history_str,
        avoid_topics=avoid_str,
    )

    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def generate_dive_question(
    resume: dict,
    job_posting: dict | None,
    user_profile: dict,
    conversation_history: list[dict],
    dive_topic: DiveTopic,
    current_depth: int,
    resume_chunks: list[dict],
    avoid_topics: list[str],
) -> dict:
    """딥다이브 페이즈 질문 생성 (depth=0일 때는 주제 시작 질문, >=1일 때는 파고드는 질문)."""
    from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM

    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)
    job_str = json.dumps(job_posting, ensure_ascii=False, indent=2) if job_posting else "채용공고 없음"
    chunks_str = "\n\n".join(c.get("content", "") for c in resume_chunks) or "(청크 없음)"
    plan_str = _format_dive_plan(dive_topic, current_depth)
    avoid_str = ", ".join(avoid_topics) or "(없음)"

    prompt = INTERVIEWER_QUESTION_PROMPT_SLIM.format(
        summary=resume.get("summary", "") if isinstance(resume, dict) else "",
        skills=", ".join(str(s) for s in (resume.get("skills") or [])) if isinstance(resume, dict) else "",
        resume_chunks=chunks_str,
        job_posting=job_str,
        current_topic_plan=plan_str,
        strengths=profile_str["strengths"],
        weaknesses=profile_str["weaknesses"],
        patterns=profile_str["patterns"],
        conversation_history=history_str,
        avoid_topics=avoid_str,
    )

    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def decide_in_topic(
    project_ref: str,
    angle: str,
    current_depth: int,
    last_evaluation: dict,
    remaining_topics: int,
) -> dict:
    """현재 주제를 더 팔지, 다음 주제로 갈지, 끝낼지 결정."""
    prompt = INTERVIEWER_DECIDE_IN_TOPIC_PROMPT.format(
        project_ref=project_ref,
        angle=angle,
        current_depth=current_depth,
        last_evaluation=json.dumps(last_evaluation, ensure_ascii=False),
        remaining_topics=remaining_topics,
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)


async def generate_dig_deeper(
    conversation_history: list[dict],
    last_evaluation: dict,
) -> dict:
    """주제 안에서 파고드는 꼬리질문. INTERVIEWER_FOLLOWUP_PROMPT 재활용."""
    prompt = INTERVIEWER_FOLLOWUP_PROMPT.format(
        conversation_history=_format_history(conversation_history),
        last_evaluation=json.dumps(last_evaluation, ensure_ascii=False),
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)
