from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.coupon import Coupon, CouponUsage
from app.models.credit import CreditTransaction
from app.models.user import User


class CouponRedeemError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


async def redeem_coupon(db: AsyncSession, user_id: str, code: str) -> dict:
    """Atomic coupon redemption. Returns {"credits": int}."""
    normalized = code.strip().upper()

    result = await db.execute(select(Coupon).where(Coupon.code == normalized))
    coupon = result.scalar_one_or_none()

    if not coupon or not coupon.is_active:
        raise CouponRedeemError("INVALID_COUPON")

    if coupon.expires_at and coupon.expires_at < datetime.now(timezone.utc):
        raise CouponRedeemError("EXPIRED_COUPON")

    if coupon.max_uses and coupon.used_count >= coupon.max_uses:
        raise CouponRedeemError("MAX_USES_REACHED")

    # Check if already used by this user
    usage_result = await db.execute(
        select(CouponUsage).where(
            CouponUsage.coupon_id == coupon.id,
            CouponUsage.user_id == user_id,
        )
    )
    if usage_result.scalar_one_or_none():
        raise CouponRedeemError("ALREADY_USED")

    # Atomic: increment usedCount with optimistic lock
    if coupon.max_uses:
        upd = await db.execute(
            update(Coupon)
            .where(Coupon.id == coupon.id, Coupon.used_count < coupon.max_uses)
            .values(used_count=Coupon.used_count + 1)
        )
        if upd.rowcount == 0:
            raise CouponRedeemError("MAX_USES_REACHED")
    else:
        await db.execute(
            update(Coupon)
            .where(Coupon.id == coupon.id)
            .values(used_count=Coupon.used_count + 1)
        )

    # Create usage record
    usage = CouponUsage(id=str(uuid4()), coupon_id=coupon.id, user_id=user_id)
    db.add(usage)

    # Increment user balance
    await db.execute(
        update(User)
        .where(User.id == user_id)
        .values(credit_balance=User.credit_balance + coupon.credits)
    )

    # Get new balance
    bal_result = await db.execute(
        select(User.credit_balance).where(User.id == user_id)
    )
    new_balance = bal_result.scalar() or 0

    # Create transaction
    tx = CreditTransaction(
        id=str(uuid4()),
        user_id=user_id,
        amount=coupon.credits,
        balance=new_balance,
        type="COUPON",
        description=f"쿠폰 사용: {normalized}",
        reference_id=coupon.id,
    )
    db.add(tx)

    await db.commit()
    return {"credits": coupon.credits}
