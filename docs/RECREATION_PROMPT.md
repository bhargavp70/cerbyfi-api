# CerbyFi — Complete Recreation Prompt

> Use this document as the master prompt to recreate the entire CerbyFi application from scratch with an AI assistant. Each section can be given sequentially, or the entire document can be provided at once as context.

---

## Overview

Build a web application called **CerbyFi** that scores US stocks and ETFs/funds on a 0–100 point framework, provides portfolio management, and offers AI-powered research briefings via Claude. The application has a FastAPI backend with SQLite persistence and a vanilla JavaScript frontend served as static files.

**Tech Stack:**
- Backend: Python 3.11+, FastAPI, Uvicorn, SQLite (WAL mode)
- Auth: JWT (PyJWT) + bcrypt + optional X-API-Key header
- Data: Finnhub (stocks), Financial Modeling Prep (ETFs), Yahoo Finance (price history)
- AI: Anthropic Claude Sonnet via REST API with `web_search_20250305` tool
- Frontend: Vanilla JS, HTML, CSS — no framework, no bundler
- Deployment: Railway with a volume-mounted SQLite at `/data/cerbyfi.db`

---

## Part 1 — Project Structure

Create the following directory and file layout:

```
project-root/
├── app/
│   ├── __init__.py
│   ├── auth.py              # X-API-Key middleware
│   ├── config.py            # Pydantic-settings config
│   ├── db.py                # SQLite data access layer
│   ├── main.py              # FastAPI app entry point
│   ├── models.py            # Pydantic request/response models
│   ├── user_auth.py         # JWT + bcrypt helpers, FastAPI dependencies
│   ├── configs/
│   │   ├── scoring_config.json        # Stock scoring thresholds
│   │   └── scoring_config_index.json  # ETF/fund scoring thresholds
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── admin.py          # Admin-only endpoints
│   │   ├── analyze.py        # Auto-detect stock vs fund endpoint
│   │   ├── fund.py           # ETF/fund scoring
│   │   ├── portfolio.py      # Portfolio CRUD + optimizer
│   │   ├── premium.py        # AI analysis (Claude)
│   │   ├── stock.py          # Stock scoring
│   │   ├── user.py           # Register / login / me
│   │   └── watchlist_user.py # Watchlist management
│   └── scorer/
│       ├── __init__.py
│       ├── core.py           # Threshold logic, rating labels
│       ├── fetchers.py       # Finnhub, FMP, Yahoo Finance fetchers
│       ├── fund_scorer.py    # ETF scoring orchestrator
│       └── stock_scorer.py   # Stock scoring orchestrator
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── logo.png
│   └── help.html
├── docs/
│   └── PRD.md
├── .env.example
├── requirements.txt
├── runtime.txt              # python-3.11.x
├── Procfile                 # web: uvicorn app.main:app --host 0.0.0.0 --port $PORT
└── railway.toml
```

---

## Part 2 — Dependencies (`requirements.txt`)

```
fastapi>=0.111.0
uvicorn[standard]>=0.29.0
pydantic-settings>=2.2.0
python-dotenv>=1.0.0
requests>=2.31.0
anyio>=4.0.0
PyJWT>=2.8.0
bcrypt>=4.0.0
```

---

## Part 3 — Configuration (`app/config.py`)

Use `pydantic-settings` to read from environment variables:

```python
from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    fmp_api_key: Optional[str] = None
    finnhub_api_key: Optional[str] = None
    cerbyfi_api_key: Optional[str] = None          # Client-facing X-API-Key
    claude_api_key: Optional[str] = None           # Anthropic API key
    cache_ttl_seconds: int = 86400                 # Score cache TTL (24h)
    allowed_origins: str = "*"
    jwt_secret: str = "dev-secret-change-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 30
    admin_emails: str = "admin@example.com"        # Comma-separated

    @property
    def admin_email_set(self) -> set:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def db_path(self) -> str:
        import os
        return "/data/cerbyfi.db" if os.path.isdir("/data") else "/tmp/cerbyfi_cache.db"

    class Config:
        env_file = ".env"

settings = Settings()
```

---

## Part 4 — Database Layer (`app/db.py`)

SQLite with WAL mode and threading lock. Create a `ScoreDB` class with these tables and methods:

### Tables (DDL)

