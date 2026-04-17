from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.services.coupon import CouponRedeemError, redeem_coupon

router = APIRouter()


COUPON_ERROR_MESSAGES = {
    "INVALID_COUPON": "유효하지 않은 쿠폰입니다.",
    "EXPIRED_COUPON": "만료된 쿠폰입니다.",
    "MAX_USES_REACHED": "쿠폰 사용 한도에 도달했습니다.",
    "ALREADY_USED": "이미 사용한 쿠폰입니다.",
}


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
        message = COUPON_ERROR_MESSAGES.get(e.code, "쿠폰 사용에 실패했습니다.")
        raise HTTPException(
            status_code=400,
            detail={"error": message, "code": e.code},
        )
