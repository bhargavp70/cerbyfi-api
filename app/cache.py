import time
from typing import Any, Optional
from app.config import settings


class TTLCache:
    def __init__(self, ttl_seconds: int):
        self._store: dict = {}
        self.ttl = ttl_seconds

    def get(self, key: str) -> Optional[Any]:
        entry = self._store.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        if time.time() - stored_at > self.ttl:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (time.time(), value)

    def invalidate(self, key: str) -> bool:
        if key in self._store:
            del self._store[key]
            return True
        return False

    def stats(self) -> dict:
        now = time.time()
        expired = sum(1 for ts, _ in self._store.values() if now - ts > self.ttl)
        total = len(self._store)
        return {
            "total_entries": total,
            "expired_entries": expired,
            "live_entries": total - expired,
        }


score_cache = TTLCache(ttl_seconds=settings.cache_ttl_seconds)
