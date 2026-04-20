-- Pending action slot for session-level 2-turn protocols (e.g. goal_change confirm)
ALTER TABLE learning_sessions
  ADD COLUMN IF NOT EXISTS pending_action JSONB NULL;
