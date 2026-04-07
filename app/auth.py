import secrets as _secrets
from fastapi import Security, HTTPException, status
from fastapi.security.api_key import APIKeyHeader
from app.config import settings

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_api_key(key: str = Security(_api_key_header)) -> str:
    """Dependency — rejects requests that don't carry the correct X-API-Key header."""
    if not settings.cerbyfi_api_key:
        return ""
    # Constant-time comparison prevents timing attacks
    if not key or not _secrets.compare_digest(key, settings.cerbyfi_api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key.",
        )
    return key
