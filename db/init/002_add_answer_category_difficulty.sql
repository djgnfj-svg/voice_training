-- Add category and difficulty columns to interview_answers
ALTER TABLE "interview_answers" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "interview_answers" ADD COLUMN IF NOT EXISTS "difficulty" TEXT;
