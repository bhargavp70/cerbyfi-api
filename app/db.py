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

CREATE TABLE IF NOT EXISTS ai_analysis_cache (
    ticker      TEXT PRIMARY KEY,
    text        TEXT    NOT NULL,
    generated_at REAL   NOT NULL
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
    is_admin         INTEGER NOT NULL DEFAULT 0,
    is_premium       INTEGER NOT NULL DEFAULT 0,
    can_refresh_ai   INTEGER NOT NULL DEFAULT 0,
    created_at       REAL NOT NULL
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

CREATE TABLE IF NOT EXISTS resources (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    description TEXT,
    kind        TEXT NOT NULL DEFAULT 'article',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL
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
            # Migrations: add columns to existing installs
            for col_sql in [
                "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE users ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE users ADD COLUMN can_refresh_ai INTEGER NOT NULL DEFAULT 0",
            ]:
                try:
                    self._conn.execute(col_sql)
                except Exception:
                    pass  # column already exists
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

    def seed_admins(self, admin_emails: set) -> None:
        """Ensure all config-defined admin emails have is_admin=1 in the DB."""
        if not admin_emails:
            return
        with self._lock:
            for email in admin_emails:
                self._conn.execute(
                    "UPDATE users SET is_admin=1 WHERE email=?", (email.lower(),)
                )
            self._conn.commit()

    def create_user(self, user_id: str, email: str, name: str, password_hash: str, is_admin: bool = False) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO users (id, email, name, password_hash, is_admin, is_premium, created_at) VALUES (?,?,?,?,?,0,?)",
                (user_id, email.lower().strip(), name.strip(), password_hash, int(is_admin), time.time()),
            )
            self._conn.commit()

    def get_user_by_email(self, email: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, email, name, password_hash, is_admin, is_premium, can_refresh_ai FROM users WHERE email=?",
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
                "SELECT id, email, name, is_admin, is_premium, can_refresh_ai FROM users WHERE id=?", (user_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_users(self) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, email, name, is_admin, is_premium, can_refresh_ai, created_at FROM users ORDER BY created_at ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def set_admin(self, user_id: str, is_admin: bool) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE users SET is_admin=? WHERE id=?", (int(is_admin), user_id)
            )
            self._conn.commit()
        return cur.rowcount > 0

    def set_premium(self, user_id: str, is_premium: bool) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE users SET is_premium=? WHERE id=?", (int(is_premium), user_id)
            )
            self._conn.commit()
        return cur.rowcount > 0

    def set_can_refresh_ai(self, user_id: str, enabled: bool) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE users SET can_refresh_ai=? WHERE id=?", (int(enabled), user_id)
            )
            self._conn.commit()
        return cur.rowcount > 0

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

    # ── AI Analysis cache ─────────────────────────────────────

    _AI_CACHE_TTL = 10 * 24 * 3600  # 10 days

    def count_ai_cache(self) -> int:
        cutoff = time.time() - self._AI_CACHE_TTL
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) FROM ai_analysis_cache WHERE generated_at > ?", (cutoff,)
            ).fetchone()
        return int(row[0])

    def get_ai_analysis(self, ticker: str) -> Optional[str]:
        with self._lock:
            row = self._conn.execute(
                "SELECT text, generated_at FROM ai_analysis_cache WHERE ticker=?",
                (ticker.upper(),),
            ).fetchone()
        if row is None:
            return None
        if time.time() - row["generated_at"] > self._AI_CACHE_TTL:
            with self._lock:
                self._conn.execute(
                    "DELETE FROM ai_analysis_cache WHERE ticker=?", (ticker.upper(),)
                )
                self._conn.commit()
            return None
        return row["text"]

    def set_ai_analysis(self, ticker: str, text: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO ai_analysis_cache (ticker, text, generated_at) VALUES (?,?,?)",
                (ticker.upper(), text, time.time()),
            )
            self._conn.commit()

    def delete_ai_analysis(self, ticker: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM ai_analysis_cache WHERE ticker=?", (ticker.upper(),))
            self._conn.commit()

    def ai_analysis_cache_info(self, ticker: str) -> Optional[float]:
        """Returns generated_at timestamp if a live cache entry exists, else None."""
        with self._lock:
            row = self._conn.execute(
                "SELECT generated_at FROM ai_analysis_cache WHERE ticker=?",
                (ticker.upper(),),
            ).fetchone()
        if row is None:
            return None
        if time.time() - row["generated_at"] > self._AI_CACHE_TTL:
            return None
        return row["generated_at"]


    # ── Resources ─────────────────────────────────────────────

    def list_resources(self) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM resources ORDER BY position ASC, created_at ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def upsert_resource(self, id: str, title: str, url: str,
                        description: str, kind: str, position: int) -> None:
        with self._lock:
            self._conn.execute(
                """INSERT INTO resources (id, title, url, description, kind, position, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     title=excluded.title, url=excluded.url,
                     description=excluded.description, kind=excluded.kind,
                     position=excluded.position""",
                (id, title, url, description, kind, position, time.time()),
            )
            self._conn.commit()

    def delete_resource(self, id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM resources WHERE id=?", (id,))
            self._conn.commit()
        return cur.rowcount > 0


score_db = ScoreDB(db_path=settings.db_path, ttl_seconds=settings.cache_ttl_seconds)