```sql
CREATE TABLE IF NOT EXISTS score_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    stored_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_analysis_cache (
    ticker       TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    generated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS lookups (
    ticker      TEXT NOT NULL,
    asset_type  TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    name        TEXT,
    score       INTEGER,
    max_score   INTEGER,
    pct         REAL,
    stars       INTEGER,
    last_seen   REAL NOT NULL,
    PRIMARY KEY (ticker, asset_type)
);

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    is_premium      INTEGER NOT NULL DEFAULT 0,
    can_refresh_ai  INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL
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
```

### Required Methods

**Score cache:** `get(key)`, `set(key, value)`, `invalidate(key)`, `stats()`

**Lookup tracking:** `record_lookup(ticker, asset_type, name, score, max_score, pct, stars)`, `top_lookups(asset_type, limit=10)`, `total_analyses()`

**Users:** `create_user(id, email, name, password_hash, is_admin)`, `get_user_by_email(email)`, `get_user_by_id(id)`, `list_users()`, `count_users()`, `set_admin(id, bool)`, `set_premium(id, bool)`, `set_can_refresh_ai(id, bool)`, `seed_admins(email_set)`

**Watchlist:** `get_watchlist(user_id)`, `add_to_watchlist(user_id, item_dict)`, `remove_from_watchlist(user_id, ticker)`, `is_in_watchlist(user_id, ticker)`

**Portfolios:** `create_portfolio(id, user_id, name)`, `get_portfolios(user_id)`, `get_portfolio(id, user_id)`, `rename_portfolio(id, user_id, name)`, `delete_portfolio(id, user_id)` (also deletes holdings)

**Portfolio holdings:** `get_holdings(portfolio_id)`, `replace_holdings(portfolio_id, holdings_list)`, `upsert_holding(portfolio_id, holding_dict)`, `remove_holding(portfolio_id, ticker)`

**AI cache (10-day TTL):** `get_ai_analysis(ticker)`, `set_ai_analysis(ticker, text)`, `delete_ai_analysis(ticker)`, `ai_analysis_cache_info(ticker)`, `count_ai_cache()`

---

## Part 5 — Authentication

### API Key Middleware (`app/auth.py`)

All `/api/*` routes require `X-API-Key` header matching `settings.cerbyfi_api_key`. If the key is not set (dev mode), skip validation.

```python
from fastapi import Request, HTTPException
from app.config import settings

async def verify_api_key(request: Request):
    if not settings.cerbyfi_api_key:
        return  # Dev mode — no key required
    key = request.headers.get("X-API-Key", "")
    if key != settings.cerbyfi_api_key:
        raise HTTPException(status_code=401, detail="Invalid API key.")
```

### JWT Auth (`app/user_auth.py`)

```python
import jwt, bcrypt, time, uuid
from fastapi import Depends, HTTPException, Header
from typing import Optional
from app.config import settings
from app.db import score_db

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()

def check_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())

def create_token(user_id: str) -> str:
    exp = time.time() + settings.jwt_expire_days * 86400
    return jwt.encode({"sub": user_id, "exp": exp}, settings.jwt_secret, algorithm=settings.jwt_algorithm)

def decode_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return payload.get("sub")
    except Exception:
        return None

def _extract_user_id(authorization: Optional[str]) -> Optional[str]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return decode_token(authorization[7:])

async def require_user(authorization: Optional[str] = Header(None)) -> str:
    user_id = _extract_user_id(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return user_id

async def optional_user(authorization: Optional[str] = Header(None)) -> Optional[str]:
    return _extract_user_id(authorization)

async def require_premium(authorization: Optional[str] = Header(None)) -> str:
    user_id = _extract_user_id(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required.")
    user = score_db.get_user_by_id(user_id)
    if not user or (not user.get("is_premium") and not user.get("is_admin")):
        raise HTTPException(status_code=403, detail="Premium access required.")
    return user_id

async def require_admin(authorization: Optional[str] = Header(None)) -> str:
    user_id = _extract_user_id(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required.")
    user = score_db.get_user_by_id(user_id)
    if not user or not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required.")
    return user_id
```

---

## Part 6 — Scoring Framework

### Rating Labels (`app/scorer/core.py`)

