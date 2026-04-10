from __future__ import annotations

import asyncio

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
    # Check if user has credentials provider account OR hashedPassword
    cred_result = await db.execute(
        select(Account.id).where(
            Account.user_id == user.id,
            Account.provider == "credentials",
        ).limit(1)
    )
    has_credentials_account = cred_result.scalar() is not None

    if not has_credentials_account:
        user_result = await db.execute(
            select(User.hashed_password).where(User.id == user.id)
        )
        hashed_pw = user_result.scalar()
        has_credentials = hashed_pw is not None
    else:
        has_credentials = True

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
        raise HTTPException(status_code=400, detail={"error": "비밀번호가 설정되지 않은 계정입니다."})

    password_valid = await asyncio.to_thread(
        bcrypt.checkpw,
        body.currentPassword.encode("utf-8"),
        db_user.hashed_password.encode("utf-8"),
    )
    if not password_valid:
        raise HTTPException(status_code=400, detail={"error": "현재 비밀번호가 일치하지 않습니다."})

    salt = await asyncio.to_thread(bcrypt.gensalt, 12)
    new_hash = (
        await asyncio.to_thread(
            bcrypt.hashpw,
            body.newPassword.encode("utf-8"),
            salt,
        )
    ).decode("utf-8")

    db_user.hashed_password = new_hash
    await db.commit()

    return {"message": "비밀번호가 변경되었습니다."}
