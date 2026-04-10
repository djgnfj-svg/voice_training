from __future__ import annotations

from sqlalchemy import Column, String, DateTime, Integer, Boolean, JSON, Text, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class LearningAgentSession(Base):
    __tablename__ = "learning_agent_sessions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    topic = Column(String, nullable=True)
    status = Column(String(20), nullable=False, default="active")
    llm_call_count = Column("llmCallCount", Integer, default=0)
    credit_deducted = Column("creditDeducted", Boolean, default=False)
    is_free_session = Column("isFreeSession", Boolean, default=False)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    messages = relationship("LearningAgentMessage", back_populates="session", cascade="all, delete-orphan")


class LearningAgentMessage(Base):
    __tablename__ = "learning_agent_messages"
    __table_args__ = (
        UniqueConstraint("sessionId", "messageIndex", name="learning_agent_messages_sessionId_messageIndex_key"),
    )

    id = Column(String, primary_key=True)
    session_id = Column("sessionId", String, ForeignKey("learning_agent_sessions.id", ondelete="CASCADE"), nullable=False)
    message_index = Column("messageIndex", Integer, nullable=False)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    phase = Column(String, nullable=True)
    assessment = Column(JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    session = relationship("LearningAgentSession", back_populates="messages")
