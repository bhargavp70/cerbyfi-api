"""Public market data: indices, news, and admin-curated resources."""
import uuid
import requests
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from anyio import to_thread

from app.config import settings
from app.db import score_db
from app.user_auth import require_admin

router = APIRouter(prefix="/api/market", tags=["market"])

_INDICES = [
    {"symbol": "^DJI",  "name": "Dow Jones", "desc": "Dow Jones Industrial Average"},
    {"symbol": "^IXIC", "name": "NASDAQ",     "desc": "NASDAQ Composite"},
    {"symbol": "^GSPC", "name": "S&P 500",    "desc": "Standard & Poor's 500"},
]


def _yahoo_index(symbol: str) -> dict:
    from datetime import date, timezone, timedelta
    resp = requests.get(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
        params={"interval": "5m", "range": "1d"},
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=10,
    )
    result = resp.json()["chart"]["result"][0]
    meta = result["meta"]
    timestamps = result.get("timestamp", [])
    raw_closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])

    # Filter to only today's data points (US/Eastern market session)
    # Yahoo returns timestamps in UTC; market day is determined by ET date
    et_offset = timedelta(hours=-4)  # EDT (UTC-4); close enough for filtering
    today_et = (date.today())
    closes = []
    for ts, c in zip(timestamps, raw_closes):
        if c is None:
            continue
        bar_date = (datetime.fromtimestamp(ts, tz=timezone.utc) + et_offset).date()
        if bar_date == today_et:
            closes.append(round(c, 2))

    # Fallback: use all non-null closes if today filter yields nothing (e.g. weekend/holiday)
    if not closes:
        closes = [round(c, 2) for c in raw_closes if c is not None]

    price = meta.get("regularMarketPrice")
    prev  = meta.get("chartPreviousClose") or meta.get("previousClose")
    change = (price - prev) if (price and prev) else None
    change_pct = (change / prev * 100) if (change and prev) else None
    return {
        "price":      round(price, 2) if price else None,
        "change":     round(change, 2) if change else None,
        "change_pct": round(change_pct, 2) if change_pct else None,
        "sparkline":  closes,
    }


def _fetch_indices() -> list:
    out = []
    for idx in _INDICES:
        entry = {**idx}
        try:
            entry.update(_yahoo_index(idx["symbol"]))
        except Exception:
            entry.update({"price": None, "change": None, "change_pct": None, "sparkline": []})
        out.append(entry)
    return out


def _fetch_news() -> list:
    if not settings.finnhub_api_key:
        return []
    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/news",
            params={"category": "general", "token": settings.finnhub_api_key},
            timeout=10,
        )
        items = resp.json()
        return [
            {
                "headline": item.get("headline", ""),
                "summary":  (item.get("summary") or "")[:200],
                "url":      item.get("url", ""),
                "source":   item.get("source", ""),
                "image":    item.get("image", ""),
                "datetime": item.get("datetime"),
            }
            for item in items[:12]
            if item.get("headline") and item.get("url")
        ]
    except Exception:
        return []


# ── Public endpoint ───────────────────────────────────────

@router.get("")
async def get_market_home():
    """Returns indices, news, and curated resources. No auth required."""
    indices, news = await to_thread.run_sync(lambda: (_fetch_indices(), _fetch_news()))
    resources = score_db.list_resources()
    return {"indices": indices, "news": news, "resources": resources}


# ── Admin resource management ─────────────────────────────

@router.get("/resources")
def list_resources(user_id: str = Depends(require_admin)):
    return score_db.list_resources()


@router.post("/resources")
def create_resource(body: dict, user_id: str = Depends(require_admin)):
    rid = str(uuid.uuid4())
    score_db.upsert_resource(
        id=rid,
        title=body.get("title", "").strip(),
        url=body.get("url", "").strip(),
        description=body.get("description", "").strip(),
        kind=body.get("kind", "article"),
        position=int(body.get("position", 0)),
    )
    return {"id": rid, "ok": True}


@router.put("/resources/{rid}")
def update_resource(rid: str, body: dict, user_id: str = Depends(require_admin)):
    existing = next((r for r in score_db.list_resources() if r["id"] == rid), None)
    if not existing:
        raise HTTPException(status_code=404, detail="Resource not found.")
    score_db.upsert_resource(
        id=rid,
        title=body.get("title", existing["title"]).strip(),
        url=body.get("url", existing["url"]).strip(),
        description=body.get("description", existing.get("description", "")).strip(),
        kind=body.get("kind", existing.get("kind", "article")),
        position=int(body.get("position", existing.get("position", 0))),
    )
    return {"ok": True}


@router.delete("/resources/{rid}")
def delete_resource(rid: str, user_id: str = Depends(require_admin)):
    if not score_db.delete_resource(rid):
        raise HTTPException(status_code=404, detail="Resource not found.")
    return {"ok": True}
