from __future__ import annotations

import json
import logging
from typing import Any
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.anthropic_client import call_llm_json, MODELS
from app.config import settings
from app.models.interview import JobPosting
from app.prompts.job_posting import JOB_POSTING_ANALYSIS_PROMPT, COMPANY_ANALYSIS_PROMPT
from app.prompts.company_research import DEEP_COMPANY_ANALYSIS_PROMPT

logger = logging.getLogger(__name__)

# Optional Tavily integration
try:
    from tavily import TavilyClient

    tavily_available = bool(settings.TAVILY_API_KEY)
except ImportError:
    tavily_available = False

_tavily_client: Any = None


def _get_tavily_client() -> Any:
    global _tavily_client
    if not tavily_available:
        return None
    if _tavily_client is None:
        _tavily_client = TavilyClient(api_key=settings.TAVILY_API_KEY)
    return _tavily_client


# ---------------------------------------------------------------------------
# Job posting analysis
# ---------------------------------------------------------------------------

async def analyze_job_posting(
    db: AsyncSession, *, user_id: str, raw_text: str
) -> dict[str, Any]:
    """Create job posting record, parse with Claude, analyze company."""
    job_posting_id = str(uuid4())
    job_posting = JobPosting(
        id=job_posting_id,
        user_id=user_id,
        raw_text=raw_text,
    )
    db.add(job_posting)
    await db.flush()

    # Parse job posting
    parsed_data = await _parse_job_posting(raw_text)

    # Analyze company
    company_analysis = await _analyze_company(
        company=parsed_data.get("company", ""),
        position=parsed_data.get("position", ""),
        tech_stack=parsed_data.get("techStack", []),
    )

    # Update record
    await db.execute(
        update(JobPosting)
        .where(JobPosting.id == job_posting_id)
        .values(
            parsed_data=parsed_data,
            company_analysis=company_analysis,
        )
    )
    await db.commit()

    # Re-fetch to return updated object
    result = await db.execute(
        select(JobPosting).where(JobPosting.id == job_posting_id)
    )
    updated = result.scalar_one()

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
# Deep company research (Tavily + Claude)
# ---------------------------------------------------------------------------

async def deep_company_research(
    company: str, position: str, tech_stack: list[str]
) -> dict[str, Any]:
    """Perform deep company research using Tavily web search + Claude analysis."""
    search_results = await _search_company_info(company, position)
    if not search_results:
        raise ValueError("검색 결과를 가져올 수 없습니다")

    formatted_parts: list[str] = []
    for sr in search_results:
        items = "\n".join(
            f"- [{r['title']}]({r['url']})\n  {r['content']}"
            for r in sr.get("results", [])
        )
        answer_line = f"요약: {sr['answer']}\n" if sr.get("answer") else ""
        formatted_parts.append(
            f'### 검색: "{sr["query"]}"\n{answer_line}{items}'
        )
    formatted_results = "\n\n".join(formatted_parts)

    prompt = (
        DEEP_COMPANY_ANALYSIS_PROMPT.replace("{company}", company)
        .replace("{position}", position)
        .replace("{techStack}", ", ".join(tech_stack))
        .replace("{searchResults}", formatted_results)
    )

    raw = await call_llm_json(
        prompt,
        model=MODELS["ANALYSIS"],
        temperature=0.3,
    )
    if not isinstance(raw, dict):
        raise ValueError("심층 분석 결과를 생성할 수 없습니다")
    return raw


async def _search_company_info(
    company: str, position: str
) -> list[dict[str, Any]] | None:
    """Search company info via Tavily. Returns None if unavailable."""
    client = _get_tavily_client()
    if not client:
        return None

    queries = [
        f"{company} {position} 면접 후기 채용 기출문제",
        f"{company} interview {position} company culture products",
    ]

    import asyncio

    successful: list[dict[str, Any]] = []

    for query in queries:
        try:
            # Tavily client is sync; run in executor
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(
                None,
                lambda q=query: client.search(
                    q,
                    search_depth="basic",
                    max_results=5,
                    include_answer=True,
                ),
            )
            successful.append(
                {
                    "query": query,
                    "answer": getattr(response, "answer", None) or response.get("answer"),
                    "results": [
                        {
                            "title": r.get("title", "") if isinstance(r, dict) else getattr(r, "title", ""),
                            "url": r.get("url", "") if isinstance(r, dict) else getattr(r, "url", ""),
                            "content": r.get("content", "") if isinstance(r, dict) else getattr(r, "content", ""),
                        }
                        for r in (
                            response.get("results", [])
                            if isinstance(response, dict)
                            else getattr(response, "results", [])
                        )
                    ],
                }
            )
        except Exception:
            logger.warning("Tavily search failed for query: %s", query)

    return successful if successful else None


# ---------------------------------------------------------------------------
# Deep research orchestrator (DB + credits + Tavily + Claude)
# ---------------------------------------------------------------------------

async def do_deep_research(
    db: AsyncSession, posting_id: str, user_id: str
) -> dict[str, Any]:
    """Look up job posting, deduct credit, run deep research, persist results."""
    from app.services.credit import (
        deduct_for_feature,
        CREDIT_COSTS,
        InsufficientCreditsError,
    )

    # 1. Look up & verify ownership
    result = await db.execute(
        select(JobPosting).where(
            JobPosting.id == posting_id,
            JobPosting.user_id == user_id,
        )
    )
    jp = result.scalar_one_or_none()
    if not jp:
        raise ValueError("NOT_FOUND")

    # 2. Idempotency check — 이미 심층 분석 완료된 경우 재실행 방지
    if jp.company_analysis and jp.company_analysis.get("deepResearch"):
        return _serialize_job_posting(jp)

    # 2b. Tavily availability check
    if not tavily_available:
        raise ValueError("TAVILY_NOT_AVAILABLE")

    parsed = jp.parsed_data or {}
    company = parsed.get("company", "")
    position = parsed.get("position", "")
    tech_stack = parsed.get("techStack", [])

    # 3. Run deep research first (성공 후 크레딧 차감)
    research_data = await deep_company_research(company, position, tech_stack)

    # 4. Deduct credit after success
    try:
        await deduct_for_feature(
            db,
            user_id,
            posting_id,
            "심층 기업 분석",
            CREDIT_COSTS["DEEP_RESEARCH"],
        )
    except InsufficientCreditsError:
        raise ValueError("INSUFFICIENT_CREDITS")

    # 5. Merge into companyAnalysis and persist
    existing_analysis = jp.company_analysis or {}
    existing_analysis["deepResearch"] = research_data
    await db.execute(
        update(JobPosting)
        .where(JobPosting.id == posting_id)
        .values(company_analysis=existing_analysis)
    )
    await db.commit()

    # Re-fetch and return
    result = await db.execute(
        select(JobPosting).where(JobPosting.id == posting_id)
    )
    updated = result.scalar_one()
    return _serialize_job_posting(updated)


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
    company_analysis = jp.company_analysis or {}
    has_deep_research = bool(company_analysis.get("deepResearch"))
    return {
        "id": jp.id,
        "userId": jp.user_id,
        "rawText": jp.raw_text,
        "parsedData": jp.parsed_data,
        "companyAnalysis": company_analysis,
        "deepResearchAvailable": not has_deep_research,
        "createdAt": jp.created_at.isoformat() if jp.created_at else None,
        "updatedAt": jp.updated_at.isoformat() if jp.updated_at else None,
    }
