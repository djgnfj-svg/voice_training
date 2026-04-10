from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from app.config import settings
from app.database import get_db


async def _decrypt_nextauth_token(token: str, cookie_name: str) -> dict:
    """Decrypt NextAuth v5 JWE token by calling @auth/core via Node.js subprocess."""
    stdin_data = json.dumps({"token": token, "secret": settings.NEXTAUTH_SECRET, "salt": cookie_name})
    result = await asyncio.to_thread(
        subprocess.run,
        ["node", "decode_token.mjs"],
        input=stdin_data,
        capture_output=True,
        text=True,
        timeout=5,
    )
    if result.returncode != 0:
        error_msg = result.stderr.strip() if result.stderr else "Unknown error"
        raise ValueError(f"Token decode failed: {error_msg}")

    return json.loads(result.stdout.strip())


@dataclass
class AuthUser:
    id: str
    email: str | None = None
    name: str | None = None


async def get_current_user(request: Request) -> AuthUser:
    """Extract user from NextAuth JWT cookie."""
    # Try both cookie names
    cookie_name = None
    token = request.cookies.get("__Secure-authjs.session-token")
    if token:
        cookie_name = "__Secure-authjs.session-token"
    else:
        token = request.cookies.get("authjs.session-token")
        if token:
            cookie_name = "authjs.session-token"

    if token and cookie_name:
        try:
            payload = await _decrypt_nextauth_token(token, cookie_name)
            user_id = payload.get("sub")
            if user_id:
                return AuthUser(
                    id=user_id,
                    email=payload.get("email"),
                    name=payload.get("name"),
                )
        except Exception as e:
            logging.error(f"JWT decode failed: {e}")
            # Fall through to dev mode or 401

    raise HTTPException(status_code=401, detail="Unauthorized")


async def get_admin_user(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    """Require admin privileges."""
    if user.email and user.email.lower() in settings.admin_email_list:
        return user
    raise HTTPException(status_code=403, detail="Forbidden")


# Type aliases for cleaner route signatures
CurrentUser = Depends(get_current_user)
AdminUser = Depends(get_admin_user)
DbSession = Depends(get_db)
