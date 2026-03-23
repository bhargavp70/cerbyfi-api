# CerbyFi API

Stock and ETF/fund scoring API with a built-in frontend. Scores any US stock or ETF on a 100-point framework across multiple categories (valuation, growth, profitability, momentum, etc.).

## Features

- **Auto-detect stock vs ETF** — single input, no tabs. Tries Finnhub (stocks) first, falls back to FMP (ETFs/funds).
- **100-point scoring framework** — weighted categories with per-metric breakdowns.
- **User accounts** — email + password registration, JWT auth (30-day tokens).
- **Persistent watchlist** — server-side per user when logged in, localStorage fallback when not.
- **Portfolios** — create named portfolios, set % allocations, view weighted aggregate score, and run the greedy optimizer to find the best allocation (5% floor, 60% cap per holding).
- **Most Searched** — tracks lookup counts, shows top 10 stocks and ETFs.
- **Analysis counter** — running total of all analyses shown in the header.
- **Persistent cache** — SQLite with WAL mode. Uses `/data/cerbyfi.db` when a Railway volume is mounted at `/data`, otherwise `/tmp`.

## Data Sources

| Source | Used for |
|---|---|
| [Finnhub](https://finnhub.io) | Stock fundamentals, metrics, profile |
| [Financial Modeling Prep](https://financialmodelingprep.com) | ETF/fund profile |
| [Yahoo Finance](https://finance.yahoo.com) | ETF P/E ratio (via quoteSummary + crumb auth) |

## Tech Stack

- **Backend**: FastAPI + Uvicorn, SQLite (WAL), PyJWT, bcrypt
- **Frontend**: Vanilla JS + CSS, no build step
- **Deployment**: Railway (single service, static files served by FastAPI)

## Project Structure

```
app/
  main.py              # FastAPI app, CORS, static file serving
  config.py            # Settings (env vars via pydantic-settings)
  db.py                # SQLite store: cache, lookups, users, watchlist, portfolios
  auth.py              # X-API-Key middleware
  user_auth.py         # JWT + bcrypt helpers, require_user / optional_user deps
  models.py            # Pydantic models
  routers/
    analyze.py         # GET /api/analyze/{ticker} — auto-detect + score
    stock.py           # GET /api/stock/{ticker}
    fund.py            # GET /api/fund/{ticker}
    user.py            # POST /api/auth/register|login, GET /api/auth/me
    watchlist_user.py  # GET/POST /api/me/watchlist, DELETE /api/me/watchlist/{ticker}
    portfolio.py       # CRUD /api/me/portfolios, greedy optimizer
  scorer/
    fetchers.py        # Finnhub + FMP + Yahoo Finance data fetching
    stock_scorer.py    # Stock scoring logic
    fund_scorer.py     # ETF/fund scoring logic
frontend/
  index.html
  app.js
  style.css
  logo.png
  config.js            # Served dynamically by FastAPI (injects API key)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `FINNHUB_API_KEY` | Finnhub API key (required for stocks) | — |
| `FMP_API_KEY` | Financial Modeling Prep key (required for ETFs) | — |
| `CERBYFI_API_KEY` | Client-facing API key (injected into frontend) | — |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | — |
| `JWT_SECRET` | Secret for signing JWTs — **change in production** | `dev-secret-change-in-production` |
| `JWT_EXPIRE_DAYS` | Token lifetime in days | `30` |
| `DB_PATH` | SQLite file path | `/data/cerbyfi.db` if `/data` exists, else `/tmp/cerbyfi_cache.db` |
| `CACHE_TTL_SECONDS` | Score cache TTL | `86400` (24h) |

## Running Locally

```bash
pip install -r requirements.txt
cp .env.example .env   # fill in API keys
uvicorn app.main:app --reload
```

Open `http://localhost:8000`.

## Deploying to Railway

1. Connect this repo to a Railway project.
2. Set all environment variables above in Railway settings.
3. Add a **Volume** mounted at `/data` for persistent SQLite storage across deploys.
4. Railway auto-deploys on push to `main`.

## API Overview

All `/api/*` routes require `X-API-Key: <CERBYFI_API_KEY>` header (except auth endpoints).
JWT-protected routes also require `Authorization: Bearer <token>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/analyze/{ticker}` | API key | Auto-detect and score a stock or ETF |
| GET | `/api/stock/{ticker}` | API key | Score a stock |
| GET | `/api/fund/{ticker}` | API key | Score an ETF/fund |
| GET | `/api/top` | API key | Top 10 most searched stocks and ETFs |
| GET | `/api/stats` | — | Total analysis count |
| GET | `/health` | — | Health check |
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Sign in, get JWT |
| GET | `/api/auth/me` | JWT | Get current user |
| GET | `/api/me/watchlist` | JWT | Get watchlist |
| POST | `/api/me/watchlist` | JWT | Add to watchlist |
| DELETE | `/api/me/watchlist/{ticker}` | JWT | Remove from watchlist |
| GET | `/api/me/portfolios` | JWT | List portfolios |
| POST | `/api/me/portfolios` | JWT | Create portfolio |
| GET | `/api/me/portfolios/{id}` | JWT | Get portfolio |
| PATCH | `/api/me/portfolios/{id}` | JWT | Rename portfolio |
| DELETE | `/api/me/portfolios/{id}` | JWT | Delete portfolio |
| PUT | `/api/me/portfolios/{id}/holdings` | JWT | Replace all holdings (allocations must sum to 100) |
| POST | `/api/me/portfolios/{id}/holdings/{ticker}` | JWT | Upsert a holding |
| DELETE | `/api/me/portfolios/{id}/holdings/{ticker}` | JWT | Remove a holding |
| GET | `/api/me/portfolios/{id}/optimize` | JWT | Get greedy-optimized allocation |

## Portfolio Optimizer

The optimizer uses a greedy algorithm to maximize the weighted aggregate score subject to per-holding constraints:

- **Floor**: every holding gets at least 5%
- **Cap**: no single holding exceeds 60%
- **Method**: remaining budget (after floors) is allocated to the highest-scoring holdings first, each up to the cap
- **Guarantee**: always produces a score ≥ the current allocation
