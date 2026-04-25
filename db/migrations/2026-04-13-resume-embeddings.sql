-- 이력서 RAG용 청크 임베딩 테이블
-- pgvector 확장은 user_profile_embeddings 마이그레이션에서 이미 활성화됨
-- Spec: docs/superpowers/specs/2026-04-13-resume-rag-design.md (D2)

CREATE TABLE IF NOT EXISTS resume_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "resumeId" TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    chunk_type VARCHAR(20) NOT NULL CHECK (chunk_type IN ('summary','project','experience','education')),
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    UNIQUE ("resumeId", chunk_type, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_resume_emb_resume ON resume_embeddings ("resumeId");
CREATE INDEX IF NOT EXISTS idx_resume_emb_user ON resume_embeddings ("userId");
CREATE INDEX IF NOT EXISTS idx_resume_emb_vec ON resume_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
