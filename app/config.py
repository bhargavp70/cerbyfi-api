from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    fmp_api_key: Optional[str] = None        # For ETF/fund scoring — set FMP_API_KEY in Railway
    finnhub_api_key: Optional[str] = None    # For stock scoring — set FINNHUB_API_KEY in Railway
    cache_ttl_seconds: int = 86400           # 24 hours — data rarely changes intraday
    cerbyfi_api_key: Optional[str] = None    # Client auth key — set in Railway env vars
    allowed_origins: str = "http://localhost:3000,http://localhost:8000"
    db_path: str = "/tmp/cerbyfi_cache.db"   # SQLite path; override in Railway if volume mounted

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
