"""run_fit_analysis는 skill_match + avoid_topics만 반환 (focus_topics 제거)."""
import pytest
from app.agent.interview.fit_analysis import run_fit_analysis


@pytest.mark.asyncio
async def test_no_focus_topics_in_result():
    """focus_topics가 결과에 포함되지 않아야 한다."""
    resume = {"skills": ["Python"]}
    jd = {"requiredSkills": ["Python"], "position": "Backend"}

    result = await run_fit_analysis(resume, jd)
    assert "focus_topics" not in result
    assert "skill_match" in result
    assert "avoid_topics" in result


@pytest.mark.asyncio
async def test_no_jd_returns_none_skill_match():
    resume = {"skills": ["Python"]}
    result = await run_fit_analysis(resume, None)
    assert result["skill_match"] is None
    assert "focus_topics" not in result