```python
def get_rating(pct: float) -> tuple[int, str]:
    """Returns (stars, label) for a percentage score 0–100."""
    if pct >= 80: return 5, "Excellent — Strong buy candidate"
    if pct >= 65: return 4, "Good — Worth considering"
    if pct >= 50: return 3, "Fair — Proceed with caution"
    if pct >= 35: return 2, "Weak — Significant concerns"
    return 1, "Poor — Avoid"

def apply_thresholds(value, thresholds: list, direction: str) -> int:
    """
    thresholds: list of (threshold_value, points)
    direction="min": higher is better (e.g., revenue growth %)
    direction="max": lower is better (e.g., P/E ratio)
    Returns the points for the first matching threshold, or last threshold's points as fallback.
    """
    if value is None:
        return thresholds[-1][1]  # fallback minimum
    for threshold, points in thresholds:
        if direction == "min" and value >= threshold:
            return points
        if direction == "max" and value <= threshold:
            return points
    return thresholds[-1][1]
```

### Stock Scoring Categories (`scoring_config.json`)

**Total: 100 points across 5 categories:**

| Category | Metric | Max | Thresholds (direction=min unless noted) |
|----------|--------|-----|----------------------------------------|
| Business Quality | Revenue Growth YoY | 10 | ≥15%→10, ≥8%→7, ≥3%→5, else→2 |
| Business Quality | Operating Margin | 10 | ≥20%→10, ≥12%→7, ≥5%→5, else→2 |
| Business Quality | Moat Proxy (avg gross margin + ROE) | 10 | ≥50%→10, ≥30%→7, ≥10%→3, else→1 |
| Financial Strength | Debt-to-Equity | 10 | ≤30→10, ≤80→7, ≤150→5, else→2 (direction=max) |
| Financial Strength | FCF Margin | 10 | ≥15%→10, ≥8%→7, ≥3%→5, else→2 |
| Growth Potential | EPS Growth YoY | 10 | ≥20%→10, ≥10%→7, ≥0%→4, else→2 |
| Growth Potential | 5-Year Revenue CAGR | 10 | ≥15%→10, ≥8%→7, ≥2%→4, else→2 |
| Valuation | P/E Ratio | 10 | ≤15→10, ≤25→7, ≤40→5, else→2 (direction=max) |
| Valuation | Price/FCF | 10 | ≤20→10, ≤30→7, ≤50→4, else→2 (direction=max) |
| Management | ROE | 5 | ≥20%→5, ≥10%→3, else→1 |
| Management | ROIC | 5 | ≥20%→5, ≥10%→3, else→1 |

**Data source:** Finnhub `/stock/metric?metric=all`

**Finnhub metric mapping:**
- `revenue_growth_yoy` ← `revenueGrowthTTMYoy` (multiply by 100 if fractional)
- `eps_growth` ← `epsGrowthTTMYoy`
- `revenue_growth_5y` ← `revenueGrowth5Y`
- `operatingMargins` ← `operatingMarginTTM` (multiply by 100 if fractional)
- `moat_proxy` ← `(grossMarginTTM + roeTTM) / 2`
- `debtToEquity` ← `totalDebt / totalEquityAnnual * 100`
- `roeTTM` ← `roeTTM`
- `roiTTM` ← `roiTTM`
- `trailingPE` ← `peNormalizedAnnual`
- `price_to_fcf` ← `pfcfShareTTM`
- `fcf_margin` ← derived from `psTTM / pfcfShareTTM`

### ETF/Fund Scoring Categories (`scoring_config_index.json`)

**Total: 100 points across 5 categories:**

| Category | Metric | Max | Thresholds |
|----------|--------|-----|-----------|
| Fund Stability | AUM (USD billions) | 20 | ≥100→20, ≥10→16, ≥1→10, ≥0.1→5, else→1 |
| Risk Profile | Annual Volatility % | 13 | ≤10→13, ≤15→10, ≤20→7, ≤25→3, else→1 (direction=max) |
| Risk Profile | Max Drawdown % | 12 | ≥-15→12, ≥-25→9, ≥-35→6, ≥-50→2, else→0 |
| Returns | 1-Year Return % | 15 | ≥20→15, ≥10→12, ≥5→8, ≥0→4, else→1 |
| Returns | 3-Year Annualized Return % | 15 | ≥15→15, ≥10→12, ≥7→8, ≥3→4, else→1 |
| Valuation | P/E Ratio | 15 | ≤15→15, ≤20→12, ≤25→9, ≤35→5, else→2 (direction=max) |
| Income | Dividend Yield % | 10 | ≥3.0→10, ≥2.0→8, ≥1.0→5, ≥0.5→3, else→1 |

