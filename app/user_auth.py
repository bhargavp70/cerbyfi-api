"""JWT + password utilities for user accounts."""
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Header, HTTPException

from app.config import settings

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return _pwd.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd.verify(plain, hashed)


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
    except JWTError:
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
    """Like require_user but returns None instead of raising."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return decode_token(authorization[7:])
