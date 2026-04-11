import json
import logging

from app.config import settings
from app.lib.anthropic_client import call_llm_json
from app.prompts.learning_agent import (
    LEARNING_STRATEGY_INSTRUCTIONS,
    TUTOR_ASSESS_PROMPT,
    TUTOR_GREETING_PROMPT,
    TUTOR_PROFILE_INSIGHT_PROMPT,
    TUTOR_SUMMARY_PROMPT,
    TUTOR_TEACH_PROMPT,
)

logger = logging.getLogger(__name__)


async def generate_greeting(user_profile: dict) -> dict:
    profile_str = json.dumps(user_profile, ensure_ascii=False) if user_profile else "이전 학습 기록 없음"
    prompt = TUTOR_GREETING_PROMPT.replace("{user_profile}", profile_str)
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def generate_teaching(
    topic: str,
    phase: str,
    user_profile: dict,
    conversation_history: list[dict],
    user_message: str,
    strategy: str = "explain",
    profile_context: list[dict] | None = None,
    journal_context: list[dict] | None = None,
) -> dict:
    """Generate teaching content with strategy and cross-context."""
    profile_str = json.dumps(user_profile, ensure_ascii=False) if user_profile else "프로필 없음"
    history_str = json.dumps(conversation_history, ensure_ascii=False) if conversation_history else "[]"

    # 전략 지시문
    strategy_instruction = LEARNING_STRATEGY_INSTRUCTIONS.get(strategy, "")

    # 프로필 RAG 맥락
    profile_parts = []
    if profile_context:
        profile_parts.append("사용자 학습 프로필에서 검색된 정보:")
        for item in profile_context[:5]:
            profile_parts.append(f"- [{item.get('category', '')}] {item.get('content', '')}")
    profile_ctx_str = "\n".join(profile_parts) if profile_parts else ""

    # 저널 크로스 맥락
    journal_parts = []
    if journal_context:
        journal_parts.append("사용자의 최근 일상/감정/목표에서 검색된 정보:")
        for item in journal_context[:5]:
            journal_parts.append(f"- [{item.get('category', '')}] {item.get('content', '')}")
    journal_ctx_str = "\n".join(journal_parts) if journal_parts else ""

    prompt = (
        TUTOR_TEACH_PROMPT
        .replace("{topic}", topic)
        .replace("{phase}", phase)
        .replace("{user_profile}", profile_str)
        .replace("{conversation_history}", history_str)
        .replace("{user_message}", user_message)
        .replace("{strategy_instruction}", strategy_instruction)
        .replace("{profile_context}", profile_ctx_str)
        .replace("{journal_context}", journal_ctx_str)
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)


async def assess_understanding(
    topic: str,
    current_phase: str,
    conversation_history: list[dict],
    user_message: str,
) -> dict:
    history_str = json.dumps(conversation_history, ensure_ascii=False) if conversation_history else "[]"
    prompt = (
        TUTOR_ASSESS_PROMPT
        .replace("{topic}", topic or "미정")
        .replace("{current_phase}", current_phase or "greeting")
        .replace("{conversation_history}", history_str)
        .replace("{user_message}", user_message)
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)


async def generate_summary(
    topic: str,
    conversation_history: list[dict],
    user_profile: dict,
) -> dict:
    profile_str = json.dumps(user_profile, ensure_ascii=False) if user_profile else "프로필 없음"
    history_str = json.dumps(conversation_history, ensure_ascii=False) if conversation_history else "[]"
    prompt = (
        TUTOR_SUMMARY_PROMPT
        .replace("{topic}", topic)
        .replace("{conversation_history}", history_str)
        .replace("{user_profile}", profile_str)
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.5)


async def extract_profile_insights(
    topic: str,
    conversation_history: list[dict],
) -> dict:
    history_str = json.dumps(conversation_history, ensure_ascii=False) if conversation_history else "[]"
    prompt = (
        TUTOR_PROFILE_INSIGHT_PROMPT
        .replace("{topic}", topic)
        .replace("{conversation_history}", history_str)
    )
    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.3)
