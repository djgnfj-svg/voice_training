from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.lib.anthropic_client import call_llm_json, MODELS
from app.models.interview import InterviewSession, JobPosting
from app.models.resume import Resume
from app.prompts.question_generation import (
    QUESTION_GENERATION_PROMPT,
    GENERAL_QUESTION_PROMPT,
    INTERVIEW_PLAN_PROMPT,
    RESUME_ONLY_PLAN_PROMPT,
    RESUME_ONLY_QUESTION_PROMPT,
    DEEP_INTERVIEW_PLAN_PROMPT,
    DEEP_INTERVIEW_QUESTION_PROMPT,
)
from app.services.matching import analyze_match

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Question bank loading (optional — graceful skip if files missing)
# ---------------------------------------------------------------------------
_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "questions"

_BANK_FILES = [
    "cs-basics.json",
    "javascript.json",
    "react.json",
    "nextjs.json",
    "typescript-advanced.json",
    "database-advanced.json",
    "devops.json",
]


def _load_question_banks() -> list[dict]:
    banks: list[dict] = []
    for fname in _BANK_FILES:
        fpath = _DATA_DIR / fname
        if fpath.exists():
            try:
                with open(fpath, encoding="utf-8") as f:
                    banks.append(json.load(f))
            except Exception:
                logger.warning("Failed to load question bank %s", fname)
    return banks


ALL_QUESTION_BANKS: list[dict] = _load_question_banks()


# ---------------------------------------------------------------------------
# Bank matching
# ---------------------------------------------------------------------------

def match_bank_topics(skills: list[str], difficulty: str) -> list[dict]:
    """Match question bank topics based on skills and difficulty."""
    normalized_skills = [s.lower() for s in skills]
    min_difficulty = (
        ["ADVANCED"] if difficulty == "ADVANCED" else ["INTERMEDIATE", "ADVANCED"]
    )

    matched: list[dict] = []

    for bank in ALL_QUESTION_BANKS:
        for q in bank.get("questions", []):
            if q.get("difficulty") not in min_difficulty:
                continue
            subcat_lower = q.get("subcategory", "").lower()
            is_match = any(
                subcat_lower in skill or skill in subcat_lower
                for skill in normalized_skills
            )
            if is_match:
                matched.append(q)

    return matched[:15]


# ---------------------------------------------------------------------------
# Plan interview
# ---------------------------------------------------------------------------

