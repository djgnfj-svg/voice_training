from __future__ import annotations

import bcrypt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.models.user import Account, User

router = APIRouter()


@router.get("/api/user/me")
async def get_me(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Account.id).where(Account.user_id == user.id).limit(1)
    )
    has_credentials = result.scalar() is not None
    return {"hasCredentials": has_credentials}


class PasswordChangeRequest(BaseModel):
    currentPassword: str
    newPassword: str = Field(min_length=8)


@router.patch("/api/user/password")
async def change_password(
    body: PasswordChangeRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one_or_none()
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    if not db_user.hashed_password:
        raise HTTPException(status_code=400, detail="비밀번호가 설정되지 않은 계정입니다.")

    if not bcrypt.checkpw(
        body.currentPassword.encode("utf-8"),
        db_user.hashed_password.encode("utf-8"),
    ):
        raise HTTPException(status_code=400, detail="현재 비밀번호가 일치하지 않습니다.")

    new_hash = bcrypt.hashpw(
        body.newPassword.encode("utf-8"),
        bcrypt.gensalt(rounds=12),
    ).decode("utf-8")

    db_user.hashed_password = new_hash
    await db.commit()

    return {"message": "비밀번호가 변경되었습니다."}
