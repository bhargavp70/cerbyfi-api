from fastapi import Security, HTTPException, status
from fastapi.security.api_key import APIKeyHeader
from app.config import settings

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_api_key(key: str = Security(_api_key_header)) -> str:
    """Dependency — rejects requests that don't carry the correct X-API-Key header."""
    if not settings.cerbyfi_api_key:
        # Key auth disabled (e.g. local dev without the env var set)
        return ""
    if key != settings.cerbyfi_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key.",
        )
    return key
