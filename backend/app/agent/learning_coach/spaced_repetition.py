from __future__ import annotations

from datetime import datetime, date, timedelta


def apply_proficiency_delta(current: int, delta: int) -> int:
    """Apply delta and clamp to [0, 100]."""
    return max(0, min(100, current + delta))


def compute_next_review(proficiency: int, now: datetime) -> datetime:
    """Proficiency-based interval: low means soon, high means later."""
    if proficiency < 30:
        days = 1
    elif proficiency < 70:
        days = 3
    elif proficiency < 90:
        days = 7
    else:
        days = 14
    return now + timedelta(days=days)


def update_streak_state(
    current: int,
    longest: int,
    last_date: date | None,
    today: date,
) -> tuple[int, int]:
    """
    Returns (new_current, new_longest).
    Rules:
      - first ever (last_date=None): current=1
      - same day: no change
      - exactly +1 day: current += 1
      - gap >= 2: current = 1
    """
    if last_date is None:
        new_current = 1
    elif last_date == today:
        return current, longest
    elif last_date == today - timedelta(days=1):
        new_current = current + 1
    else:
        new_current = 1

    new_longest = max(longest, new_current)
    return new_current, new_longest
