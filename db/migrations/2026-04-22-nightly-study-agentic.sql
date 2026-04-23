-- Agentic LangGraph nightly-study additions.
-- Legacy tables were dropped in 2026-04-17-nightly-study-v2.sql; keep this migration additive.

CREATE TABLE IF NOT EXISTS learning_user_profiles (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_goal TEXT NULL,
    domain       TEXT NULL,
    strengths    JSONB NOT NULL DEFAULT '[]'::jsonb,
    weaknesses   JSONB NOT NULL DEFAULT '[]'::jsonb,
    preferences  JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary      TEXT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE learning_sessions
    ADD COLUMN IF NOT EXISTS session_intent TEXT NULL,
    ADD COLUMN IF NOT EXISTS target_node_id UUID NULL REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS graph_state JSONB NULL,
    ADD COLUMN IF NOT EXISTS langsmith_run_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS pending_action JSONB NULL;

CREATE INDEX IF NOT EXISTS learning_sessions_target_node
    ON learning_sessions(target_node_id);