async def plan_interview(
    db: AsyncSession,
    *,
    resume_id: str,
    user_id: str,
    job_posting_id: str | None = None,
    deep_mode: bool = False,
) -> dict[str, Any]:
    """AI plans interview setup based on resume + optional job posting."""
    # Fetch resume
    result = await db.execute(
        select(Resume).where(Resume.id == resume_id, Resume.user_id == user_id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise ValueError("Resume not found")

    parsed_resume = resume.parsed_data

    if deep_mode:
        return await _plan_deep_interview(parsed_resume)

    if job_posting_id:
        return await _plan_with_job_posting(db, job_posting_id, parsed_resume, user_id)

    return await _plan_with_resume_only(parsed_resume)


async def _plan_with_job_posting(
    db: AsyncSession, job_posting_id: str, parsed_resume: dict | None, user_id: str | None = None
) -> dict[str, Any]:
    query = select(JobPosting).where(JobPosting.id == job_posting_id)
    if user_id is not None:
        query = query.where(JobPosting.user_id == user_id)
    result = await db.execute(query)
    job_posting = result.scalar_one_or_none()
    if not job_posting:
        raise ValueError("Job posting not found")

    parsed_job_posting = job_posting.parsed_data
    company_analysis = job_posting.company_analysis

    matching_analysis = None
    if parsed_resume and parsed_job_posting:
        matching_analysis = await analyze_match(parsed_job_posting, parsed_resume)

    prompt = (
        INTERVIEW_PLAN_PROMPT.replace(
            "{parsedJobPosting}", json.dumps(parsed_job_posting, ensure_ascii=False, indent=2)
        )
        .replace(
            "{companyAnalysis}",
            json.dumps(company_analysis, ensure_ascii=False, indent=2) if company_analysis else "회사 분석 없음",
        )
        .replace(
            "{parsedResume}",
            json.dumps(parsed_resume, ensure_ascii=False, indent=2) if parsed_resume else "이력서 없음",
        )
        .replace(
            "{matchingAnalysis}",
            json.dumps(matching_analysis, ensure_ascii=False, indent=2) if matching_analysis else "매칭 분석 없음",
        )
    )

    return await _call_plan_api(prompt)


async def _plan_with_resume_only(parsed_resume: dict | None) -> dict[str, Any]:
    if not parsed_resume:
        raise ValueError("Resume has no parsed data")

    prompt = RESUME_ONLY_PLAN_PROMPT.replace(
        "{parsedResume}", json.dumps(parsed_resume, ensure_ascii=False, indent=2)
    )
    return await _call_plan_api(prompt)


async def _plan_deep_interview(parsed_resume: dict | None) -> dict[str, Any]:
    if not parsed_resume:
        raise ValueError("Resume has no parsed data")

    prompt = DEEP_INTERVIEW_PLAN_PROMPT.replace(
        "{parsedResume}", json.dumps(parsed_resume, ensure_ascii=False, indent=2)
    )
    return await _call_plan_api(prompt, deep_mode=True)


async def _call_plan_api(prompt: str, deep_mode: bool = False) -> dict[str, Any]:
    raw = await call_llm_json(
        prompt,
        model=MODELS["ANALYSIS"],
        temperature=0.3,
    )
    plan = raw if isinstance(raw, dict) else {}

    max_questions = 5 if deep_mode else 15
    default_questions = 4 if deep_mode else 5

    total = plan.get("totalQuestions", default_questions)
    total = min(max(total, 3), max_questions)

    return {
        "type": plan.get("type", "TECHNICAL"),
        "categories": plan.get("categories", ["general"]),
        "difficulty": plan.get("difficulty", "INTERMEDIATE"),
        "totalQuestions": total,
        "reasoning": plan.get("reasoning", ""),
        "focusAreas": plan.get("focusAreas"),
    }


# ---------------------------------------------------------------------------
# Generate questions
# ---------------------------------------------------------------------------

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
    """Generate interview questions based on plan parameters."""
    # Fetch resume
    result = await db.execute(
        select(Resume).where(Resume.id == resume_id, Resume.user_id == user_id)
    )
    resume = result.scalar_one_or_none()
    parsed_resume = resume.parsed_data if resume else None

    if deep_mode and parsed_resume:
        return await _generate_deep_questions(
            categories=categories,
            difficulty=difficulty,
            total_questions=total_questions,
            parsed_resume=parsed_resume,
        )

    if job_posting_id:
        return await _generate_tailored_questions(
            db,
            type_=type_,
            categories=categories,
            difficulty=difficulty,
            total_questions=total_questions,
            job_posting_id=job_posting_id,
            parsed_resume=parsed_resume,
            user_id=user_id,
        )

    if parsed_resume:
        return await _generate_resume_based_questions(
            type_=type_,
            categories=categories,
            difficulty=difficulty,
            total_questions=total_questions,
            parsed_resume=parsed_resume,
        )

    return await _generate_general_questions(
        type_=type_,
        categories=categories,
        difficulty=difficulty,
        total_questions=total_questions,
    )


async def _generate_tailored_questions(
    db: AsyncSession,
    *,
    type_: str,
    categories: list[str],
    difficulty: str,
    total_questions: int,
    job_posting_id: str,
    parsed_resume: dict | None,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    query = select(JobPosting).where(JobPosting.id == job_posting_id)
    if user_id is not None:
        query = query.where(JobPosting.user_id == user_id)
    result = await db.execute(query)
    job_posting = result.scalar_one_or_none()
    if not job_posting:
        raise ValueError("Job posting not found")

    parsed_job_posting = job_posting.parsed_data
    company_analysis = job_posting.company_analysis

    matching_analysis = None
    if parsed_resume and parsed_job_posting:
        matching_analysis = await analyze_match(parsed_job_posting, parsed_resume)

    prompt = (
        QUESTION_GENERATION_PROMPT.replace("{interviewType}", type_)
        .replace("{categories}", ", ".join(categories))
        .replace("{difficulty}", difficulty)
        .replace("{totalQuestions}", str(total_questions))
        .replace(
            "{parsedJobPosting}",
            json.dumps(parsed_job_posting, ensure_ascii=False, indent=2),
        )
        .replace(
            "{parsedResume}",
            json.dumps(parsed_resume, ensure_ascii=False, indent=2) if parsed_resume else "이력서 없음",
        )
        .replace(
            "{matchingAnalysis}",
            json.dumps(matching_analysis, ensure_ascii=False, indent=2) if matching_analysis else "매칭 분석 없음",
        )
        .replace(
            "{companyAnalysis}",
            json.dumps(company_analysis, ensure_ascii=False, indent=2) if company_analysis else "회사 분석 없음",
        )
    )

    return await _call_question_api(prompt, categories, difficulty)


async def _generate_resume_based_questions(
    *,
    type_: str,
    categories: list[str],
    difficulty: str,
    total_questions: int,
    parsed_resume: dict,
) -> list[dict[str, Any]]:
    prompt = (
        RESUME_ONLY_QUESTION_PROMPT.replace("{interviewType}", type_)
        .replace("{categories}", ", ".join(categories))
        .replace("{difficulty}", difficulty)
        .replace("{totalQuestions}", str(total_questions))
        .replace(
            "{parsedResume}",
            json.dumps(parsed_resume, ensure_ascii=False, indent=2),
        )
    )
    return await _call_question_api(prompt, categories, difficulty)


async def _generate_general_questions(
    *,
    type_: str,
    categories: list[str],
    difficulty: str,
    total_questions: int,
) -> list[dict[str, Any]]:
    prompt = (
        GENERAL_QUESTION_PROMPT.replace("{interviewType}", type_)
        .replace("{categories}", ", ".join(categories))
        .replace("{difficulty}", difficulty)
        .replace("{totalQuestions}", str(total_questions))
    )
    questions = await _call_question_api(prompt, categories, difficulty)
    for q in questions:
        q["source"] = "general"
    return questions


async def _generate_deep_questions(
    *,
    categories: list[str],
    difficulty: str,
    total_questions: int,
    parsed_resume: dict,
) -> list[dict[str, Any]]:
    # Extract skills from resume
    skills = list(parsed_resume.get("skills", []))
    for project in parsed_resume.get("projects", []):
        skills.extend(project.get("techStack", []))
    unique_skills = list(set(skills))

    # Match question bank topics
    matched_topics = match_bank_topics(unique_skills, difficulty)

    if matched_topics:
        matched_topics_str = "\n".join(
            f"- [{t.get('subcategory', '')}/{t.get('difficulty', '')}] {t.get('questionText', '')}\n"
            f"  핵심포인트: {', '.join(t.get('keyPoints', []))}"
            + (
                f"\n  심화주제: {', '.join(t.get('deepDiveTopics', []))}"
                if t.get("deepDiveTopics")
                else ""
            )
            for t in matched_topics
        )
    else:
        matched_topics_str = "(매칭된 주제 없음 — 이력서 기반으로 자유롭게 생성)"

    prompt = (
        DEEP_INTERVIEW_QUESTION_PROMPT.replace("{matchedTopics}", matched_topics_str)
        .replace("{categories}", ", ".join(categories))
        .replace("{difficulty}", difficulty)
        .replace("{totalQuestions}", str(total_questions))
        .replace(
            "{parsedResume}",
            json.dumps(parsed_resume, ensure_ascii=False, indent=2),
        )
    )

    return await _call_question_api(prompt, categories, difficulty, deep_mode=True)


async def _call_question_api(
    prompt: str,
    categories: list[str],
    difficulty: str,
    deep_mode: bool = False,
    default_source: str | None = None,
) -> list[dict[str, Any]]:
    raw = await call_llm_json(
        prompt,
        model=MODELS["QUESTION_GEN"],
        temperature=0.7,
    )

    questions = raw if isinstance(raw, list) else raw.get("questions", []) if isinstance(raw, dict) else []

    result: list[dict[str, Any]] = []
    for index, q in enumerate(questions):
        item: dict[str, Any] = {
            "index": index,
            "text": q.get("text", ""),
            "source": q.get("source") or default_source or ("deep_technical" if deep_mode else "general"),
            "category": q.get("category") or (categories[0] if categories else "general"),
            "difficulty": q.get("difficulty") or difficulty,
        }
        if deep_mode and q.get("relatedKeyPoints"):
            item["relatedKeyPoints"] = q["relatedKeyPoints"]
        result.append(item)

    return result
