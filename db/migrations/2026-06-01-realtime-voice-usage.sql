-- Realtime voice (Learning Coach) per-day usage accounting.
-- Tracks accumulated full-duplex voice seconds per user per KST day so the
-- relay can enforce the daily cap (REALTIME_DAILY_MAX_SEC) and record usage on
-- session close. Additive only; touches no existing learning-coach tables.

CREATE TABLE IF NOT EXISTS realtime_voice_usage (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kst_date     DATE NOT NULL,
    seconds_used INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, kst_date)
);

CREATE INDEX IF NOT EXISTS realtime_voice_usage_user
    ON realtime_voice_usage(user_id);
