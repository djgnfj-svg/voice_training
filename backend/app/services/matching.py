from __future__ import annotations

import json
from typing import Any

from app.lib.llm_client import call_llm_json, MODELS
from app.prompts.matching import MATCHING_ANALYSIS_PROMPT


async def analyze_match(
    parsed_job_posting: dict[str, Any],
    parsed_resume: dict[str, Any],
) -> dict[str, Any]:
    """
    Analyze the match between a job posting and a resume using Claude.
    Returns a matching analysis dict.
    """
    prompt = MATCHING_ANALYSIS_PROMPT.replace(
        "{parsedJobPosting}", json.dumps(parsed_job_posting, ensure_ascii=False, indent=2)
    ).replace(
        "{parsedResume}", json.dumps(parsed_resume, ensure_ascii=False, indent=2)
    )

    raw = await call_llm_json(
        prompt,
        model=MODELS["ANALYSIS"],
        temperature=0.4,
    )

    if not isinstance(raw, dict):
        raise ValueError("Failed to analyze matching")

    return raw