**Data sources:**
- FMP `/stable/profile` → AUM, name, dividend yield, P/E (if available)
- Yahoo Finance `/v8/finance/chart/{ticker}?range=3y&interval=1d` → 3-year daily closes
- Yahoo Finance quoteSummary → P/E fallback (requires crumb/cookie auth)

**Computed from price history:**
```python
daily_returns = [closes[i]/closes[i-1] - 1 for i in range(1, len(closes))]
annual_volatility = (sum(r**2 for r in daily_returns) / len(daily_returns)) ** 0.5 * (252 ** 0.5) * 100
# Max drawdown
peak = closes[0]
max_dd = 0
for c in closes:
    peak = max(peak, c)
    dd = (c - peak) / peak * 100
    max_dd = min(max_dd, dd)
# Returns
one_year_return = (closes[-1] / closes[-252] - 1) * 100  # if enough history
total_return = (closes[-1] / closes[0] - 1)
years = len(closes) / 252
three_yr_annualized = ((1 + total_return) ** (1 / years) - 1) * 100
```

### Score Response Format

All scoring endpoints return:

```json
{
  "ticker": "AAPL",
  "name": "Apple Inc.",
  "type": "stock",
  "total": 78,
  "max_total": 100,
  "pct": 78.0,
  "stars": 4,
  "rating_label": "Good — Worth considering",
  "cached": false,
  "categories": {
    "business_quality": {
      "label": "Business Quality",
      "score": 23,
      "max": 30,
      "pct": 76.7,
      "metrics": [
        {
          "label": "Revenue Growth YoY",
          "value": "12.5%",
          "score": 7,
          "max": 10
        }
      ]
    }
  }
}
```

---

## Part 7 — API Endpoints

### Main App (`app/main.py`)

```python
from fastapi import FastAPI, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.auth import verify_api_key
from app.db import score_db
from app.routers import stock, fund, analyze, user, watchlist_user, portfolio, admin, premium

app = FastAPI()

app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins.split(","),
                  allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# Seed admin users on startup
@app.on_event("startup")
async def startup():
    score_db.seed_admins(settings.admin_email_set)

# Dynamic config.js serving the client API key
@app.get("/config.js")
async def config_js():
    js = f"window.CERBYFI_API_KEY = {repr(settings.cerbyfi_api_key or '')};"
    return Response(content=js, media_type="application/javascript")

# Health + stats
@app.get("/health")
async def health(): return {"status": "ok"}

@app.get("/api/stats")
async def api_stats(_=Depends(verify_api_key)):
    return {"total_analyses": score_db.total_analyses()}

# Top searched
@app.get("/api/top")
async def top_searched(_=Depends(verify_api_key)):
    return {
        "stocks": score_db.top_lookups("stock", 10),
        "funds":  score_db.top_lookups("fund", 10),
    }

# Cache management
@app.get("/api/cache/stats")
async def cache_stats(_=Depends(verify_api_key)):
    return score_db.stats()

@app.delete("/api/cache/{key}")
async def invalidate_cache(key: str, _=Depends(verify_api_key)):
    score_db.invalidate(key)
    return {"ok": True}

# Include all routers
app.include_router(stock.router, dependencies=[Depends(verify_api_key)])
app.include_router(fund.router, dependencies=[Depends(verify_api_key)])
app.include_router(analyze.router, dependencies=[Depends(verify_api_key)])
app.include_router(user.router)           # No API key (auth endpoints)
app.include_router(watchlist_user.router)
app.include_router(portfolio.router)
app.include_router(admin.router)
app.include_router(premium.router)

# Serve frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")
```

### Auth Router (`app/routers/user.py`)

```
POST /api/auth/register  — body: {email, name, password} → creates user (is_admin=True if email in admin_email_set), returns {token, user: {id, name, email, is_admin, is_premium, can_refresh_ai}}
POST /api/auth/login     — body: {email, password} → returns {token, user: {...}}
GET  /api/auth/me        — JWT required → returns {user: {...}}
```

