import re
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from anyio import to_thread
from app.models import ScoreResult, ErrorResponse
from app.scorer import score_fund
from app.cache import score_cache
from app.routers.stock import _build_result

_TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,10}$")

router = APIRouter(prefix="/api/fund", tags=["fund"])


@router.get(
    "/{ticker}",
    response_model=ScoreResult,
    responses={404: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)
async def analyze_fund(ticker: str) -> ScoreResult:
    ticker = ticker.upper()
    if not _TICKER_RE.match(ticker):
        raise HTTPException(status_code=400, detail="Invalid ticker symbol.")
    key = f"fund:{ticker}"
    cached = score_cache.get(key)
    if cached:
        return ScoreResult(**cached)

    try:
        raw = await to_thread.run_sync(lambda: score_fund(ticker.upper()))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    fetched_at = datetime.now(timezone.utc).isoformat()
    result = _build_result(raw, "fund", cached=False, fetched_at=fetched_at)
    score_cache.set(key, result.model_dump())
    return result
