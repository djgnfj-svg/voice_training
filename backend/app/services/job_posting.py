from __future__ import annotations

import hashlib
import json
import logging
from typing import Any
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.llm_client import call_llm_json, MODELS
from app.models.interview import JobPosting
from app.prompts.job_posting import JOB_POSTING_ANALYSIS_PROMPT, COMPANY_ANALYSIS_PROMPT

logger = logging.getLogger(__name__)


def _hash_raw_text(raw_text: str) -> str:
    """raw_text를 정규화(trim) 후 sha256. 공백 차이로 캐시 미스 방지."""
    normalized = raw_text.strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Job posting analysis
# ---------------------------------------------------------------------------

async def analyze_job_posting(
    db: AsyncSession, *, user_id: str, raw_text: str
) -> dict[str, Any]:
    """공고 분석. 동일 유저+동일 raw_text 해시면 캐시 hit (LLM 재호출 없음)."""
    raw_text_hash = _hash_raw_text(raw_text)

    # Cache lookup: (userId, rawTextHash)
    cached = await db.execute(
        select(JobPosting).where(
            JobPosting.user_id == user_id,
            JobPosting.raw_text_hash == raw_text_hash,
            JobPosting.parsed_data.isnot(None),
        )
        .order_by(JobPosting.created_at.desc())
        .limit(1)
    )
    hit = cached.scalar_one_or_none()
    if hit is not None:
        logger.info("job_posting cache hit: user=%s hash=%s", user_id, raw_text_hash[:8])
        return _serialize_job_posting(hit)

    # Cache miss: insert + analyze
    job_posting_id = str(uuid4())
    job_posting = JobPosting(
        id=job_posting_id,
        user_id=user_id,
        raw_text=raw_text,
        raw_text_hash=raw_text_hash,
    )
    db.add(job_posting)
    await db.flush()

    parsed_data = await _parse_job_posting(raw_text)
    company_analysis = await _analyze_company(
        company=parsed_data.get("company", ""),
        position=parsed_data.get("position", ""),
        tech_stack=parsed_data.get("techStack", []),
    )

    await db.execute(
        update(JobPosting)
        .where(JobPosting.id == job_posting_id)
        .values(
            parsed_data=parsed_data,
            company_analysis=company_analysis,
        )
    )
    await db.commit()

    result = await db.execute(
        select(JobPosting).where(JobPosting.id == job_posting_id)
    )
    updated = result.scalar_one()
    logger.info("job_posting cache miss→stored: user=%s hash=%s", user_id, raw_text_hash[:8])
    return _serialize_job_posting(updated)


async def _parse_job_posting(raw_text: str) -> dict[str, Any]:
    prompt = JOB_POSTING_ANALYSIS_PROMPT.replace("{jobPostingText}", raw_text)
    raw = await call_llm_json(
        prompt,
        model=MODELS["ANALYSIS"],
        temperature=0.3,
    )
    if not isinstance(raw, dict):
        raise ValueError("Failed to parse job posting")
    return raw


async def _analyze_company(
    company: str, position: str, tech_stack: list[str]
) -> dict[str, Any]:
    prompt = (
        COMPANY_ANALYSIS_PROMPT.replace("{company}", company)
        .replace("{position}", position)
        .replace("{techStack}", ", ".join(tech_stack))
    )
    raw = await call_llm_json(
        prompt,
        model=MODELS["ANALYSIS"],
        temperature=0.5,
    )
    if not isinstance(raw, dict):
        raise ValueError("Failed to analyze company")
    return raw


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

async def get_job_posting(
    db: AsyncSession, *, job_posting_id: str, user_id: str
) -> dict[str, Any] | None:
    result = await db.execute(
        select(JobPosting).where(
            JobPosting.id == job_posting_id,
            JobPosting.user_id == user_id,
        )
    )
    jp = result.scalar_one_or_none()
    return _serialize_job_posting(jp) if jp else None


async def get_user_job_postings(
    db: AsyncSession, *, user_id: str
) -> list[dict[str, Any]]:
    result = await db.execute(
        select(JobPosting)
        .where(JobPosting.user_id == user_id)
        .order_by(JobPosting.created_at.desc())
    )
    rows = result.scalars().all()
    return [_serialize_job_posting(jp) for jp in rows]


def _serialize_job_posting(jp: JobPosting) -> dict[str, Any]:
    return {
        "id": jp.id,
        "userId": jp.user_id,
        "rawText": jp.raw_text,
        "rawTextHash": jp.raw_text_hash,
        "parsedData": jp.parsed_data,
        "companyAnalysis": jp.company_analysis or {},
        "createdAt": jp.created_at.isoformat() if jp.created_at else None,
        "updatedAt": jp.updated_at.isoformat() if jp.updated_at else None,
    }
