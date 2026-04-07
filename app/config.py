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
    claude_api_key: Optional[str] = None     # Anthropic API key — set CLAUDE_API_KEY in Railway
    allowed_origins: str = "http://localhost:3000,http://localhost:8000"
    db_path: str = _default_db              # Set DB_PATH=/data/cerbyfi.db with Railway volume

    # JWT — set JWT_SECRET to a long random string in Railway
    jwt_secret: str = "dev-secret-change-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 1

    # Admins — comma-separated emails, overrideable via ADMIN_EMAILS env var
    admin_emails: str = "bhargavp@hotmail.com"

    # SMTP — set in Railway env vars to enable verification emails
    smtp_host: Optional[str] = None   # e.g. smtp.gmail.com
    smtp_port: int = 587              # 587 (STARTTLS) or 465 (SSL)
    smtp_user: Optional[str] = None   # sender login
    smtp_pass: Optional[str] = None   # app password
    smtp_from: Optional[str] = None   # display From (defaults to smtp_user)

    # Public base URL for building email links
    app_base_url: str = "https://cerbyfi-production.up.railway.app"

    # Monthly AI report limit for premium users (0 = unlimited)
    ai_monthly_limit: int = 10

    @property
    def admin_email_set(self) -> set:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
