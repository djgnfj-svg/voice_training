from sqlalchemy import Column, String, DateTime, JSON, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Resume(Base):
    __tablename__ = "resumes"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    file_url = Column("fileUrl", String, nullable=True)
    parsed_data = Column("parsedData", JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="resumes")
    interview_sessions = relationship("InterviewSession", back_populates="resume")
    activity_logs = relationship("ActivityLog", back_populates="resume")
    answer_assist_sessions = relationship("AnswerAssistSession", back_populates="resume")
