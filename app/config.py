import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

# Use /data if a Railway volume is mounted there, else /tmp
_default_db = "/data/cerbyfi.db" if os.path.isdir("/data") else "/tmp/cerbyfi_cache.db"


class Settings(BaseSettings):
    fmp_api_key: Optional[str] = None        # For ETF/fund scoring — set FMP_API_KEY in Railway
    finnhub_api_key: Optional[str] = None    # For stock scoring — set FINNHUB_API_KEY in Railway
    cache_ttl_seconds: int = 86400           # 24 hours — data rarely changes intraday
    cerbyfi_api_key: Optional[str] = None    # Client auth key — set in Railway env vars
    allowed_origins: str = "http://localhost:3000,http://localhost:8000"
    db_path: str = _default_db              # Set DB_PATH=/data/cerbyfi.db with Railway volume

    # JWT — set JWT_SECRET to a long random string in Railway
    jwt_secret: str = "dev-secret-change-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 30

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
