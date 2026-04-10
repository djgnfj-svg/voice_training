# backend/app/agent/counseling_agent.py
from __future__ import annotations

import logging

from app.lib.anthropic_client import call_llm
from app.config import settings
from app.prompts.journal import COUNSELING_SYSTEM_PROMPT

logger = logging.getLogger(__name__)


async def generate_response(
    messages: list[dict],
    user_message: str,
    journal_context: list[dict],
) -> str:
    """Generate counseling-mode response."""
    context_parts = []
    if journal_context:
        context_parts.append("사용자에 대해 알고 있는 정보:")
        for item in journal_context[:5]:
            context_parts.append(f"- [{item['category']}] {item['content']}")

    context_str = "\n".join(context_parts) if context_parts else ""
    system = COUNSELING_SYSTEM_PROMPT.format(context=context_str)

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
