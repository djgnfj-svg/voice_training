from sqlalchemy import Column, String, DateTime, Integer, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True)
    email = Column(String, unique=True, nullable=False)
    email_verified = Column("emailVerified", DateTime, nullable=True)
    name = Column(String, nullable=True)
    image = Column(String, nullable=True)
    hashed_password = Column("hashedPassword", String, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    accounts = relationship("Account", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("AuthSession", back_populates="user", cascade="all, delete-orphan")
    resumes = relationship("Resume", back_populates="user", cascade="all, delete-orphan")
    job_postings = relationship("JobPosting", back_populates="user", cascade="all, delete-orphan")
    interview_sessions = relationship("InterviewSession", back_populates="user", cascade="all, delete-orphan")
    activity_logs = relationship("ActivityLog", back_populates="user", cascade="all, delete-orphan")
    answer_assist_sessions = relationship("AnswerAssistSession", back_populates="user", cascade="all, delete-orphan")


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("provider", "providerAccountId", name="accounts_provider_providerAccountId_key"),
    )

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    type = Column(String, nullable=False)
    provider = Column(String, nullable=False)
    provider_account_id = Column("providerAccountId", String, nullable=False)
    refresh_token = Column("refresh_token", String, nullable=True)
    access_token = Column("access_token", String, nullable=True)
    expires_at = Column("expires_at", Integer, nullable=True)
    token_type = Column("token_type", String, nullable=True)
    scope = Column(String, nullable=True)
    id_token = Column("id_token", String, nullable=True)
    session_state = Column("session_state", String, nullable=True)

    user = relationship("User", back_populates="accounts")


class AuthSession(Base):
    """Named AuthSession to avoid conflict with SQLAlchemy Session."""
    __tablename__ = "sessions"

    id = Column(String, primary_key=True)
    session_token = Column("sessionToken", String, unique=True, nullable=False)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    expires = Column(DateTime, nullable=False)

    user = relationship("User", back_populates="sessions")
