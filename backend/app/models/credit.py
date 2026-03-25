from sqlalchemy import Column, String, DateTime, Integer, JSON, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base
from app.models.enums import PgCreditTxType, PgPaymentStatus, PaymentStatus


class CreditTransaction(Base):
    __tablename__ = "credit_transactions"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    amount = Column(Integer, nullable=False)
    balance = Column(Integer, nullable=False)
    type = Column(PgCreditTxType, nullable=False)
    description = Column(String, nullable=True)
    reference_id = Column("referenceId", String, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())

    user = relationship("User", back_populates="credit_transactions")


class PaymentOrder(Base):
    __tablename__ = "payment_orders"

    id = Column(String, primary_key=True)
    user_id = Column("userId", String, ForeignKey("users.id"), nullable=False)
    order_id = Column("orderId", String, unique=True, nullable=False)
    order_name = Column("orderName", String, nullable=False)
    amount = Column(Integer, nullable=False)
    credits = Column(Integer, nullable=False)
    status = Column(PgPaymentStatus, nullable=False, default=PaymentStatus.PENDING)
    payment_key = Column("paymentKey", String, nullable=True)
    method = Column(String, nullable=True)
    approved_at = Column("approvedAt", DateTime, nullable=True)
    fail_reason = Column("failReason", String, nullable=True)
    raw = Column(JSON, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
    updated_at = Column("updatedAt", DateTime, default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="payment_orders")
