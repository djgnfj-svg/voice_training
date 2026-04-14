-- Scan+Dive progress 정수 3개 직접 저장 (휴리스틱 제거)
ALTER TABLE agent_interview_sessions
  ADD COLUMN IF NOT EXISTS current_scan_idx INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_dive_idx INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_dive_depth INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scan_evaluations JSONB;
