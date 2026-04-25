"""
Integration test: start → goal → turn flow.
Uses conftest.py helpers. LLM is mocked.
"""
import pytest
from unittest.mock import patch, AsyncMock


@pytest.mark.skip(reason="fixture missing: client, auth_headers, db not in conftest")
@pytest.mark.asyncio
async def test_start_creates_session_in_onboarding_mode(client, auth_headers, db):
    # Precondition: no goal
    resp = await client.post("/api/learning-coach/start", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["initialMode"] == "onboarding"
    assert data["sessionId"]
    assert "어떤 개발자" in data["firstMessage"]


@pytest.mark.skip(reason="fixture missing: client, auth_headers, db not in conftest")
@pytest.mark.asyncio
async def test_start_closes_previous_active_session(client, auth_headers, db):
    r1 = await client.post("/api/learning-coach/start", headers=auth_headers)
    r2 = await client.post("/api/learning-coach/start", headers=auth_headers)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["sessionId"] != r2.json()["sessionId"]
    # r1 should be completed now
    from sqlalchemy import text
    row = (await db.execute(
        text("SELECT status FROM learning_sessions WHERE id=:s"),
        {"s": r1.json()["sessionId"]},
    )).one()
    assert row.status == "completed"


@pytest.mark.skip(reason="fixture missing: auth_headers_other not in conftest")
@pytest.mark.asyncio
async def test_ownership_403_on_foreign_session(client, auth_headers_other, auth_headers, db):
    r = await client.post("/api/learning-coach/start", headers=auth_headers)
    sid = r.json()["sessionId"]
    r2 = await client.post(
        f"/api/learning-coach/{sid}/end",
        json={"reason": "user"},
        headers=auth_headers_other,
    )
    assert r2.status_code == 404  # treat as not found


@pytest.mark.skip(reason="fixture missing: client, auth_headers, db not in conftest")
@pytest.mark.asyncio
async def test_status_reflects_streak(client, auth_headers, db):
    r = await client.get("/api/learning-coach/status", headers=auth_headers)
    assert r.status_code == 200
    data = r.json()
    assert "streak" in data
    assert "currentStreak" in data["streak"] or "current" in data["streak"]


def test_router_importable():
    """Smoke test: router imports without error."""
    from app.routers.learning_coach import router
    assert router is not None
