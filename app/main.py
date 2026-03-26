from fastapi import FastAPI, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from app.routers import stock, fund, analyze, user, watchlist_user, portfolio, admin, premium, prices, market
from app.models import HealthResponse, CacheStatsResponse, TopResponse, TopItem, StatsResponse
from app.db import score_db
from app.auth import require_api_key
from app.config import settings

# Seed config-defined admins into DB on every startup
score_db.seed_admins(settings.admin_email_set)

app = FastAPI(
    title="CerbyFi API",
    description="Stock and ETF/Fund scoring API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
)


@app.middleware("http")
async def force_https(request: Request, call_next):
    """Redirect http:// → https:// using the X-Forwarded-Proto header set by Railway."""
    proto = request.headers.get("x-forwarded-proto")
    if proto == "http":
        url = request.url.replace(scheme="https")
        return RedirectResponse(url=str(url), status_code=301)
    return await call_next(request)


# CORS — locked to known origins (set ALLOWED_ORIGINS in Railway env vars)
_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["*"],
)

# All /api/* routes require a valid X-API-Key header
app.include_router(stock.router,          dependencies=[Depends(require_api_key)])
app.include_router(fund.router,           dependencies=[Depends(require_api_key)])
app.include_router(analyze.router,        dependencies=[Depends(require_api_key)])
app.include_router(user.router)           # no API key — public auth endpoints
app.include_router(watchlist_user.router) # JWT-protected, no X-API-Key needed
app.include_router(portfolio.router)      # JWT-protected portfolio management
app.include_router(admin.router)          # Admin-only endpoints
app.include_router(premium.router)        # Premium-only endpoints
app.include_router(prices.router,         dependencies=[Depends(require_api_key)])
app.include_router(market.router)         # public — no API key needed


@app.get("/config.js", include_in_schema=False)
def frontend_config():
    """Injects the client API key into the browser without storing it in a static file."""
    from fastapi.responses import Response
    key = settings.cerbyfi_api_key or ""
    return Response(
        content=f"window.CERBYFI_API_KEY = '{key}';",
        media_type="application/javascript",
    )


@app.get("/health", response_model=HealthResponse, tags=["meta"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", version="1.0.0")


@app.get("/api/cache/stats", response_model=CacheStatsResponse, tags=["meta"],
         dependencies=[Depends(require_api_key)])
def cache_stats() -> CacheStatsResponse:
    return CacheStatsResponse(**score_db.stats())


@app.delete("/api/cache/{key}", tags=["meta"], dependencies=[Depends(require_api_key)])
def invalidate_cache(key: str) -> dict:
    evicted = score_db.invalidate(key)
    return {"evicted": evicted, "key": key}


@app.get("/api/stats", response_model=StatsResponse, tags=["meta"])
def global_stats() -> StatsResponse:
    return StatsResponse(total_analyses=score_db.total_analyses())


@app.get("/api/top", response_model=TopResponse, tags=["meta"])
def top_tickers() -> TopResponse:
    def to_items(rows: list) -> list:
        return [TopItem(**r) for r in rows]
    return TopResponse(
        stocks=to_items(score_db.top_lookups("stock")),
        funds=to_items(score_db.top_lookups("fund")),
    )


# Serve frontend — must be last so API routes take priority
_frontend = Path(__file__).parent.parent / "frontend"
if _frontend.exists():
    app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="frontend")
