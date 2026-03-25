from sqlalchemy import Column, String, DateTime, Integer, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Coupon(Base):
    __tablename__ = "coupons"

    id = Column(String, primary_key=True)
    code = Column(String, unique=True, nullable=False)
    credits = Column(Integer, nullable=False)
    max_uses = Column("maxUses", Integer, nullable=True)
    used_count = Column("usedCount", Integer, default=0)
    is_active = Column("isActive", Boolean, default=True)
    expires_at = Column("expiresAt", DateTime, nullable=True)
    description = Column(String, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    usages = relationship("CouponUsage", back_populates="coupon", cascade="all, delete-orphan")


class CouponUsage(Base):
    __tablename__ = "coupon_usages"
    __table_args__ = (
        UniqueConstraint("couponId", "userId", name="coupon_usages_couponId_userId_key"),
    )

    id = Column(String, primary_key=True)
    coupon_id = Column("couponId", String, ForeignKey("coupons.id"), nullable=False)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    coupon = relationship("Coupon", back_populates="usages")
    user = relationship("User", back_populates="coupon_usages")
