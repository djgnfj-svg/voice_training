# backend/app/models/journal.py
from __future__ import annotations

from sqlalchemy import Column, String, DateTime, Integer, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class JournalSession(Base):
    __tablename__ = "journal_sessions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status = Column(String(20), nullable=False, default="active")
    message_count = Column("messageCount", Integer, default=0)
    free_messages_used = Column("freeMessagesUsed", Integer, default=0)
    credits_charged = Column("creditsCharged", Integer, default=0)
    summary = Column(Text, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    messages = relationship("JournalMessage", back_populates="session", cascade="all, delete-orphan")


class JournalMessage(Base):
    __tablename__ = "journal_messages"
    __table_args__ = (
        UniqueConstraint("sessionId", "messageIndex", name="journal_messages_session_index_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)
    session_id = Column("sessionId", String, ForeignKey("journal_sessions.id", ondelete="CASCADE"), nullable=False)
    message_index = Column("messageIndex", Integer, nullable=False)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    mode = Column(String(20), nullable=False, default="journal")
    created_at = Column("createdAt", DateTime, server_default=func.now())

    session = relationship("JournalSession", back_populates="messages")
