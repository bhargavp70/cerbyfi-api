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

CREATE TABLE IF NOT EXISTS portfolios (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
    portfolio_id TEXT NOT NULL,
    ticker       TEXT NOT NULL,
    mode         TEXT NOT NULL,
    name         TEXT,
    score        INTEGER,
    max_score    INTEGER,
    pct_score    REAL,
    stars        INTEGER,
    allocation   REAL NOT NULL,
    added_at     REAL NOT NULL,
    PRIMARY KEY (portfolio_id, ticker)
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

    def count_users(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) FROM users").fetchone()
        return int(row[0])

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

    # ── Portfolios ───────────────────────────────────────────

    def create_portfolio(self, portfolio_id: str, user_id: str, name: str) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO portfolios (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)",
                (portfolio_id, user_id, name.strip(), now, now),
            )
            self._conn.commit()

    def get_portfolios(self, user_id: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, name, created_at, updated_at FROM portfolios "
                "WHERE user_id=? ORDER BY updated_at DESC",
                (user_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_portfolio(self, portfolio_id: str, user_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, name, created_at, updated_at FROM portfolios "
                "WHERE id=? AND user_id=?",
                (portfolio_id, user_id),
            ).fetchone()
        return dict(row) if row else None

    def rename_portfolio(self, portfolio_id: str, user_id: str, name: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE portfolios SET name=?, updated_at=? WHERE id=? AND user_id=?",
                (name.strip(), time.time(), portfolio_id, user_id),
            )
            self._conn.commit()
        return cur.rowcount > 0

    def delete_portfolio(self, portfolio_id: str, user_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM portfolios WHERE id=? AND user_id=?",
                (portfolio_id, user_id),
            )
            self._conn.execute(
                "DELETE FROM portfolio_holdings WHERE portfolio_id=?", (portfolio_id,)
            )
            self._conn.commit()
        return cur.rowcount > 0

    # ── Portfolio holdings ────────────────────────────────────

    def get_holdings(self, portfolio_id: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT ticker, mode, name, score, max_score, pct_score, stars, allocation, added_at "
                "FROM portfolio_holdings WHERE portfolio_id=? ORDER BY added_at ASC",
                (portfolio_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def replace_holdings(self, portfolio_id: str, holdings: list) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "DELETE FROM portfolio_holdings WHERE portfolio_id=?", (portfolio_id,)
            )
            self._conn.executemany(
                "INSERT INTO portfolio_holdings "
                "(portfolio_id, ticker, mode, name, score, max_score, pct_score, stars, allocation, added_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                [
                    (portfolio_id, h["ticker"], h["mode"], h.get("name"),
                     h.get("score"), h.get("max_score"), h.get("pct_score"),
                     h.get("stars"), h["allocation"], now)
                    for h in holdings
                ],
            )
            self._conn.execute(
                "UPDATE portfolios SET updated_at=? WHERE id=?", (now, portfolio_id)
            )
            self._conn.commit()

    def upsert_holding(self, portfolio_id: str, holding: dict) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO portfolio_holdings "
                "(portfolio_id, ticker, mode, name, score, max_score, pct_score, stars, allocation, added_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (portfolio_id, holding["ticker"], holding["mode"], holding.get("name"),
                 holding.get("score"), holding.get("max_score"), holding.get("pct_score"),
                 holding.get("stars"), holding["allocation"], now),
            )
            self._conn.execute(
                "UPDATE portfolios SET updated_at=? WHERE id=?", (now, portfolio_id)
            )
            self._conn.commit()

    def remove_holding(self, portfolio_id: str, ticker: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM portfolio_holdings WHERE portfolio_id=? AND ticker=?",
                (portfolio_id, ticker),
            )
            self._conn.execute(
                "UPDATE portfolios SET updated_at=? WHERE id=?", (time.time(), portfolio_id)
            )
            self._conn.commit()
        return cur.rowcount > 0


score_db = ScoreDB(db_path=settings.db_path, ttl_seconds=settings.cache_ttl_seconds)
