from __future__ import annotations

from sqlalchemy import Column, String, DateTime, Integer, Float, Boolean, JSON, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class AgentInterviewSession(Base):
    __tablename__ = "agent_interview_sessions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    resume_id = Column("resumeId", String, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True)
    job_posting_id = Column("jobPostingId", String, ForeignKey("job_postings.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), nullable=False, default="in_progress")
    total_questions = Column("totalQuestions", Integer, default=0)
    max_questions = Column("maxQuestions", Integer, default=7)
    overall_score = Column("overallScore", Float, nullable=True)
    report_data = Column("reportData", JSON, nullable=True)
    credit_deducted = Column("creditDeducted", Boolean, default=False)
    text_mode = Column("textMode", Boolean, default=False)
    fit_analysis = Column("fit_analysis", JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    messages = relationship("AgentInterviewMessage", back_populates="session", cascade="all, delete-orphan")


class AgentInterviewMessage(Base):
    __tablename__ = "agent_interview_messages"
    __table_args__ = (
        UniqueConstraint("sessionId", "messageIndex", name="agent_messages_session_index_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)
    session_id = Column("sessionId", String, ForeignKey("agent_interview_sessions.id", ondelete="CASCADE"), nullable=False)
    message_index = Column("messageIndex", Integer, nullable=False)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    evaluation = Column(JSON, nullable=True)
    question_number = Column("questionNumber", Integer, nullable=True)
    follow_up_round = Column("followUpRound", Integer, default=0)
    audio_url = Column("audioUrl", String, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    session = relationship("AgentInterviewSession", back_populates="messages")
