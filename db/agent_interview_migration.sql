-- 1. pgvector 확장 활성화
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 사용자 프로필 임베딩 테이블
CREATE TABLE user_profile_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    category VARCHAR(20) NOT NULL CHECK (category IN ('strength', 'weakness', 'pattern', 'context')),
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    "updatedAt" TIMESTAMP(3) DEFAULT NOW()
);

CREATE INDEX idx_user_profile_embeddings_user ON user_profile_embeddings ("userId");
CREATE INDEX idx_user_profile_embeddings_vector ON user_profile_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 3. 에이전트 면접 세션 테이블
CREATE TABLE agent_interview_sessions (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "resumeId" TEXT REFERENCES resumes(id) ON DELETE SET NULL,
    "jobPostingId" TEXT REFERENCES job_postings(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
    "totalQuestions" INTEGER DEFAULT 0,
    "maxQuestions" INTEGER DEFAULT 7,
    "overallScore" FLOAT,
    "reportData" JSONB,
    "textMode" BOOLEAN DEFAULT FALSE,
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    "updatedAt" TIMESTAMP(3) DEFAULT NOW()
);

CREATE INDEX idx_agent_sessions_user ON agent_interview_sessions ("userId");

-- 4. 에이전트 면접 메시지 테이블
CREATE TABLE agent_interview_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionId" TEXT NOT NULL REFERENCES agent_interview_sessions(id) ON DELETE CASCADE,
    "messageIndex" INTEGER NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('agent_question', 'user_answer', 'agent_evaluation', 'agent_followup')),
    content TEXT NOT NULL,
    evaluation JSONB,
    "questionNumber" INTEGER,
    "followUpRound" INTEGER DEFAULT 0,
    "audioUrl" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    UNIQUE ("sessionId", "messageIndex")
);

CREATE INDEX idx_agent_messages_session ON agent_interview_messages ("sessionId");
