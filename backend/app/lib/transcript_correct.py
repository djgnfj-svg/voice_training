from __future__ import annotations

import logging

from app.lib.llm_client import call_llm

logger = logging.getLogger(__name__)


async def correct_transcript(
    raw_transcript: str, question_context: str | None = None
) -> str:
    """Correct a Korean speech-to-text transcript. Returns corrected text (or raw on failure)."""
    if len(raw_transcript) < 10:
        return raw_transcript

    try:
        context_hint = ""
        if question_context:
            context_hint = (
                f"\n\n면접 질문: {question_context}\n"
                "(위 질문의 맥락을 참고하여 관련 기술 용어를 정확하게 교정하세요)"
            )

        prompt = (
            "다음 한국어 음성 인식 텍스트를 교정해주세요. 규칙:\n"
            "1. 띄어쓰기를 올바르게 수정\n"
            '2. 기술 용어를 정확한 표기로 수정 (예: "리엑트"→"리액트", "에이피아이"→"API", "제이에스"→"JS", "타입스크립트"→"TypeScript")\n'
            "3. 문장 부호를 적절히 추가\n"
            f"4. 의미를 변경하지 말 것{context_hint}\n\n"
            "원본과 동일하면 그대로 반환하세요.\n"
            "교정된 텍스트만 반환하세요. 설명 없이.\n\n"
            f"텍스트: {raw_transcript}"
        )

        corrected_text = (await call_llm(prompt, temperature=0)).strip()
        return corrected_text or raw_transcript

    except Exception:
        logger.exception("Transcript correction failed")
        return raw_transcript
