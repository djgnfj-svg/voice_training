from sqlalchemy import Column, String, DateTime, Date, Integer, Boolean, JSON, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base
from app.models.enums import PgDifficulty


class Subject(Base):
    __tablename__ = "subjects"

    id = Column(String, primary_key=True)
    slug = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=False)
    name_en = Column("nameEn", String, nullable=True)
    description = Column(Text, nullable=True)
    icon = Column(String, nullable=True)
    is_system = Column("isSystem", Boolean, default=False)
    created_by = Column("createdBy", String, nullable=True)
    parent_id = Column("parentId", String, ForeignKey("subjects.id"), nullable=True)
    metadata_ = Column("metadata", JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    parent = relationship("Subject", remote_side="Subject.id", back_populates="children")
    children = relationship("Subject", back_populates="parent")
    topics = relationship("Topic", back_populates="subject", cascade="all, delete-orphan")


class Topic(Base):
    __tablename__ = "topics"

    id = Column(String, primary_key=True)
    subject_id = Column("subjectId", String, ForeignKey("subjects.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    difficulty = Column(PgDifficulty, nullable=False, default="INTERMEDIATE")
    key_points = Column("keyPoints", ARRAY(String), nullable=True)
    metadata_ = Column("metadata", JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    subject = relationship("Subject", back_populates="topics")
    user_knowledge = relationship("UserKnowledge", back_populates="topic", cascade="all, delete-orphan")


class UserKnowledge(Base):
    __tablename__ = "user_knowledge"
    __table_args__ = (
        UniqueConstraint("userId", "topicId", name="user_knowledge_userId_topicId_key"),
    )

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    topic_id = Column("topicId", String, ForeignKey("topics.id"), nullable=False)
    proficiency = Column(Integer, default=0)
    success_count = Column("successCount", Integer, default=0)
    failure_count = Column("failureCount", Integer, default=0)
    streak_count = Column("streakCount", Integer, default=0)
    last_practiced = Column("lastPracticed", DateTime, nullable=True)
    next_review_at = Column("nextReviewAt", DateTime, nullable=True)
    metadata_ = Column("metadata", JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="user_knowledge")
    topic = relationship("Topic", back_populates="user_knowledge")


class DailyProgress(Base):
    __tablename__ = "daily_progress"
    __table_args__ = (
        UniqueConstraint("userId", "date", name="daily_progress_userId_date_key"),
    )

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    date = Column(Date, nullable=False)
    total_sessions = Column("totalSessions", Integer, default=0)
    total_questions = Column("totalQuestions", Integer, default=0)
    total_correct = Column("totalCorrect", Integer, default=0)
    total_minutes = Column("totalMinutes", Integer, default=0)
    topics_studied = Column("topicsStudied", ARRAY(String), nullable=True)
    subjects_studied = Column("subjectsStudied", ARRAY(String), nullable=True)
    streak_day = Column("streakDay", Integer, default=1)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="daily_progress")
