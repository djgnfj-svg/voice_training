-- agent_interview_sessions에 fit_analysis JSONB 컬럼 추가
-- start 시점 산출된 Fit Analysis를 영속화하여 answer/skip 흐름에서 재사용 (Spec 4.2(b))
-- Spec: docs/superpowers/specs/2026-04-13-resume-rag-design.md

ALTER TABLE agent_interview_sessions
  ADD COLUMN IF NOT EXISTS fit_analysis JSONB;