### Stock Router (`app/routers/stock.py`)

```
GET /api/stock/{ticker}  — checks cache first (key="stock:{ticker}"), calls Finnhub, scores, caches, records lookup, returns score response
```

### Fund Router (`app/routers/fund.py`)

```
GET /api/fund/{ticker}   — checks cache first (key="fund:{ticker}"), calls FMP+Yahoo Finance, scores, caches, records lookup, returns score response
```

### Analyze Router (`app/routers/analyze.py`)

```
GET /api/analyze/{ticker} — tries stock scoring first; if Finnhub returns no company profile, falls back to fund scoring
```

### Watchlist Router (`app/routers/watchlist_user.py`)

```
GET    /api/me/watchlist           — JWT required → list watchlist items
POST   /api/me/watchlist           — JWT required → body: {ticker, mode, name, score, max_score, pct, stars, rating}
DELETE /api/me/watchlist/{ticker}  — JWT required
```

### Portfolio Router (`app/routers/portfolio.py`)

```
GET    /api/me/portfolios                                — list portfolios
POST   /api/me/portfolios                               — body: {name}
GET    /api/me/portfolios/{id}                          — detail with holdings
PATCH  /api/me/portfolios/{id}                          — body: {name}
DELETE /api/me/portfolios/{id}                          — delete portfolio + holdings
PUT    /api/me/portfolios/{id}/holdings                 — body: {holdings: [{ticker, mode, name, score, max_score, pct_score, stars, allocation}, ...]} allocations must sum to 100
POST   /api/me/portfolios/{id}/holdings/{ticker}        — body: {mode, name, score, max_score, pct_score, stars, allocation}
DELETE /api/me/portfolios/{id}/holdings/{ticker}
GET    /api/me/portfolios/{id}/optimize                 — returns {optimized_holdings: [...], new_aggregate_pct: float, current_aggregate_pct: float}
```

**Portfolio Optimization Algorithm:**
1. Get all holdings from DB
2. Sort by `pct_score` descending
3. Assign 5% floor to each holding
4. Distribute remaining budget (`100 - 5 * n`) proportionally to top scorers, capped at 60% per holding
5. Fix rounding to ensure exact 100% total
6. Return optimized allocations without saving (user must call PUT to apply)

### Admin Router (`app/routers/admin.py`)

```
GET    /api/admin/stats               — {user_count, total_analyses, ai_reports_cached}
GET    /api/admin/users               — list all users with flags and protected status
PATCH  /api/admin/users/{id}          — body: {is_admin?, is_premium?, can_refresh_ai?} (cannot remove own admin or protected admin's admin status)
DELETE /api/admin/ai-cache/{ticker}   — delete cached AI report
```

### Premium Router (`app/routers/premium.py`)

```
GET  /api/premium/ai-cache/{ticker}   — returns cached AI report if fresh, else {no_cache: true}
POST /api/premium/ai-analyze          — body: {data: {ticker, name, total, max_total, pct, rating_label, type, categories: {...}}, force_refresh?: bool}
```

**AI Analysis Implementation:**

```python
"""
Claude agentic loop with web search.
The web_search_20250305 tool is executed server-side by Anthropic.
We loop until stop_reason == "end_turn", re-submitting tool results.
"""
_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_WEB_SEARCH_TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}

def _call_claude(messages: list, max_turns: int = 12) -> str:
    for _ in range(max_turns):
        res = requests.post(
            _ANTHROPIC_URL,
            headers={
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
                "x-api-key": settings.claude_api_key
            },
            json={
                "model": "claude-sonnet-4-6",
                "max_tokens": 5000,
                "tools": [_WEB_SEARCH_TOOL],
                "messages": messages
            },
            timeout=180
        )
        if not res.ok:
            raise HTTPException(status_code=res.status_code, detail=res.json().get("error", {}).get("message"))

        data = res.json()
        content = data["content"]
        stop_reason = data["stop_reason"]

        if stop_reason == "end_turn":
            text = "\n\n".join(b["text"] for b in content if b.get("type") == "text").strip()
            # Strip Claude's thinking/preamble artifacts
            import re
            text = re.sub(r'^# [^\n]*\n?', '', text, flags=re.MULTILINE)
            text = re.sub(r'^-{3,}\n?', '', text, flags=re.MULTILINE)
            text = re.sub(
                r'^(Now I |Let me |I\'ll |I will |I have |Excellent[,!]|Great[,!]|Perfect[,!])[^\n]*\n?',
                '', text, flags=re.MULTILINE | re.IGNORECASE
            )
            if "## " in text:
                text = text[text.index("## "):]
            return text.strip()

        if stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": content})
            tool_results = [
                {"type": "tool_result", "tool_use_id": b["id"], "content": b.get("content", "")}
                for b in content if b.get("type") == "tool_use"
            ]
            messages.append({"role": "user", "content": tool_results})
        else:
            return "\n\n".join(b["text"] for b in content if b.get("type") == "text").strip()

    raise HTTPException(status_code=504, detail="AI analysis timed out.")
```

