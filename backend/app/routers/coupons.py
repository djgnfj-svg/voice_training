from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.services.coupon import CouponRedeemError, redeem_coupon

router = APIRouter()


class RedeemRequest(BaseModel):
    code: str = Field(min_length=1, max_length=50)


@router.post("/api/coupons/redeem")
async def redeem(
    body: RedeemRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await redeem_coupon(db, user.id, body.code)
        return {
            "success": True,
            "credits": result["credits"],
            "message": f"{result['credits']} 크레딧이 지급되었습니다.",
        }
    except CouponRedeemError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": str(e.code), "code": e.code},
        )
