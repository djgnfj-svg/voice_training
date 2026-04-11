# backend/app/agent/journal_agent.py
from __future__ import annotations

import logging

from app.lib.anthropic_client import call_llm
from app.config import settings
from app.prompts.journal import JOURNAL_SYSTEM_PROMPT, STRATEGY_INSTRUCTIONS

logger = logging.getLogger(__name__)


async def generate_response(
    messages: list[dict],
    user_message: str,
    journal_context: list[dict],
    strategy: str = "deepen",
    past_context: list[dict] | None = None,
) -> str:
    """Generate journal-mode response with strategy and past context."""
    # 오늘 컨텍스트
    context_parts = []
    if journal_context:
        context_parts.append("오늘 이야기된 내용:")
        for item in journal_context[:5]:
            context_parts.append(f"- [{item['category']}] {item['content']}")
    context_str = "\n".join(context_parts) if context_parts else ""

    # 전략 지시문
    strategy_instruction = STRATEGY_INSTRUCTIONS.get(strategy, "")

    # 과거 맥락
    past_parts = []
    if past_context:
        past_parts.append("과거 대화에서 알게 된 정보:")
        for item in past_context[:5]:
            past_parts.append(f"- [{item['category']}] {item['content']}")
    past_str = "\n".join(past_parts) if past_parts else ""

    system = JOURNAL_SYSTEM_PROMPT.format(
        strategy_instruction=strategy_instruction,
        past_context=past_str,
        context=context_str,
    )

    conversation = ""
    for m in messages[-10:]:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        conversation += f"{role_label}: {m.get('content', '')}\n"
    conversation += f"사용자: {user_message}\n"

    prompt = f"다음 대화에 이어서 응답하세요.\n\n{conversation}"

    response = await call_llm(
        prompt,
        model=settings.AGENT_MODEL,
        temperature=0.7,
        system=system,
        max_tokens=500,
    )
    return response.strip()
