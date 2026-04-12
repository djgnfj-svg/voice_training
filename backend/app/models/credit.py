from sqlalchemy import Column, String, DateTime, Integer, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base
from app.models.enums import PgCreditTxType


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


class PaymentWishlist(Base):
    __tablename__ = "payment_wishlist"

    id = Column(String, primary_key=True)
    email = Column(String, nullable=False)
    user_id = Column("userId", String, nullable=True)
    product_id = Column("productId", String, nullable=True)
    created_at = Column("createdAt", DateTime, server_default=func.now())
