"""
SQLite-backed store: score cache, lookup tracker, users, watchlist.
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
    asset_type  TEXT    NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    name        TEXT,
    score       INTEGER,
    max_score   INTEGER,
    pct         REAL,
    stars       INTEGER,
    last_seen   REAL    NOT NULL,
    PRIMARY KEY (ticker, asset_type)
);

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
    user_id   TEXT NOT NULL,
    ticker    TEXT NOT NULL,
    mode      TEXT NOT NULL,
    name      TEXT,
    score     INTEGER,
    max_score INTEGER,
    pct       REAL,
    stars     INTEGER,
    rating    TEXT,
    saved_at  REAL NOT NULL,
    PRIMARY KEY (user_id, ticker)
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
            total = self._conn.execute("SELECT COUNT(*) FROM score_cache").fetchone()[0]
            expired = self._conn.execute(
                "SELECT COUNT(*) FROM score_cache WHERE ? - stored_at > ?", (now, self.ttl)
            ).fetchone()[0]
        return {"total_entries": total, "expired_entries": expired, "live_entries": total - expired}

    # ── Lookup tracking ──────────────────────────────────────

    def record_lookup(self, ticker, asset_type, name, score, max_score, pct, stars):
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO lookups (ticker, asset_type, count, name, score, max_score, pct, stars, last_seen)
                VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker, asset_type) DO UPDATE SET
                    count=count+1, name=excluded.name, score=excluded.score,
                    max_score=excluded.max_score, pct=excluded.pct,
                    stars=excluded.stars, last_seen=excluded.last_seen
                """,
                (ticker, asset_type, name, score, max_score, pct, stars, time.time()),
            )
            self._conn.commit()

    def top_lookups(self, asset_type: str, limit: int = 10) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT ticker, name, score, max_score, pct, stars, count FROM lookups "
                "WHERE asset_type=? ORDER BY count DESC LIMIT ?",
                (asset_type, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def total_analyses(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COALESCE(SUM(count),0) FROM lookups").fetchone()
        return int(row[0])

    # ── Users ────────────────────────────────────────────────

    def create_user(self, user_id: str, email: str, name: str, password_hash: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)",
                (user_id, email.lower().strip(), name.strip(), password_hash, time.time()),
            )
            self._conn.commit()

    def get_user_by_email(self, email: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, email, name, password_hash FROM users WHERE email=?",
                (email.lower().strip(),),
            ).fetchone()
        return dict(row) if row else None

    def get_user_by_id(self, user_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, email, name FROM users WHERE id=?", (user_id,)
            ).fetchone()
        return dict(row) if row else None

    # ── Watchlist ────────────────────────────────────────────

    def get_watchlist(self, user_id: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT ticker, mode, name, score, max_score, pct, stars, rating, saved_at "
                "FROM watchlist WHERE user_id=? ORDER BY saved_at DESC",
                (user_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def add_to_watchlist(self, user_id: str, item: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO watchlist "
                "(user_id, ticker, mode, name, score, max_score, pct, stars, rating, saved_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (user_id, item["ticker"], item["mode"], item.get("name"),
                 item.get("score"), item.get("max_score"), item.get("pct"),
                 item.get("stars"), item.get("rating"), time.time()),
            )
            self._conn.commit()

    def remove_from_watchlist(self, user_id: str, ticker: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM watchlist WHERE user_id=? AND ticker=?", (user_id, ticker)
            )
            self._conn.commit()
            return cur.rowcount > 0

    def is_in_watchlist(self, user_id: str, ticker: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM watchlist WHERE user_id=? AND ticker=?", (user_id, ticker)
            ).fetchone()
        return row is not None


score_db = ScoreDB(db_path=settings.db_path, ttl_seconds=settings.cache_ttl_seconds)
