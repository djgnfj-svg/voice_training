from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.services.payment import create_order, confirm_payment

router = APIRouter()


class OrderRequest(BaseModel):
    productId: str


class ConfirmRequest(BaseModel):
    paymentKey: str
    orderId: str
    amount: int = Field(gt=0)


@router.post("/api/payments/orders")
async def create_payment_order(
    body: OrderRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await create_order(db, user.id, body.productId)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e), "code": str(e)})


@router.post("/api/payments/confirm")
async def confirm_payment_order(
    body: ConfirmRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await confirm_payment(db, user.id, body.paymentKey, body.orderId, body.amount)
        return {"success": True, "credits": result["credits"]}
    except ValueError as e:
        code = str(e)
        status = 400
        if code == "ORDER_NOT_FOUND":
            status = 404
        elif code == "ORDER_USER_MISMATCH":
            status = 403
        raise HTTPException(status_code=status, detail={"error": code, "code": code})
