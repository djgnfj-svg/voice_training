from sqlalchemy import Column, String, DateTime, Integer, Boolean, JSON, Text, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class AnswerAssistSession(Base):
    __tablename__ = "answer_assist_sessions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    resume_id = Column("resumeId", String, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="answer_assist_sessions")
    resume = relationship("Resume", back_populates="answer_assist_sessions")
    items = relationship("AnswerAssistItem", back_populates="session", cascade="all, delete-orphan")


class AnswerAssistItem(Base):
    __tablename__ = "answer_assist_items"
    __table_args__ = (
        UniqueConstraint("sessionId", "questionIndex", name="answer_assist_items_sessionId_questionIndex_key"),
    )

    id = Column(String, primary_key=True)
    session_id = Column("sessionId", String, ForeignKey("answer_assist_sessions.id"), nullable=False)
    question_index = Column("questionIndex", Integer, nullable=False)
    question_text = Column("questionText", Text, nullable=False)
    conversation = Column(JSON, default=[])
    final_answer = Column("finalAnswer", Text, nullable=True)
    is_completed = Column("isCompleted", Boolean, default=False)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    session = relationship("AnswerAssistSession", back_populates="items")
