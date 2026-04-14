-- 공고 분석 캐싱용 raw_text 해시 컬럼
-- 같은 유저가 같은 공고를 다시 넣으면 LLM 재호출 없이 즉시 반환
-- Spec: 공고 분석 캐싱 (2026-04-14)

ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS "rawTextHash" VARCHAR(64);

-- (userId, rawTextHash) 복합 인덱스로 per-user 캐시 조회 O(log n)
CREATE INDEX IF NOT EXISTS idx_job_posting_user_hash
    ON job_postings ("userId", "rawTextHash");

-- 기존 row는 rawTextHash=NULL. 다음 호출 시 hash 채워짐 (첫 호출만 LLM, 이후 캐시 hit).
