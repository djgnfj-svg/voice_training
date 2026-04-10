from __future__ import annotations

from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.credit import CreditTransaction
from app.models.interview import InterviewSession


class InsufficientCreditsError(Exception):
    pass


class FreeTrialAlreadyUsedError(Exception):
    pass


CREDIT_COSTS = {
    "SESSION": 10,
    "MODEL_ANSWER": 10,
    "DEEP_RESEARCH": 1,
    "FOLLOW_UP": 1,
}


# ---------------------------------------------------------------------------
# Existing helpers
# ---------------------------------------------------------------------------

async def get_credit_info(db: AsyncSession, user_id: str) -> dict:
    result = await db.execute(
        select(User.credit_balance, User.free_trial_used).where(User.id == user_id)
    )
    row = result.one_or_none()
    if not row:
        return {"balance": 0, "freeTrialUsed": False}
    return {"balance": row.credit_balance, "freeTrialUsed": row.free_trial_used}


async def get_transactions(db: AsyncSession, user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
    result = await db.execute(
        select(CreditTransaction)
        .where(CreditTransaction.user_id == user_id)
        .order_by(CreditTransaction.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = result.scalars().all()
    return [
        {
            "id": t.id,
            "userId": t.user_id,
            "amount": t.amount,
            "balance": t.balance,
            "type": t.type,
            "description": t.description,
            "referenceId": t.reference_id,
            "createdAt": t.created_at.isoformat() if t.created_at else None,
        }
        for t in rows
    ]


# ---------------------------------------------------------------------------
# Session gating
# ---------------------------------------------------------------------------

async def can_start_session(db: AsyncSession, user_id: str) -> dict:
    """Check if user can start a session. Returns {"allowed": bool, "usingFreeTrial": bool}."""
    info = await get_credit_info(db, user_id)

    if not info["freeTrialUsed"]:
        return {"allowed": True, "usingFreeTrial": True}
    if info["balance"] >= CREDIT_COSTS["SESSION"]:
        return {"allowed": True, "usingFreeTrial": False}
    return {"allowed": False, "usingFreeTrial": False}


async def deduct_for_session(
    db: AsyncSession,
    user_id: str,
    session_id: str,
    using_free_trial: bool,
) -> None:
    """
    Atomic credit deduction for a session.
    For free trial: marks freeTrialUsed=True with optimistic lock.
    For paid: decrements balance with optimistic lock (balance >= cost).
    """
    if using_free_trial:
        await mark_free_trial_used(db, user_id)

        await db.execute(
            update(InterviewSession)
            .where(InterviewSession.id == session_id)
            .values(credit_deducted=True)
        )

        tx = CreditTransaction(
            id=str(uuid4()),
            user_id=user_id,
            amount=0,
            balance=0,
            type="FREE_TRIAL",
            description="무료 체험 사용",
            reference_id=session_id,
        )
        db.add(tx)
        await db.commit()
        return

    # Paid session — atomic deduction
    cost = CREDIT_COSTS["SESSION"]
    result = await db.execute(
        update(User)
        .where(User.id == user_id, User.credit_balance >= cost)
        .values(credit_balance=User.credit_balance - cost)
        .returning(User.credit_balance)
    )
    row = result.one_or_none()
    if row is None:
        raise InsufficientCreditsError("INSUFFICIENT_CREDITS")
    new_balance = row.credit_balance

    await db.execute(
        update(InterviewSession)
        .where(InterviewSession.id == session_id)
        .values(credit_deducted=True)
    )

    tx = CreditTransaction(
        id=str(uuid4()),
        user_id=user_id,
        amount=-cost,
        balance=new_balance,
        type="SESSION_DEBIT",
        description="면접 세션 사용",
        reference_id=session_id,
    )
    db.add(tx)
    await db.commit()


async def mark_free_trial_used(db: AsyncSession, user_id: str) -> None:
    """Atomically mark free trial as used. Raises FreeTrialAlreadyUsedError on race."""
    result = await db.execute(
        update(User)
        .where(User.id == user_id, User.free_trial_used == False)  # noqa: E712
        .values(free_trial_used=True)
    )
    if result.rowcount == 0:
        raise FreeTrialAlreadyUsedError("FREE_TRIAL_ALREADY_USED")
    await db.commit()


async def deduct_for_feature(
    db: AsyncSession,
    user_id: str,
    reference_id: str,
    description: str,
    cost: int,
    tx_type: str = "FEATURE_DEBIT",
) -> None:
    """
    Atomic credit deduction for a feature (follow-up, deep research, model answer, etc.).
    Uses optimistic locking: only succeeds if balance >= cost.
    """
    result = await db.execute(
        update(User)
        .where(User.id == user_id, User.credit_balance >= cost)
        .values(credit_balance=User.credit_balance - cost)
        .returning(User.credit_balance)
    )
    row = result.one_or_none()
    if row is None:
        raise InsufficientCreditsError("INSUFFICIENT_CREDITS")
    new_balance = row.credit_balance

    tx = CreditTransaction(
        id=str(uuid4()),
        user_id=user_id,
        amount=-cost,
        balance=new_balance,
        type=tx_type,
        description=description,
        reference_id=reference_id,
    )
    db.add(tx)
    await db.commit()


async def refund_for_session(
    db: AsyncSession, user_id: str, session_id: str
) -> None:
    """Refund credits for a failed session."""
    result = await db.execute(
        select(InterviewSession.credit_deducted)
        .where(InterviewSession.id == session_id)
    )
    row = result.one_or_none()
    if not row or not row.credit_deducted:
        return

    # Check if this session was a free trial by looking at the transaction record
    tx_result = await db.execute(
        select(CreditTransaction.type)
        .where(
            CreditTransaction.reference_id == session_id,
            CreditTransaction.type.in_(["FREE_TRIAL", "SESSION_DEBIT"]),
        )
    )
    original_tx = tx_result.scalar_one_or_none()

    await db.execute(
        update(InterviewSession)
        .where(InterviewSession.id == session_id)
        .values(credit_deducted=False)
    )

    if original_tx == "FREE_TRIAL":
        # Free trial: restore free_trial_used flag, no credit refund
        await db.execute(
            update(User)
            .where(User.id == user_id)
            .values(free_trial_used=False)
        )

        tx = CreditTransaction(
            id=str(uuid4()),
            user_id=user_id,
            amount=0,
            balance=0,
            type="REFUND",
            description="무료 체험 세션 실패 환불",
            reference_id=session_id,
        )
        db.add(tx)
    else:
        # Paid session: refund credits
        cost = CREDIT_COSTS["SESSION"]

        result = await db.execute(
            update(User)
            .where(User.id == user_id)
            .values(credit_balance=User.credit_balance + cost)
            .returning(User.credit_balance)
        )
        new_balance = result.scalar_one()

        tx = CreditTransaction(
            id=str(uuid4()),
            user_id=user_id,
            amount=cost,
            balance=new_balance,
            type="REFUND",
            description="세션 생성 실패 환불",
            reference_id=session_id,
        )
        db.add(tx)

    await db.commit()


async def grant_credits(
    db: AsyncSession, user_id: str, amount: int, description: str
) -> None:
    """Admin grant credits to a user."""
    result = await db.execute(
        update(User)
        .where(User.id == user_id)
        .values(credit_balance=User.credit_balance + amount)
        .returning(User.credit_balance)
    )
    new_balance = result.scalar_one()

    tx = CreditTransaction(
        id=str(uuid4()),
        user_id=user_id,
        amount=amount,
        balance=new_balance,
        type="ADMIN_GRANT",
        description=description,
    )
    db.add(tx)
    await db.commit()
