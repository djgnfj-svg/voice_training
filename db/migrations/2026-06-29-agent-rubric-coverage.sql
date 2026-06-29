-- 2026-06-29 AI 코치 면접: JD 루브릭 커버리지(C안) 재설계
-- additive only — Scan/Dive 2페이즈 폐기 후 단일 루브릭 커버리지 루프로 전환.
-- rubric_plan: RubricItem 리스트(JD 요구항목 + 이력서 근거 매칭).
-- coverage:    루브릭 항목별 검증 상태(covered/unverified) + depth 점수.
-- 기존 컬럼(scan_plan/dive_plan/scan_evaluations/current_*)은 파괴적 변경 없이 유지.
--   레거시 진행중 세션은 코드에서 rubric_plan IS NULL 감지 시 즉시 종료(abandon) 처리.
-- 멱등: ADD COLUMN IF NOT EXISTS. 공유 Supabase에는 이미 적용됨(이 파일은 repo 기록용).
ALTER TABLE agent_interview_sessions
    ADD COLUMN IF NOT EXISTS rubric_plan JSONB,
    ADD COLUMN IF NOT EXISTS coverage JSONB;