**AI Analysis Prompt Template:**

The prompt must instruct Claude to write 8 sections:
1. `## The Company & Its Story` — 2–3 sentences on what the company does
2. `## What the Score Reveals` — connect category scores to business realities
3. `## Recent News & Developments` — 3–4 recent events (last 3–6 months), use web search
4. `## What Analysts Are Saying` — Wall Street sentiment, rating changes, consensus
5. `## Public & Retail Sentiment` — forums, social media, unusual options/institutional moves
6. `## Opportunities & Risks` — 2 opportunities, 2 risks (specific, not generic)
7. `## 5 Questions to Guide Your Research` — numbered 1–5, investor digging questions
8. `## Where to Research Further` — 5–6 named sources (SEC filings, earnings transcripts, etc.)

Critical instructions in the prompt:
- "Start your response DIRECTLY with '## The Company & Its Story' — no title, no preamble, no horizontal rules."
- "Do not narrate your research process."
- "Do not give buy/sell recommendations."

---

## Part 8 — Frontend

### HTML Structure (`frontend/index.html`)

The page has:
- **Header**: Logo + brand name (CerbyFi), analysis counter, auth buttons (Sign in / Register / user menu)
- **Admin Modal**: Stats (user count, analyses, AI cache), user list with role toggles
- **Auth Modal**: Tabbed Sign in / Register forms
- **Main Layout** (two-column):
  - **Left Sidebar** (300px): Watchlist section, Portfolios section, Most Searched section
  - **Right Main**: Search card (ticker input + Analyze button), error display, results display
- **Results Section**: Ticker name + badges, big score number + stars + rating, progress bar, category cards grid, AI Analysis card (premium only)
- **Footer**: Data attribution

### JavaScript Architecture (`frontend/app.js`)

All logic is in a single vanilla JS file. Key global state:

```javascript
const state = {
  token: localStorage.getItem("token") || null,
  user: JSON.parse(localStorage.getItem("user") || "null"),
  lastData: null,           // Last analysis result
  watchlist: [],            // Local cache of watchlist items
  portfolios: [],           // Local cache of portfolios
  activePortfolioId: null   // Currently viewed portfolio
};
```

**API base:** `window.API_BASE` (injected from config; defaults to `""` for same-origin)
**API key:** `window.CERBYFI_API_KEY` (injected via `/config.js`)

**Headers helper:**
```javascript
function apiHeaders(includeAuth = true) {
  const h = { "Content-Type": "application/json", "X-API-Key": window.CERBYFI_API_KEY || "" };
  if (includeAuth && state.token) h["Authorization"] = `Bearer ${state.token}`;
  return h;
}
```

### Frontend Features

**Search flow:**
1. User types ticker → submits form
2. `fetch(/api/analyze/{ticker})`
3. Display results: name, ticker, badge (STOCK/ETF), big score, star rating, category grid
4. If logged in: check watchlist status, show/hide AI section for premium users

**Category cards:** Each category has label, score/max, percentage bar, and collapsible metric rows

**Watchlist:**
- If logged in: server-side at `/api/me/watchlist`
- If not logged in: localStorage fallback
- Watchlist card shows ticker, score bar, star rating, click to re-analyze

**Portfolios:**
- Create/rename/delete portfolios
- Add current stock/fund to portfolio (with allocation %)
- View holdings with individual allocation sliders or direct input
- Aggregate portfolio score displayed as weighted average
- Optimize button runs greedy allocation; Apply button sends PUT to save

