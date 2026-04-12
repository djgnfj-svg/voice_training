# backend/app/agent/journal_router_agent.py
from __future__ import annotations

import logging

from app.lib.llm_client import call_llm_json
from app.config import settings
from app.prompts.journal import ROUTER_PROMPT

logger = logging.getLogger(__name__)

_COUNSELING_KEYWORDS = [
    "힘들", "스트레스", "불안", "우울", "걱정", "고민",
    "짜증", "화가", "속상", "외로", "무기력", "자신감",
    "갈등", "싸우", "다퉜", "두렵", "무서",
]

_JOURNAL_KEYWORDS = [
    "오늘", "했어", "갔다", "먹었", "봤어", "만났",
    "회사에서", "집에서", "학교에서",
]


async def classify_intent(
    user_message: str,
    current_mode: str,
    recent_messages: list[dict],
) -> dict:
    """Classify user intent as journal or counseling.
    Returns: {"mode": "journal"|"counseling", "reason": "..."}
    """
    msg_lower = user_message.lower()

    counseling_score = sum(1 for kw in _COUNSELING_KEYWORDS if kw in msg_lower)
    journal_score = sum(1 for kw in _JOURNAL_KEYWORDS if kw in msg_lower)

    if counseling_score >= 2 and counseling_score > journal_score:
        return {"mode": "counseling", "reason": "감정/고민 키워드 감지"}
    if journal_score >= 2 and journal_score > counseling_score:
        return {"mode": "journal", "reason": "일상 보고 키워드 감지"}

    if counseling_score == 0 and journal_score == 0:
        return {"mode": current_mode, "reason": "키워드 없음, 현재 모드 유지"}

    recent_text = ""
    for m in recent_messages[-3:]:
        role_label = "사용자" if m.get("role") == "user" else "AI"
        recent_text += f"{role_label}: {m.get('content', '')}\n"

    prompt = ROUTER_PROMPT.format(
        current_mode=current_mode,
        recent_messages=recent_text or "(대화 시작)",
        user_message=user_message,
    )

    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.1)
        mode = result.get("mode", current_mode)
        if mode not in ("journal", "counseling"):
            mode = current_mode
        return {"mode": mode, "reason": result.get("reason", "")}
    except Exception:
        logger.exception("Router classification failed, keeping current mode")
        return {"mode": current_mode, "reason": "분류 실패, 현재 모드 유지"}
