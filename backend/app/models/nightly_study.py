from __future__ import annotations

from sqlalchemy import (
    Column, String, DateTime, Date, Integer, Boolean, Text,
    ForeignKey, CheckConstraint, UniqueConstraint
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class LearningGoal(Base):
    __tablename__ = "learning_goals"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(Text, nullable=False)
    normalized_goal = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="active")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CurriculumNode(Base):
    __tablename__ = "curriculum_nodes"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    goal_id = Column(UUID(as_uuid=True), ForeignKey("learning_goals.id", ondelete="CASCADE"), nullable=False)
    title = Column(Text, nullable=False)
    description = Column(Text, nullable=False)
    depth_level = Column(Integer, nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("curriculum_nodes.id", ondelete="SET NULL"), nullable=True)
    source = Column(Text, nullable=False)
    keywords = Column(ARRAY(Text), nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        CheckConstraint("depth_level BETWEEN 0 AND 2", name="curriculum_nodes_depth_range"),
        CheckConstraint("source IN ('seed','extended')", name="curriculum_nodes_source_check"),
    )


class NodeMastery(Base):
    __tablename__ = "node_mastery"

    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    node_id = Column(UUID(as_uuid=True), ForeignKey("curriculum_nodes.id", ondelete="CASCADE"), primary_key=True)
    proficiency = Column(Integer, nullable=False, default=0)
    success_count = Column(Integer, nullable=False, default=0)
    failure_count = Column(Integer, nullable=False, default=0)
    streak_count = Column(Integer, nullable=False, default=0)
    last_studied_at = Column(DateTime(timezone=True), nullable=True)
    next_review_at = Column(DateTime(timezone=True), nullable=True)
    last_mode = Column(Text, nullable=True)


class LearningSession(Base):
    __tablename__ = "learning_sessions"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    goal_id = Column(UUID(as_uuid=True), ForeignKey("learning_goals.id", ondelete="SET NULL"), nullable=True)
    status = Column(Text, nullable=False, default="active")
    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at = Column(DateTime(timezone=True), nullable=True)
    turn_count = Column(Integer, nullable=False, default=0)
    is_free_session = Column(Boolean, nullable=False, default=False)
    credit_deducted = Column(Integer, nullable=False, default=0)
    summary = Column(Text, nullable=True)
    highlights = Column(JSONB, nullable=True)
    voice_briefing = Column(Text, nullable=True)


class LearningMessage(Base):
    __tablename__ = "learning_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    session_id = Column(UUID(as_uuid=True), ForeignKey("learning_sessions.id", ondelete="CASCADE"), nullable=False)
    message_index = Column(Integer, nullable=False)
    role = Column(Text, nullable=False)
    content = Column(Text, nullable=False)
    mode = Column(Text, nullable=True)
    tool_calls = Column(JSONB, nullable=True)
    node_id = Column(UUID(as_uuid=True), ForeignKey("curriculum_nodes.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("session_id", "message_index", name="learning_messages_session_idx_unique"),
    )


class LearningStreak(Base):
    __tablename__ = "learning_streaks"

    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    current_streak = Column(Integer, nullable=False, default=0)
    longest_streak = Column(Integer, nullable=False, default=0)
    total_sessions = Column(Integer, nullable=False, default=0)
    total_nodes_learned = Column(Integer, nullable=False, default=0)
    last_session_date = Column(Date, nullable=True)
