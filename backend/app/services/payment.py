from __future__ import annotations

import time
from datetime import datetime, timezone
from uuid import uuid4
from base64 import b64encode

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
from app.models.credit import PaymentOrder, CreditTransaction
from app.lib.payment_products import find_product


async def create_order(db: AsyncSession, user_id: str, product_id: str) -> dict:
    product = find_product(product_id)
    if not product:
        raise ValueError("INVALID_PRODUCT")

    order_id = f"order_{int(time.time() * 1000)}_{str(uuid4())[:8]}"
    order_name = product["label"]

    order = PaymentOrder(
        id=str(uuid4()),
        user_id=user_id,
        order_id=order_id,
        order_name=order_name,
        amount=product["amount"],
        credits=product["credits"],
        status="PENDING",
    )
    db.add(order)
    await db.commit()

    return {"orderId": order_id, "amount": product["amount"], "orderName": order_name}


async def confirm_payment(
    db: AsyncSession, user_id: str, payment_key: str, order_id: str, amount: int
) -> dict:
    # Find order
    result = await db.execute(
        select(PaymentOrder).where(PaymentOrder.order_id == order_id)
    )
    order = result.scalar_one_or_none()

    if not order:
        raise ValueError("ORDER_NOT_FOUND")
    if order.user_id != user_id:
        raise ValueError("ORDER_USER_MISMATCH")
    if order.status == "DONE":
        return {"credits": order.credits, "alreadyProcessed": True}
    if order.status != "PENDING":
        raise ValueError("ORDER_NOT_PENDING")
    if order.amount != amount:
        raise ValueError("AMOUNT_MISMATCH")

    # Call Toss API
    secret = settings.TOSS_SECRET_KEY
    if not secret:
        raise ValueError("TOSS_NOT_CONFIGURED")

    auth_header = b64encode(f"{secret}:".encode()).decode()

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.tosspayments.com/v1/payments/confirm",
            json={"paymentKey": payment_key, "orderId": order_id, "amount": amount},
            headers={
                "Authorization": f"Basic {auth_header}",
                "Content-Type": "application/json",
                "Idempotency-Key": order_id,
            },
            timeout=30.0,
        )

    if resp.status_code != 200:
        # Mark order as failed
        await db.execute(
            update(PaymentOrder)
            .where(PaymentOrder.id == order.id, PaymentOrder.status == "PENDING")
            .values(status="FAILED", fail_reason=resp.text[:500])
        )
        await db.commit()
        raise ValueError("TOSS_CONFIRM_FAILED")

    toss_data = resp.json()

    # Atomic: update order, increment balance, create transaction
    await db.execute(
        update(PaymentOrder)
        .where(PaymentOrder.id == order.id)
        .values(
            status="DONE",
            payment_key=payment_key,
            method=toss_data.get("method"),
            approved_at=datetime.now(timezone.utc),
            raw=toss_data,
        )
    )

    await db.execute(
        update(User)
        .where(User.id == user_id)
        .values(credit_balance=User.credit_balance + order.credits)
    )

    bal_result = await db.execute(select(User.credit_balance).where(User.id == user_id))
    new_balance = bal_result.scalar() or 0

    tx = CreditTransaction(
        id=str(uuid4()),
        user_id=user_id,
        amount=order.credits,
        balance=new_balance,
        type="PURCHASE",
        description=f"크레딧 구매: {order.order_name}",
        reference_id=order.order_id,
    )
    db.add(tx)
    await db.commit()

    return {"credits": order.credits}
