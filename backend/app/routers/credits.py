from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.services.credit import get_credit_info, get_transactions

router = APIRouter()


@router.get("/api/credits")
async def credits_balance(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_credit_info(db, user.id)


@router.get("/api/credits/transactions")
async def credits_transactions(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    return await get_transactions(db, user.id, limit, offset)
