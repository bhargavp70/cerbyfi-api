"""Lightweight real-time price endpoint — not cached, called during market hours."""
from fastapi import APIRouter, HTTPException, Query
from anyio import to_thread
from app.scorer.fetchers import _fh_get, _fmp_get

router = APIRouter(prefix="/api/price", tags=["price"])


def _fetch_stock_quote(ticker: str) -> dict:
    quote = _fh_get("/quote", symbol=ticker)
    price = quote.get("c")
    if not price or float(price) <= 0:
        raise ValueError("No quote data available.")
    return {
        "ticker": ticker,
        "price": round(float(price), 2),
        "price_change": round(float(quote["d"]), 2) if quote.get("d") is not None else None,
        "price_change_pct": round(float(quote["dp"]), 2) if quote.get("dp") is not None else None,
    }


def _fetch_fund_quote(ticker: str) -> dict:
    profile = _fmp_get("/stable/profile", symbol=ticker)
    if not profile or not isinstance(profile, list):
        raise ValueError("No quote data available.")
    p = profile[0]
    price = p.get("price")
    if not price or float(price) <= 0:
        raise ValueError("No quote data available.")
    change = p.get("changes")
    change_pct = p.get("changesPercentage")
    return {
        "ticker": ticker,
        "price": round(float(price), 2),
        "price_change": round(float(change), 2) if change is not None else None,
        "price_change_pct": round(float(change_pct), 2) if change_pct is not None else None,
    }


@router.get("/{ticker}")
async def get_live_price(ticker: str, mode: str = Query("stock")):
    """Return current price and daily change. No caching — always live."""
    ticker = ticker.upper()
    try:
        if mode == "fund":
            result = await to_thread.run_sync(lambda: _fetch_fund_quote(ticker))
        else:
            result = await to_thread.run_sync(lambda: _fetch_stock_quote(ticker))
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
