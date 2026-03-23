"""JWT + password utilities for user accounts."""
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
import bcrypt
from fastapi import Header, HTTPException

from app.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def create_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.jwt_expire_days)
    return jwt.encode(
        {"sub": user_id, "exp": expire},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


def decode_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        return payload.get("sub")
    except jwt.PyJWTError:
        return None


def require_user(authorization: Optional[str] = Header(default=None)) -> str:
    """FastAPI dependency — requires valid Bearer JWT, returns user_id."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated.")
    user_id = decode_token(authorization[7:])
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
    return user_id


def optional_user(authorization: Optional[str] = Header(default=None)) -> Optional[str]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return decode_token(authorization[7:])


def require_admin(authorization: Optional[str] = Header(default=None)) -> str:
    """FastAPI dependency — requires valid Bearer JWT belonging to an admin user."""
    from app.db import score_db  # avoid circular import at module level
    user_id = require_user(authorization)
    user = score_db.get_user_by_id(user_id)
    if not user or not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required.")
    return user_id
