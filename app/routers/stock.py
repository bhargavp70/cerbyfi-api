from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from anyio import to_thread
from app.models import ScoreResult, ErrorResponse, CategoryResult, MetricResult
from app.scorer import score_stock
from app.cache import score_cache
from app.scorer.core import rating_label

router = APIRouter(prefix="/api/stock", tags=["stock"])


def _build_result(raw: dict, asset_type: str, cached: bool, fetched_at: str) -> ScoreResult:
    max_total = sum(c["max"] for c in raw["categories"].values())
    total     = raw["total"]
    pct       = round(total / max_total * 100, 1) if max_total else 0
    stars, label = rating_label(total)

    categories = {
        k: CategoryResult(
            label=v["label"],
            score=v["score"],
            max=v["max"],
            pct=round(v["score"] / v["max"] * 100, 1) if v["max"] else 0,
            metrics={
                mk: MetricResult(**mv)
                for mk, mv in v["metrics"].items()
            },
        )
        for k, v in raw["categories"].items()
    }

    return ScoreResult(
        ticker=raw["ticker"],
        name=raw["name"],
        type=asset_type,
        total=total,
        max_total=max_total,
        pct=pct,
        stars=stars,
        rating_label=label,
        categories=categories,
        cached=cached,
        fetched_at=fetched_at,
    )


@router.get(
    "/{ticker}",
    response_model=ScoreResult,
    responses={404: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)
async def analyze_stock(ticker: str) -> ScoreResult:
    key = f"stock:{ticker.upper()}"
    cached = score_cache.get(key)
    if cached:
        return ScoreResult(**cached)

    try:
        raw = await to_thread.run_sync(lambda: score_stock(ticker.upper()))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    fetched_at = datetime.now(timezone.utc).isoformat()
    result = _build_result(raw, "stock", cached=False, fetched_at=fetched_at)
    score_cache.set(key, result.model_dump())
    return result
