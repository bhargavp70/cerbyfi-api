import re
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from anyio import to_thread
from app.models import ScoreResult, ErrorResponse
from app.scorer import score_stock, score_fund
from app.db import score_db
from app.routers.stock import _build_result

_TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,10}$")

router = APIRouter(prefix="/api/analyze", tags=["analyze"])


@router.get(
    "/{ticker}",
    response_model=ScoreResult,
    responses={404: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)
async def analyze_auto(ticker: str) -> ScoreResult:
    ticker = ticker.upper()
    if not _TICKER_RE.match(ticker):
        raise HTTPException(status_code=400, detail="Invalid ticker symbol.")

    # Check both caches first
    for asset_type, key in [("stock", f"stock:{ticker}"), ("fund", f"fund:{ticker}")]:
        cached = score_db.get(key)
        if cached:
            result = ScoreResult(**cached)
            score_db.record_lookup(ticker, asset_type, result.name, result.total,
                                   result.max_total, result.pct, result.stars)
            return result

    # Try stock (Finnhub) first — returns ValueError if ticker not found or profile empty
    try:
        raw = await to_thread.run_sync(lambda: score_stock(ticker))
        asset_type = "stock"
        cache_key  = f"stock:{ticker}"
    except ValueError:
        # Not a stock — try as ETF/fund (FMP)
        try:
            raw = await to_thread.run_sync(lambda: score_fund(ticker))
            asset_type = "fund"
            cache_key  = f"fund:{ticker}"
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    fetched_at = datetime.now(timezone.utc).isoformat()
    result = _build_result(raw, asset_type, cached=False, fetched_at=fetched_at)
    score_db.set(cache_key, result.model_dump())
    score_db.record_lookup(ticker, asset_type, result.name, result.total,
                           result.max_total, result.pct, result.stars)
    return result
