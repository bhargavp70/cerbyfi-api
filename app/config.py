from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    fmp_api_key: str
    cache_ttl_seconds: int = 21600           # 6 hours
    cerbyfi_api_key: Optional[str] = None    # Client auth key — set in Railway env vars
    allowed_origins: str = "http://localhost:3000,http://localhost:8000"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
