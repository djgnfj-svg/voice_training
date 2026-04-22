-- 기존 오늘의 학습 테이블 전부 DROP
DROP TABLE IF EXISTS daily_progress CASCADE;
DROP TABLE IF EXISTS user_knowledge CASCADE;
DROP TABLE IF EXISTS "LearningAgentMessage" CASCADE;
DROP TABLE IF EXISTS "LearningAgentSession" CASCADE;
DROP TABLE IF EXISTS learning_agent_messages CASCADE;
DROP TABLE IF EXISTS learning_agent_sessions CASCADE;
DROP TABLE IF EXISTS topics CASCADE;
DROP TABLE IF EXISTS subjects CASCADE;

-- pgvector 확장 (이미 있으면 무시)
CREATE EXTENSION IF NOT EXISTS vector;

-- ① learning_goals
CREATE TABLE learning_goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    normalized_goal TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX learning_goals_active_per_user
    ON learning_goals(user_id) WHERE status = 'active';
CREATE INDEX learning_goals_user_id ON learning_goals(user_id);

-- ② curriculum_nodes
CREATE TABLE curriculum_nodes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id       UUID NOT NULL REFERENCES learning_goals(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL,
    depth_level   INT NOT NULL CHECK (depth_level BETWEEN 0 AND 2),
    parent_id     UUID NULL REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
    source        TEXT NOT NULL CHECK (source IN ('seed', 'extended')),
    keywords      TEXT[] NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX curriculum_nodes_goal_id ON curriculum_nodes(goal_id);
CREATE INDEX curriculum_nodes_parent_id ON curriculum_nodes(parent_id);

-- ③ node_mastery
CREATE TABLE node_mastery (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id         UUID NOT NULL REFERENCES curriculum_nodes(id) ON DELETE CASCADE,
    proficiency     INT NOT NULL DEFAULT 0 CHECK (proficiency BETWEEN 0 AND 100),
    success_count   INT NOT NULL DEFAULT 0,
    failure_count   INT NOT NULL DEFAULT 0,
    streak_count    INT NOT NULL DEFAULT 0,
    last_studied_at TIMESTAMPTZ NULL,
    next_review_at  TIMESTAMPTZ NULL,
    last_mode       TEXT NULL,
    PRIMARY KEY (user_id, node_id)
);
CREATE INDEX node_mastery_next_review ON node_mastery(user_id, next_review_at);

-- ④ learning_sessions
CREATE TABLE learning_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id         UUID NULL REFERENCES learning_goals(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ NULL,
    turn_count      INT NOT NULL DEFAULT 0,
    is_free_session BOOL NOT NULL DEFAULT FALSE,
    summary         TEXT NULL,
    highlights      JSONB NULL,
    voice_briefing  TEXT NULL
);
CREATE INDEX learning_sessions_user_status ON learning_sessions(user_id, status);
CREATE INDEX learning_sessions_user_started ON learning_sessions(user_id, started_at);

-- ⑤ learning_messages
CREATE TABLE learning_messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
    message_index INT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content       TEXT NOT NULL,
    mode          TEXT NULL,
    tool_calls    JSONB NULL,
    node_id       UUID NULL REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, message_index)
);
CREATE INDEX learning_messages_session ON learning_messages(session_id, message_index);

-- ⑥ learning_embeddings
CREATE TABLE learning_embeddings (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id    UUID NULL REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
    category   TEXT NOT NULL CHECK (category IN ('misconception', 'explanation', 'connection', 'question')),
    content    TEXT NOT NULL,
    embedding  VECTOR(1536) NOT NULL,
    metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX learning_embeddings_user ON learning_embeddings(user_id);
CREATE INDEX learning_embeddings_ivfflat ON learning_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ⑦ learning_streaks
CREATE TABLE learning_streaks (
    user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak       INT NOT NULL DEFAULT 0,
    longest_streak       INT NOT NULL DEFAULT 0,
    total_sessions       INT NOT NULL DEFAULT 0,
    total_nodes_learned  INT NOT NULL DEFAULT 0,
    last_session_date    DATE NULL
);
