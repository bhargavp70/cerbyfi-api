"""
SQLite-backed score cache + lookup tracker.

Two tables:
  score_cache  — stores serialised ScoreResult JSON with a TTL
  lookups      — counts how many times each ticker has been requested
"""
import json
import sqlite3
import threading
import time
from typing import Any, Optional

from app.config import settings

_DDL = """
CREATE TABLE IF NOT EXISTS score_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    stored_at  REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS lookups (
    ticker      TEXT    NOT NULL,
    asset_type  TEXT    NOT NULL,   -- "stock" | "fund"
    count       INTEGER NOT NULL DEFAULT 0,
    name        TEXT,
    score       INTEGER,
    max_score   INTEGER,
    pct         REAL,
    stars       INTEGER,
    last_seen   REAL    NOT NULL,
    PRIMARY KEY (ticker, asset_type)
);
"""


class ScoreDB:
    def __init__(self, db_path: str, ttl_seconds: int):
        self.ttl = ttl_seconds
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        with self._lock:
            self._conn.executescript(_DDL)
            self._conn.commit()

    # ── Cache ────────────────────────────────────────────────

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT value, stored_at FROM score_cache WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            return None
        if time.time() - row["stored_at"] > self.ttl:
            with self._lock:
                self._conn.execute("DELETE FROM score_cache WHERE key = ?", (key,))
                self._conn.commit()
            return None
        return json.loads(row["value"])

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO score_cache (key, value, stored_at) VALUES (?, ?, ?)",
                (key, json.dumps(value), time.time()),
            )
            self._conn.commit()

    def invalidate(self, key: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM score_cache WHERE key = ?", (key,))
            self._conn.commit()
            return cur.rowcount > 0

    def stats(self) -> dict:
        now = time.time()
        with self._lock:
            total = self._conn.execute(
                "SELECT COUNT(*) FROM score_cache"
            ).fetchone()[0]
            expired = self._conn.execute(
                "SELECT COUNT(*) FROM score_cache WHERE ? - stored_at > ?",
                (now, self.ttl),
            ).fetchone()[0]
        return {
            "total_entries": total,
            "expired_entries": expired,
            "live_entries": total - expired,
        }

    # ── Lookup tracking ──────────────────────────────────────

    def record_lookup(
        self,
        ticker: str,
        asset_type: str,
        name: str,
        score: int,
        max_score: int,
        pct: float,
        stars: int,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO lookups
                    (ticker, asset_type, count, name, score, max_score, pct, stars, last_seen)
                VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker, asset_type) DO UPDATE SET
                    count     = count + 1,
                    name      = excluded.name,
                    score     = excluded.score,
                    max_score = excluded.max_score,
                    pct       = excluded.pct,
                    stars     = excluded.stars,
                    last_seen = excluded.last_seen
                """,
                (ticker, asset_type, name, score, max_score, pct, stars, time.time()),
            )
            self._conn.commit()

    def top_lookups(self, asset_type: str, limit: int = 10) -> list:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT ticker, name, score, max_score, pct, stars, count
                FROM lookups
                WHERE asset_type = ?
                ORDER BY count DESC
                LIMIT ?
                """,
                (asset_type, limit),
            ).fetchall()
        return [dict(r) for r in rows]


score_db = ScoreDB(db_path=settings.db_path, ttl_seconds=settings.cache_ttl_seconds)
