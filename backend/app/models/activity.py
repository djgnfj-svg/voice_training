from sqlalchemy import Column, String, DateTime, Integer, JSON, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base
from app.models.enums import PgActivityType


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    type = Column(PgActivityType, nullable=False)
    resume_id = Column("resumeId", String, ForeignKey("resumes.id"), nullable=True)
    metadata_ = Column("metadata", JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    user = relationship("User", back_populates="activity_logs")
    resume = relationship("Resume", back_populates="activity_logs")
    items = relationship("ActivityItem", back_populates="activity_log", cascade="all, delete-orphan")


class ActivityItem(Base):
    __tablename__ = "activity_items"

    id = Column(String, primary_key=True)
    activity_log_id = Column("activityLogId", String, ForeignKey("activity_logs.id"), nullable=False)
    index = Column(Integer, nullable=False)
    question = Column(Text, nullable=False)
    answer = Column(Text, nullable=False)
    extra = Column(JSON, nullable=True)

    activity_log = relationship("ActivityLog", back_populates="items")
