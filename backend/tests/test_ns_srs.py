from datetime import datetime, timezone, timedelta


from app.agent.learning_coach.spaced_repetition import (
    apply_proficiency_delta,
    compute_next_review,
    update_streak_state,
)


def test_proficiency_clamped_0_to_100():
    # clamp low
    assert apply_proficiency_delta(current=10, delta=-30) == 0
    # clamp high
    assert apply_proficiency_delta(current=90, delta=30) == 100
    # normal
    assert apply_proficiency_delta(current=50, delta=8) == 58


def test_next_review_proficiency_based():
    now = datetime(2026, 4, 17, 12, 0, 0, tzinfo=timezone.utc)
    # low proficiency → short interval (1 day)
    assert compute_next_review(proficiency=20, now=now) == now + timedelta(days=1)
    # mid → 3 days
    assert compute_next_review(proficiency=50, now=now) == now + timedelta(days=3)
    # high → 7 days
    assert compute_next_review(proficiency=75, now=now) == now + timedelta(days=7)
    # mastered → 14 days
    assert compute_next_review(proficiency=95, now=now) == now + timedelta(days=14)


def test_streak_increment_when_next_day():
    from datetime import date
    # yesterday → today: streak +1
    new_current, new_longest = update_streak_state(
        current=5, longest=10,
        last_date=date(2026, 4, 16),
        today=date(2026, 4, 17),
    )
    assert new_current == 6
    assert new_longest == 10


def test_streak_resets_when_gap():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=5, longest=10,
        last_date=date(2026, 4, 14),  # 3일 전
        today=date(2026, 4, 17),
    )
    assert new_current == 1
    assert new_longest == 10


def test_streak_beats_longest():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=10, longest=10,
        last_date=date(2026, 4, 16),
        today=date(2026, 4, 17),
    )
    assert new_current == 11
    assert new_longest == 11


def test_streak_same_day_no_change():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=5, longest=10,
        last_date=date(2026, 4, 17),
        today=date(2026, 4, 17),
    )
    assert new_current == 5
    assert new_longest == 10


def test_streak_first_ever():
    from datetime import date
    new_current, new_longest = update_streak_state(
        current=0, longest=0, last_date=None, today=date(2026, 4, 17)
    )
    assert new_current == 1
    assert new_longest == 1
