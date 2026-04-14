-- Scan+Dive 2페이즈 구조를 위한 세션 테이블 확장
ALTER TABLE agent_interview_sessions
  ADD COLUMN IF NOT EXISTS phase TEXT,
  ADD COLUMN IF NOT EXISTS scan_plan JSONB,
  ADD COLUMN IF NOT EXISTS dive_plan JSONB;
