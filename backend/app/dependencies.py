from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from fastapi import Depends, HTTPException, Request
from joserfc.jwe import decrypt_compact
from joserfc.jwk import OctKey

from app.config import settings


def _derive_key(secret: str, salt: str) -> bytes:
    """Derive 64-byte encryption key using HKDF-SHA256 (NextAuth v5 compatible)."""
    info = f"Auth.js Generated Encryption Key ({salt})".encode()
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=64,
        salt=salt.encode(),
        info=info,
    )
    return hkdf.derive(secret.encode())


def _decrypt_nextauth_token(token: str, cookie_name: str) -> dict:
    """Decrypt NextAuth v5 JWE token using joserfc (no subprocess)."""
    key_bytes = _derive_key(settings.NEXTAUTH_SECRET, cookie_name)
    key = OctKey.import_key(key_bytes)
    result = decrypt_compact(token, key, algorithms=["dir", "A256CBC-HS512"])
    return json.loads(result.plaintext)


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
            payload = _decrypt_nextauth_token(token, cookie_name)
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

    raise HTTPException(status_code=401, detail={"error": "로그인이 필요합니다."})


async def get_admin_user(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    """Require admin privileges."""
    if user.email and user.email.lower() in settings.admin_email_list:
        return user
    raise HTTPException(status_code=403, detail={"error": "관리자 권한이 필요합니다."})
