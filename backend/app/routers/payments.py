from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.credit import PaymentWishlist

router = APIRouter()


class WishlistRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    productId: str | None = None


@router.post("/api/payments/wishlist")
async def add_to_wishlist(
    body: WishlistRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = PaymentWishlist(
        id=str(uuid.uuid4()),
        email=body.email,
        user_id=user.id,
        product_id=body.productId,
    )
    db.add(entry)
    await db.commit()
    return {"success": True}