**Auth:**
- Login/register via modal
- JWT stored in localStorage
- On sign-in: fetch watchlist from server, show user menu with admin link if applicable

**Admin dashboard:**
- Only visible for `is_admin=true` users
- Shows stats + user list
- Toggle premium/admin/can_refresh_ai per user (inline)

**AI Analysis (Premium):**
- Only shown for `is_premium=true` or `is_admin=true` users
- On ticker load: `GET /api/premium/ai-cache/{ticker}` to auto-load cached report
- If no cache: show "Get AI Analysis" button
- Clicking button: `POST /api/premium/ai-analyze` with full data object
- Refresh button (only for `can_refresh_ai=true`): calls analyze with `force_refresh: true`
- Save as PDF: opens new browser tab with styled HTML version of the report for browser print

**Markdown Rendering (inline, no library):**
```javascript
function parseMarkdown(text) {
  // Protect paragraph breaks
  let result = text
    .replace(/^#{2,4} (.+)$/gm, "<h3>$1</h3>")
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/^[•\-\*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "\x00")   // protect paragraph breaks
    .replace(/\n/g, " ")           // collapse line breaks within paragraphs
    .replace(/\x00/g, "</p><p>");  // restore paragraph breaks
  return `<p>${result}</p>`;
}
```

**PDF Generation (no library):**
```javascript
function downloadAiPdf(ticker, htmlContent) {
  const fullHtml = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <style>
      @page { size: A4; margin: 20mm; }
      @media print { body { -webkit-print-color-adjust: exact; } }
      body { font-family: Georgia, serif; font-size: 15px; line-height: 1.6; }
      h3 { color: #1a1a2e; font-size: 1.15em; margin: 1.4em 0 0.5em; }
      /* ... additional print styles ... */
    </style>
  </head><body>${htmlContent}</body></html>`;

  const blob = new Blob([fullHtml], { type: "text/html; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}
```

### CSS Architecture (`frontend/style.css`)

**Layout:**
- Two-column flex with sidebar 300px, main `flex:1`
- Breakpoint at 780px: single-column, sidebar above main
- CSS variables: `--bg`, `--surface`, `--border`, `--text`, `--muted`, `--primary`, `--green`, `--red`

**Color scheme:** Dark mode
```css
:root {
  --bg: #0d0d1a;
  --surface: #13132a;
  --border: #1f1f3a;
  --text: #e8e8f0;
  --muted: #666680;
  --primary: #6b73ff;
  --green: #4ade80;
  --red: #f87171;
}
```

**Key component styles:**
- `.score-big`: Large score number, `font-size: 3.5rem`
- `.bar-track` / `.bar-fill`: Score progress bars, gradient fill
- `.category-card`: Category breakdown cards, expandable metrics
- `.wl-card`: Watchlist item cards
- `.modal-overlay`: Full-screen overlay with centered modal box
- `.ai-analysis-card`: AI report container
- `.premium-badge`: Gold badge for premium features

---

## Part 9 — Environment Variables

Create `.env` file (do not commit to git):

```
# Required for data fetching
FINNHUB_API_KEY=your_finnhub_key       # Get free key at finnhub.io
FMP_API_KEY=your_fmp_key               # Get at financialmodelingprep.com

# Required for security
CERBYFI_API_KEY=your_random_secret_key # Any random string; clients must send as X-API-Key
JWT_SECRET=your_jwt_secret_at_least_32_chars_long

# Required for AI analysis (premium feature)
CLAUDE_API_KEY=sk-ant-...              # Get at console.anthropic.com

# Optional
CACHE_TTL_SECONDS=86400                # Score cache TTL (default 24h)
ADMIN_EMAILS=admin@example.com         # Comma-separated admin emails
ALLOWED_ORIGINS=http://localhost:8000  # CORS allowed origins
```

---

## Part 10 — Deployment (Railway)

**`Procfile`:**
```
web: uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

**`railway.toml`:**
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "uvicorn app.main:app --host 0.0.0.0 --port $PORT"
healthcheckPath = "/health"
healthcheckTimeout = 30
```

**`runtime.txt`:**
```
python-3.11.9
```

**Railway Setup:**
1. Create project, connect GitHub repo
2. Add volume mounted at `/data` (for persistent SQLite)
3. Set all environment variables in Railway's Variables panel
4. Deploy — `db_path` auto-detects `/data` directory on Railway

---

## Part 11 — Key Design Decisions

**Why SQLite?**
- Single-file database, zero config, persisted via Railway volume
- WAL mode enables concurrent reads without blocking
- Threading lock on all writes for thread safety with Uvicorn workers

**Why no frontend framework?**
- App is primarily server-rendered JSON + simple DOM manipulation
- No build pipeline needed; files served directly as static assets

**Why X-API-Key + JWT?**
- X-API-Key protects all `/api/*` routes from unauthorized direct API calls
- JWT handles user identity (roles, premium status) without sessions

**Why browser print instead of pdf library?**
- html2canvas/html2pdf.js fundamentally breaks long documents (canvas height limits, fixed-interval page slicing cuts text mid-line)
- Browser's native print API uses the full layout engine with proper page-break support

**Why SQLite for AI cache?**
- AI reports are expensive to generate (5–10 web searches, ~30s)
- 10-day TTL avoids redundant calls; same report served to all users for a given ticker

**Cache invalidation strategy:**
- Score cache: 24-hour TTL by default
- AI cache: 10-day TTL; admins can delete manually; users with `can_refresh_ai=true` can force-refresh

---

## Part 12 — User Roles & Permissions Matrix

| Feature | Anonymous | Free User | Premium User | Admin |
|---------|-----------|-----------|--------------|-------|
| Score stocks/ETFs | ✓ | ✓ | ✓ | ✓ |
| View most searched | ✓ | ✓ | ✓ | ✓ |
| Watchlist | Local only | Server-side | Server-side | Server-side |
| Portfolios | — | ✓ | ✓ | ✓ |
| Portfolio optimization | — | ✓ | ✓ | ✓ |
| AI Analysis | — | — | ✓ | ✓ |
| Force-refresh AI | — | — | If flag set | ✓ |
| Admin dashboard | — | — | — | ✓ |
| Manage user roles | — | — | — | ✓ |
| Delete AI cache | — | — | — | ✓ |

---

## Part 13 — Common Gotchas & Implementation Notes

1. **Finnhub metric values**: Some metrics come as decimals (e.g., `0.12` for 12%). Check whether values need ×100 conversion; use value > 1 as a heuristic for already-converted percentages.

2. **Yahoo Finance crumb**: P/E ratio for ETFs requires authenticated Yahoo Finance requests. The crumb must be obtained by fetching `fc.yahoo.com` first, then `/v1/test/getcrumb`. Cache the crumb for ~1 hour.

3. **ETF detection**: FMP returns `isEtf: true` or similar flag. If FMP returns no profile, the ticker is likely invalid. Use this to distinguish stocks from ETFs.

4. **Score cache keys**: Use `"stock:{TICKER}"` and `"fund:{TICKER}"` as cache keys (uppercase ticker).

5. **Admin protection**: Admins listed in `ADMIN_EMAILS` env var are "protected" — their admin status cannot be removed via the admin UI. This prevents accidental lockout.

6. **JWT expiry**: 30-day tokens. On 401 from any API call, clear localStorage and show sign-in modal.

7. **Claude web search**: `web_search_20250305` is executed server-side by Anthropic — we never see raw search results. We just get the assistant's response incorporating search results, or a `tool_use` block that we re-submit as `tool_result` with the content Anthropic already populated.

8. **force_refresh check**: Use strict identity check in Python: `body.get("force_refresh") is True` (not `== True`) to avoid accidental truthy values.

9. **Portfolio aggregate score**: `Σ (allocation_i / 100) × pct_score_i` — a weighted average of percentage scores, not raw scores.

10. **CORS**: Set `ALLOWED_ORIGINS` to the Railway deployment URL in production. Multiple origins comma-separated.

---

## Quick Start (Local Development)

```bash
# Clone and set up
git clone <repo>
cd project-root
pip install -r requirements.txt

# Create .env
cp .env.example .env
# Edit .env with your API keys

# Run
uvicorn app.main:app --reload --port 8000

# Visit
open http://localhost:8000
```

---

*This document was generated to enable full recreation of the CerbyFi application. All scoring thresholds, database schema, API contracts, and frontend architecture are documented above.*
