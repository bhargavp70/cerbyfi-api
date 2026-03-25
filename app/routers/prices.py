"""Lightweight real-time price endpoint — no cache, uses Yahoo Finance (no key required)."""
import requests
from fastapi import APIRouter, HTTPException, Query
from anyio import to_thread

router = APIRouter(prefix="/api/price", tags=["price"])

_YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}


def _yahoo_quote(ticker: str) -> dict:
    """
    Fetch current price + daily change from Yahoo Finance chart API.
    Works for both stocks and ETFs; no API key required.
    Returns regularMarketPrice, regularMarketChange, regularMarketChangePercent from meta.
    """
    resp = requests.get(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}",
        params={"interval": "1d", "range": "1d"},
        headers=_YAHOO_HEADERS,
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    result = data.get("chart", {}).get("result")
    if not result:
        raise ValueError("No price data available.")

    meta = result[0].get("meta", {})
    price = meta.get("regularMarketPrice")
    change = meta.get("regularMarketChange") if meta.get("regularMarketChange") is not None \
        else (price - meta["chartPreviousClose"]) if price and meta.get("chartPreviousClose") else None
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    change_pct = (change / prev_close * 100) if (change is not None and prev_close) else None

    if not price or float(price) <= 0:
        raise ValueError("No price data available.")

    return {
        "ticker": ticker,
        "price": round(float(price), 2),
        "price_change": round(float(change), 2) if change is not None else None,
        "price_change_pct": round(float(change_pct), 2) if change_pct is not None else None,
    }


@router.get("/{ticker}")
async def get_live_price(ticker: str, mode: str = Query("stock")):
    """Return current price and daily change. No caching — always live data from Yahoo Finance."""
    ticker = ticker.upper()
    try:
        result = await to_thread.run_sync(lambda: _yahoo_quote(ticker))
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
