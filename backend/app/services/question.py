"""질문 플랜/생성 서비스 — LangGraph 파이프라인 위임."""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.question_pipeline import run_generate_graph, run_plan_graph

logger = logging.getLogger(__name__)


async def plan_interview(
    db: AsyncSession,
    *,
    resume_id: str,
    user_id: str,
    job_posting_id: str | None = None,
    deep_mode: bool = False,
) -> dict[str, Any]:
    return await run_plan_graph(
        db,
        resume_id=resume_id,
        user_id=user_id,
        job_posting_id=job_posting_id,
        deep_mode=deep_mode,
    )


async def generate_questions(
    db: AsyncSession,
    *,
    type_: str,
    categories: list[str],
    difficulty: str,
    total_questions: int,
    resume_id: str,
    user_id: str,
    job_posting_id: str | None = None,
    deep_mode: bool = False,
) -> list[dict[str, Any]]:
    return await run_generate_graph(
        db,
        type_=type_,
        categories=categories,
        difficulty=difficulty,
        total_questions=total_questions,
        resume_id=resume_id,
        user_id=user_id,
        job_posting_id=job_posting_id,
        deep_mode=deep_mode,
    )
