from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from app.routers import stock, fund
from app.models import HealthResponse, CacheStatsResponse
from app.cache import score_cache

app = FastAPI(
    title="BgPanalyzeStock API",
    description="Stock and ETF/Fund scoring API",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "DELETE"],
    allow_headers=["*"],
)

app.include_router(stock.router)
app.include_router(fund.router)


@app.get("/health", response_model=HealthResponse, tags=["meta"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", version="1.0.0")


@app.get("/api/cache/stats", response_model=CacheStatsResponse, tags=["meta"])
def cache_stats() -> CacheStatsResponse:
    return CacheStatsResponse(**score_cache.stats())


@app.delete("/api/cache/{key}", tags=["meta"])
def invalidate_cache(key: str) -> dict:
    evicted = score_cache.invalidate(key)
    return {"evicted": evicted, "key": key}


# Serve frontend — must be last so API routes take priority
_frontend = Path(__file__).parent.parent / "frontend"
if _frontend.exists():
    app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="frontend")
