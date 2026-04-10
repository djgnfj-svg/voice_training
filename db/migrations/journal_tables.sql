-- db/migrations/journal_tables.sql

-- Journal Sessions
CREATE TABLE IF NOT EXISTS journal_sessions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "freeMessagesUsed" INTEGER NOT NULL DEFAULT 0,
    "creditsCharged" INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_journal_sessions_user_status ON journal_sessions("userId", status);
CREATE INDEX idx_journal_sessions_user_date ON journal_sessions("userId", "createdAt");

-- Journal Messages
CREATE TABLE IF NOT EXISTS journal_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionId" TEXT NOT NULL REFERENCES journal_sessions(id) ON DELETE CASCADE,
    "messageIndex" INTEGER NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    mode VARCHAR(20) NOT NULL DEFAULT 'journal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("sessionId", "messageIndex")
);

-- Journal Embeddings (separate from user_profile_embeddings)
CREATE TABLE IF NOT EXISTS journal_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_journal_embeddings_user ON journal_embeddings("userId");
CREATE INDEX idx_journal_embeddings_user_category ON journal_embeddings("userId", category);
