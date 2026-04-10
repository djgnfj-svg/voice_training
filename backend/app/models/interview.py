from sqlalchemy import Column, String, DateTime, Integer, Float, Boolean, JSON, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base
from app.models.enums import PgInterviewType, PgDifficulty, PgSessionStatus, InterviewType, Difficulty, SessionStatus


class JobPosting(Base):
    __tablename__ = "job_postings"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    raw_text = Column("rawText", Text, nullable=False)
    parsed_data = Column("parsedData", JSON, nullable=True)
    company_analysis = Column("companyAnalysis", JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="job_postings")
    interview_sessions = relationship("InterviewSession", back_populates="job_posting")


class InterviewSession(Base):
    __tablename__ = "interview_sessions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    job_posting_id = Column("jobPostingId", String, ForeignKey("job_postings.id"), nullable=True)
    resume_id = Column("resumeId", String, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True)
    type = Column(PgInterviewType, nullable=False, default=InterviewType.TECHNICAL)
    categories = Column(ARRAY(String), nullable=True)
    difficulty = Column(PgDifficulty, nullable=False, default=Difficulty.INTERMEDIATE)
    status = Column(PgSessionStatus, nullable=False, default=SessionStatus.IN_PROGRESS)
    overall_score = Column("overallScore", Float, nullable=True)
    matching_score = Column("matchingScore", Float, nullable=True)
    gap_analysis = Column("gapAnalysis", JSON, nullable=True)
    report_data = Column("reportData", JSON, nullable=True)
    duration_seconds = Column("durationSeconds", Integer, nullable=True)
    total_questions = Column("totalQuestions", Integer, default=5)
    credit_deducted = Column("creditDeducted", Boolean, default=False)
    text_mode = Column("textMode", Boolean, default=False)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="interview_sessions")
    job_posting = relationship("JobPosting", back_populates="interview_sessions")
    resume = relationship("Resume", back_populates="interview_sessions")
    answers = relationship("InterviewAnswer", back_populates="session", cascade="all, delete-orphan")


class InterviewAnswer(Base):
    __tablename__ = "interview_answers"
    __table_args__ = (
        UniqueConstraint("sessionId", "questionIndex", name="interview_answers_sessionId_questionIndex_key"),
    )

    id = Column(String, primary_key=True)
    session_id = Column("sessionId", String, ForeignKey("interview_sessions.id"), nullable=False)
    question_index = Column("questionIndex", Integer, nullable=False)
    question_text = Column("questionText", Text, nullable=False)
    question_source = Column("questionSource", String, default="general")
    category = Column(String, nullable=True)
    difficulty = Column(String, nullable=True)
    answer_transcript = Column("answerTranscript", Text, nullable=True)
    audio_url = Column("audioUrl", String, nullable=True)
    scores = Column(JSON, nullable=True)
    overall_score = Column("overallScore", Float, nullable=True)
    brief_feedback = Column("briefFeedback", Text, nullable=True)
    detailed_feedback = Column("detailedFeedback", Text, nullable=True)
    model_answer = Column("modelAnswer", Text, nullable=True)
    follow_up_question = Column("followUpQuestion", Text, nullable=True)
    response_time_sec = Column("responseTimeSec", Integer, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    session = relationship("InterviewSession", back_populates="answers")


class QuestionBank(Base):
    __tablename__ = "question_bank"

    id = Column(String, primary_key=True)
    category = Column(String, nullable=False)
    subcategory = Column(String, nullable=False)
    difficulty = Column(PgDifficulty, nullable=False, default=Difficulty.INTERMEDIATE)
    question_text = Column("questionText", Text, nullable=False)
    key_points = Column("keyPoints", ARRAY(String), nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
