from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.lib.transcript import count_filler_words
from app.models.interview import InterviewSession, InterviewAnswer, JobPosting


def _get_grade(score: int) -> str:
    if score >= 90:
        return "A+"
    if score >= 85:
        return "A"
    if score >= 80:
        return "B+"
    if score >= 75:
        return "B"
    if score >= 70:
        return "C+"
    if score >= 65:
        return "C"
    if score >= 60:
        return "D"
    return "F"


async def generate_report(
    db: AsyncSession, *, session_id: str, user_id: str | None = None
) -> dict[str, Any]:
    """
    Aggregate session data, calculate scores, build and save report.
    Mostly DB aggregation + math, not AI.
    """
    # Fetch session with answers and job posting
    conditions = [InterviewSession.id == session_id]
    if user_id:
        conditions.append(InterviewSession.user_id == user_id)

    result = await db.execute(
        select(InterviewSession)
        .options(
            selectinload(InterviewSession.answers),
            selectinload(InterviewSession.job_posting),
        )
        .where(*conditions)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise ValueError("Session not found")

    # Sort answers by question_index
    all_answers = sorted(session.answers, key=lambda a: a.question_index)

    # Filter answered (non-skipped) questions
    answered = [
        a for a in all_answers
        if a.answer_transcript and a.answer_transcript != "(건너뜀)"
    ]

    # -----------------------------------------------------------------------
    # Overall score
    # -----------------------------------------------------------------------
    scores = [a.overall_score for a in answered if a.overall_score is not None]
    overall_score = round(sum(scores) / len(scores)) if scores else 0

    # -----------------------------------------------------------------------
    # Category scores (average per question source)
    # -----------------------------------------------------------------------
    category_sums: dict[str, float] = {}
    category_counts: dict[str, int] = {}
    for a in answered:
        source = a.question_source or "general"
        category_sums.setdefault(source, 0.0)
        category_counts.setdefault(source, 0)
        category_sums[source] += a.overall_score or 0
        category_counts[source] += 1

    category_scores: dict[str, int] = {}
    for source in category_sums:
        category_scores[source] = round(category_sums[source] / category_counts[source])

    # -----------------------------------------------------------------------
    # Strengths and improvements
    # -----------------------------------------------------------------------
    sorted_answers = sorted(answered, key=lambda a: (a.overall_score or 0), reverse=True)
    strengths = [a.brief_feedback or "" for a in sorted_answers[:3]]
    improvements = [a.brief_feedback or "" for a in sorted_answers[-3:][::-1]]

    # -----------------------------------------------------------------------
    # Speech analysis
    # -----------------------------------------------------------------------
    response_times = [a.response_time_sec for a in answered if a.response_time_sec is not None]
    avg_response_time = (
        round(sum(response_times) / len(response_times)) if response_times else 0
    )

    # Filler word count
    total_filler_words = sum(
        count_filler_words(a.answer_transcript or "") for a in answered
    )

    # WPM-based speech rate: Korean characters / response time
    _strip_re = re.compile(r"[\s.,!?;:'\"()\-]")
    wpm_values: list[float] = []
    for a in answered:
        if a.response_time_sec and a.response_time_sec > 0 and a.answer_transcript:
            char_count = len(_strip_re.sub("", a.answer_transcript))
            minutes = a.response_time_sec / 60
            if minutes > 0:
                wpm_values.append(char_count / minutes)

    average_wpm = round(sum(wpm_values) / len(wpm_values)) if wpm_values else 0

    if average_wpm < 200:
        speech_rate_label = "느림"
    elif average_wpm > 350:
        speech_rate_label = "빠름"
    else:
        speech_rate_label = "적정"

    speech_analysis: dict[str, Any] = {
        "averageResponseTime": avg_response_time,
        "fillerWordCount": total_filler_words,
        "speechRate": speech_rate_label,
    }
    if average_wpm:
        speech_analysis["averageWpm"] = average_wpm

    # -----------------------------------------------------------------------
    # Gap analysis (if job posting exists)
    # -----------------------------------------------------------------------
    gap_analysis: dict[str, Any] | None = None
    matching_score: int | None = None

    job_posting = session.job_posting
    if job_posting and job_posting.parsed_data:
        parsed_data = job_posting.parsed_data
        tech_stack: list[str] = parsed_data.get("techStack", []) if isinstance(parsed_data, dict) else []
        answered_topics = [a.question_text.lower() for a in answered]

        covered_skills = [
            skill
            for skill in tech_stack
            if any(skill.lower() in t for t in answered_topics)
        ]

        matching_score = (
            round((len(covered_skills) / len(tech_stack)) * 100)
            if tech_stack
            else None
        )

        gap_analysis = {
            "missingSkills": [s for s in tech_stack if s not in covered_skills],
            "weakAreas": [
                a.question_text[:50]
                for a in sorted_answers
                if (a.overall_score or 0) < 60
            ],
            "suggestions": [],
            "coveragePercentage": matching_score or 0,
        }

    # -----------------------------------------------------------------------
    # Build answer reports
    # -----------------------------------------------------------------------
    answer_reports: list[dict[str, Any]] = []
    for a in all_answers:
        default_scores = {
            "accuracy": 0,
            "depth": 0,
            "clarity": 0,
            "completeness": 0,
            "practicality": 0,
        }
        report_item: dict[str, Any] = {
            "questionIndex": a.question_index,
            "questionText": a.question_text,
            "questionSource": a.question_source,
            "answerTranscript": a.answer_transcript or "",
            "scores": a.scores if a.scores else default_scores,
            "overallScore": a.overall_score or 0,
            "briefFeedback": a.brief_feedback or "",
            "detailedFeedback": a.detailed_feedback or "",
            "modelAnswer": a.model_answer or "",
        }
        if a.response_time_sec is not None:
            report_item["responseTimeSec"] = a.response_time_sec
        if a.follow_up_question:
            report_item["followUpQuestion"] = a.follow_up_question
        if a.audio_url:
            report_item["audioUrl"] = a.audio_url
        answer_reports.append(report_item)

    # -----------------------------------------------------------------------
    # Build final report
    # -----------------------------------------------------------------------
    report: dict[str, Any] = {
        "sessionId": session_id,
        "overallScore": overall_score,
        "grade": _get_grade(overall_score),
        "categoryScores": category_scores,
        "strengths": [s for s in strengths if s],
        "improvements": [i for i in improvements if i],
        "answers": answer_reports,
        "speechAnalysis": speech_analysis,
    }
    if matching_score is not None:
        report["matchingScore"] = matching_score
    if gap_analysis is not None:
        report["gapAnalysis"] = gap_analysis

    # -----------------------------------------------------------------------
    # Save report to session
    # -----------------------------------------------------------------------
    await db.execute(
        update(InterviewSession)
        .where(InterviewSession.id == session_id)
        .values(
            overall_score=overall_score,
            matching_score=matching_score,
            gap_analysis=gap_analysis,
            report_data=report,
        )
    )
    await db.commit()

    return report
