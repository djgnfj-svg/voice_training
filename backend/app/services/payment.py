from __future__ import annotations

import logging
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

logger = logging.getLogger(__name__)


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
    if order.status == "FAILED":
        # FAILED 상태: Toss 측에서 실제 성공했을 수 있으므로 조회 후 복구 시도
        recovered = await _try_recover_failed_order(db, order, user_id, payment_key)
        if recovered:
            return recovered
        raise ValueError("ORDER_NOT_PENDING")
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

    # Toss 응답 금액/주문 교차 검증
    toss_amount = toss_data.get("totalAmount")
    toss_order_id = toss_data.get("orderId")
    if (toss_amount is not None and toss_amount != order.amount) or (toss_order_id and toss_order_id != order.order_id):
        logger.error("Toss 응답 불일치 — 주문=%s, DB금액=%s, Toss금액=%s, TossOrderId=%s", order_id, order.amount, toss_amount, toss_order_id)
        # 불일치 시 FAILED 마킹 (PENDING 유지 방지)
        await db.execute(
            update(PaymentOrder)
            .where(PaymentOrder.id == order.id)
            .values(status="FAILED", fail_reason=f"Toss 응답 불일치: amount={toss_amount}, orderId={toss_order_id}")
        )
        await db.commit()
        raise ValueError("TOSS_RESPONSE_MISMATCH")

    # 원자적 처리: flush로 모아서 한 번의 commit으로 적용
    try:
        await _grant_credits(db, order, user_id, payment_key, toss_data)
    except Exception:
        await db.rollback()
        logger.exception(
            "결제 확인 후 크레딧 부여 실패 — orderId=%s, userId=%s",
            order.order_id,
            user_id,
        )
        raise ValueError("CREDIT_GRANT_FAILED")

    return {"credits": order.credits}


async def _grant_credits(
    db: AsyncSession,
    order: PaymentOrder,
    user_id: str,
    payment_key: str,
    toss_data: dict,
) -> None:
    """주문 완료 + 크레딧 증가 + 거래 내역을 단일 트랜잭션으로 처리."""
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
    await db.flush()

    await db.execute(
        update(User)
        .where(User.id == user_id)
        .values(credit_balance=User.credit_balance + order.credits)
    )
    await db.flush()

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


async def _try_recover_failed_order(
    db: AsyncSession,
    order: PaymentOrder,
    user_id: str,
    payment_key: str,
) -> dict | None:
    """FAILED 주문에 대해 Toss 결제 조회 API로 실제 상태를 확인하고, 성공이면 크레딧 부여."""
    secret = settings.TOSS_SECRET_KEY
    if not secret:
        return None

    auth_header = b64encode(f"{secret}:".encode()).decode()

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"https://api.tosspayments.com/v1/payments/{payment_key}",
                headers={"Authorization": f"Basic {auth_header}"},
                timeout=10.0,
            )
    except httpx.TimeoutException:
        logger.warning("Toss 결제 조회 타임아웃 — orderId=%s", order.order_id)
        return None

    if resp.status_code != 200:
        return None

    toss_data = resp.json()
    if toss_data.get("status") != "DONE":
        return None

    # Toss 응답의 orderId가 현재 주문과 일치하는지 교차 검증
    if toss_data.get("orderId") != order.order_id:
        logger.warning("FAILED 주문 복구 시 orderId 불일치 — DB=%s, Toss=%s", order.order_id, toss_data.get("orderId"))
        return None

    # Toss에서는 성공 — 크레딧 부여 복구
    logger.info("FAILED 주문 복구 — orderId=%s, Toss 상태=DONE", order.order_id)
    try:
        await _grant_credits(db, order, user_id, payment_key, toss_data)
    except Exception:
        await db.rollback()
        logger.exception("FAILED 주문 복구 중 크레딧 부여 실패 — orderId=%s", order.order_id)
        return None

    return {"credits": order.credits, "recovered": True}
