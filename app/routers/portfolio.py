"""Portfolio management: create, manage holdings, optimize allocations."""
import uuid
import requests as _requests
from datetime import datetime
from typing import List, Optional
from anyio import to_thread
from fastapi import APIRouter, Depends, HTTPException
from app.db import score_db
from app.user_auth import require_user
from app.models import (
    HoldingIn, HoldingOut, HoldingsIn,
    PortfolioOut, OptimizedHolding, OptimizeResponse,
)

_YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}

router = APIRouter(prefix="/api/me/portfolios", tags=["portfolio"])

# ── Helpers ───────────────────────────────────────────────

def _aggregate_score(holdings: list) -> Optional[float]:
    if not holdings:
        return None
    total = 0.0
    for h in holdings:
        if h.get("pct_score") is None:
            return None
        total += (h["allocation"] / 100.0) * h["pct_score"]
    return round(total, 2)


def _fetch_beta_sync(ticker: str) -> float:
    """Fetch beta from Yahoo Finance. Returns 1.0 on failure."""
    try:
        r = _requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}",
            params={"interval": "1d", "range": "1d"},
            headers=_YAHOO_HEADERS,
            timeout=8,
        )
        meta = r.json().get("chart", {}).get("result", [{}])[0].get("meta", {})
        beta = meta.get("beta")
        return float(beta) if beta and beta > 0 else 1.0
    except Exception:
        return 1.0


def _optimize(holdings: list, floor: float = 5.0, cap: float = 50.0,
              risk_weighted: bool = False) -> list:
    """
    Multi-factor category-complementarity optimization with:
    - Per-holding max_alloc caps
    - Optional beta-based risk penalty (risk_weighted=True)
    - Top-category driver tracking per holding
    """
    n = len(holdings)
    if n == 0:
        return holdings
    if n == 1:
        return [{**holdings[0], "optimized_allocation": 100.0,
                 "top_category": None, "top_category_pct": None,
                 "risk_penalty": 1.0, "capped": False}]

    # ── Per-holding effective caps (respect max_alloc if set) ─────────────
    per_caps = []
    for h in holdings:
        ma = h.get("max_alloc")
        if ma and 0 < ma < 100:
            per_caps.append(float(ma))
        else:
            per_caps.append(cap)

    # ── Risk weights (beta penalty) ────────────────────────────────────────
    risk_penalties = [1.0] * n
    if risk_weighted:
        betas = [_fetch_beta_sync(h["ticker"]) for h in holdings]
        # Penalty = 1 / sqrt(beta), floored at 0.4 so high-beta stocks
        # are penalised but not eliminated entirely
        import math
        risk_penalties = [max(0.4, 1.0 / math.sqrt(b)) for b in betas]

    # ── Pull per-category scores from cache ───────────────────────────────
    cat_scores: list[dict] = []
    all_cats: set = set()
    for h in holdings:
        cached = score_db.get(f"{h['mode']}:{h['ticker']}")
        cats: dict = {}
        if cached and "categories" in cached:
            for k, v in cached["categories"].items():
                cats[k] = float(v.get("pct", 0.0))
                all_cats.add(k)
        cat_scores.append(cats)

    # Fill gaps with overall pct_score
    for i, h in enumerate(holdings):
        overall = float(h.get("pct_score") or 0.0)
        if not cat_scores[i]:
            for c in all_cats:
                cat_scores[i][c] = overall
        else:
            for c in all_cats:
                if c not in cat_scores[i]:
                    cat_scores[i][c] = overall

    # ── No category data → proportional overall score ─────────────────────
    if not all_cats:
        total_pct = sum(float(h.get("pct_score") or 0.0) * risk_penalties[i]
                        for i, h in enumerate(holdings)) or 1.0
        alloc = [floor] * n
        remaining = 100.0 - floor * n
        for i, h in enumerate(holdings):
            eff_cap = min(per_caps[i], 100.0 - floor * (n - 1))
            extra = (float(h.get("pct_score") or 0.0) * risk_penalties[i] / total_pct) * remaining
            alloc[i] += min(extra, eff_cap - floor)
        alloc = [round(a, 1) for a in alloc]
        drift = round(100.0 - sum(alloc), 1)
        if drift != 0:
            alloc[0] = round(alloc[0] + drift, 1)
        return [{**h, "optimized_allocation": alloc[i],
                 "top_category": None, "top_category_pct": None,
                 "risk_penalty": round(risk_penalties[i], 3), "capped": alloc[i] >= per_caps[i] - 0.1}
                for i, h in enumerate(holdings)]

    # ── Per-category fractional contributions × risk penalty ──────────────
    contributions = [0.0] * n
    cat_contrib: list[dict] = [{} for _ in range(n)]   # per-holding per-cat contribution
    for cat in all_cats:
        scores_in_cat = [cat_scores[i][cat] * risk_penalties[i] for i in range(n)]
        total = sum(scores_in_cat) or 1.0
        for i in range(n):
            share = scores_in_cat[i] / total
            contributions[i] += share
            cat_contrib[i][cat] = share

    # ── Top category driver per holding ───────────────────────────────────
    top_cats = []
    for i in range(n):
        if cat_contrib[i]:
            best_cat = max(cat_contrib[i], key=lambda c: cat_contrib[i][c])
            top_cats.append((best_cat, round(cat_scores[i].get(best_cat, 0.0), 1)))
        else:
            top_cats.append((None, None))

    # ── Allocate with per-holding caps ────────────────────────────────────
    total_contrib = sum(contributions) or 1.0
    alloc = [floor] * n
    for i in range(n):
        eff_cap = per_caps[i]
        extra = (contributions[i] / total_contrib) * (100.0 - floor * n)
        alloc[i] += min(extra, eff_cap - floor)

    # ── Re-normalise to exactly 100 ───────────────────────────────────────
    for _ in range(30):
        total = sum(alloc)
        diff = 100.0 - total
        if abs(diff) < 0.01:
            break
        receivers = [i for i in range(n)
                     if (diff > 0 and alloc[i] < per_caps[i] - 0.01)
                     or (diff < 0 and alloc[i] > floor + 0.01)]
        if not receivers:
            break
        share = diff / len(receivers)
        for i in receivers:
            alloc[i] = max(floor, min(per_caps[i], alloc[i] + share))

    alloc = [round(a, 1) for a in alloc]
    drift = round(100.0 - sum(alloc), 1)
    if drift != 0:
        most_room = max(range(n), key=lambda i: per_caps[i] - alloc[i])
        alloc[most_room] = round(alloc[most_room] + drift, 1)

    return [{
        **h,
        "optimized_allocation": alloc[i],
        "top_category": top_cats[i][0],
        "top_category_pct": top_cats[i][1],
        "risk_penalty": round(risk_penalties[i], 3),
        "capped": alloc[i] >= per_caps[i] - 0.11,
    } for i, h in enumerate(holdings)]


def _build_portfolio_out(p: dict, holdings: list) -> PortfolioOut:
    return PortfolioOut(
        id=p["id"],
        name=p["name"],
        created_at=p["created_at"],
        updated_at=p["updated_at"],
        holdings=[HoldingOut(**{k: h[k] for k in HoldingOut.model_fields}) for h in holdings],
        aggregate_score=_aggregate_score(holdings),
    )


# ── Routes ────────────────────────────────────────────────

@router.get("", response_model=List[PortfolioOut])
def list_portfolios(user_id: str = Depends(require_user)):
    portfolios = score_db.get_portfolios(user_id)
    result = []
    for p in portfolios:
        holdings = score_db.get_holdings(p["id"])
        result.append(_build_portfolio_out(p, holdings))
    return result


@router.post("", response_model=PortfolioOut)
def create_portfolio(body: dict, user_id: str = Depends(require_user)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Portfolio name is required.")
    portfolio_id = str(uuid.uuid4())
    score_db.create_portfolio(portfolio_id, user_id, name)
    p = score_db.get_portfolio(portfolio_id, user_id)
    return _build_portfolio_out(p, [])


@router.get("/{portfolio_id}", response_model=PortfolioOut)
def get_portfolio(portfolio_id: str, user_id: str = Depends(require_user)):
    p = score_db.get_portfolio(portfolio_id, user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    return _build_portfolio_out(p, score_db.get_holdings(portfolio_id))


@router.patch("/{portfolio_id}")
def rename_portfolio(portfolio_id: str, body: dict, user_id: str = Depends(require_user)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name is required.")
    if not score_db.rename_portfolio(portfolio_id, user_id, name):
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    return {"ok": True}


@router.delete("/{portfolio_id}")
def delete_portfolio(portfolio_id: str, user_id: str = Depends(require_user)):
    if not score_db.delete_portfolio(portfolio_id, user_id):
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    return {"ok": True}


@router.put("/{portfolio_id}/holdings")
def replace_holdings(portfolio_id: str, body: HoldingsIn, user_id: str = Depends(require_user)):
    if not score_db.get_portfolio(portfolio_id, user_id):
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    total = sum(h.allocation for h in body.holdings)
    if body.holdings and abs(total - 100.0) > 1.0:
        raise HTTPException(
            status_code=422,
            detail=f"Allocations must sum to 100. Got {total:.1f}."
        )
    score_db.replace_holdings(portfolio_id, [h.model_dump() for h in body.holdings])
    return {"ok": True}


@router.post("/{portfolio_id}/holdings/{ticker}")
def upsert_holding(
    portfolio_id: str, ticker: str,
    body: HoldingIn, user_id: str = Depends(require_user)
):
    if not score_db.get_portfolio(portfolio_id, user_id):
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    data = body.model_dump()
    data["ticker"] = ticker.upper()
    score_db.upsert_holding(portfolio_id, data)
    return {"ok": True}


@router.delete("/{portfolio_id}/holdings/{ticker}")
def remove_holding(portfolio_id: str, ticker: str, user_id: str = Depends(require_user)):
    if not score_db.get_portfolio(portfolio_id, user_id):
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    score_db.remove_holding(portfolio_id, ticker.upper())
    return {"ok": True}


@router.get("/{portfolio_id}/optimize", response_model=OptimizeResponse)
async def optimize_portfolio(
    portfolio_id: str,
    risk_weighted: bool = False,
    user_id: str = Depends(require_user)
):
    p = score_db.get_portfolio(portfolio_id, user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    holdings = score_db.get_holdings(portfolio_id)
    if not holdings:
        raise HTTPException(status_code=422, detail="Portfolio has no holdings.")

    current_score = _aggregate_score(holdings) or 0.0

    # Run optimizer in thread (may fetch betas via HTTP if risk_weighted)
    optimized = await to_thread.run_sync(
        lambda: _optimize(holdings, risk_weighted=risk_weighted)
    )

    for h in optimized:
        h["allocation"] = h["optimized_allocation"]
    optimized_score = _aggregate_score(optimized) or 0.0

    return OptimizeResponse(
        current_score=current_score,
        optimized_score=round(optimized_score, 2),
        risk_weighted=risk_weighted,
        holdings=[
            OptimizedHolding(
                ticker=h["ticker"],
                name=h.get("name"),
                current_allocation=h_orig["allocation"],
                optimized_allocation=h["optimized_allocation"],
                top_category=h.get("top_category"),
                top_category_pct=h.get("top_category_pct"),
                risk_penalty=h.get("risk_penalty"),
                capped=h.get("capped"),
            )
            for h, h_orig in zip(optimized, holdings)
        ],
    )


# ── Performance (money tracking) ──────────────────────────

def _fetch_price_and_dividends_sync(ticker: str, purchase_date: Optional[str]):
    """Fetch current price and dividends-since-purchase from Yahoo Finance (sync)."""
    try:
        r = _requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}",
            params={"interval": "1d", "range": "10y", "events": "dividends"},
            headers=_YAHOO_HEADERS,
            timeout=12,
        )
        data = r.json()
        result = data.get("chart", {}).get("result", [{}])[0]
        meta = result.get("meta", {})
        current_price = meta.get("regularMarketPrice") or meta.get("previousClose")

        dividends_per_share = 0.0
        cutoff = 0.0
        if purchase_date:
            try:
                cutoff = datetime.strptime(purchase_date, "%Y-%m-%d").timestamp()
            except Exception:
                pass
        divs = result.get("events", {}).get("dividends", {})
        for entry in divs.values():
            if entry.get("date", 0) >= cutoff:
                dividends_per_share += float(entry.get("amount", 0))

        return current_price, dividends_per_share
    except Exception:
        return None, 0.0


@router.get("/{portfolio_id}/performance")
async def portfolio_performance(portfolio_id: str, user_id: str = Depends(require_user)):
    p = score_db.get_portfolio(portfolio_id, user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    holdings = score_db.get_holdings(portfolio_id)

    # Fetch prices + dividends sequentially in a thread (proven pattern matching prices.py)
    def fetch_all():
        return [_fetch_price_and_dividends_sync(h["ticker"], h.get("purchase_date")) for h in holdings]

    results = await to_thread.run_sync(fetch_all)

    portfolio_invested = 0.0
    portfolio_value = 0.0
    portfolio_dividends = 0.0
    holding_perf = []

    for h, (current_price, div_per_share) in zip(holdings, results):
        shares = h.get("shares") or 0.0
        avg_cost = h.get("avg_cost") or 0.0
        has_money = shares > 0 and avg_cost > 0

        invested = shares * avg_cost if has_money else None
        current_value = (shares * current_price) if (has_money and current_price) else None
        dividends_received = (shares * div_per_share) if has_money else None
        price_gain = (current_value - invested) if (current_value is not None and invested is not None) else None
        total_return = ((price_gain or 0) + (dividends_received or 0)) if (price_gain is not None) else None
        price_gain_pct = ((price_gain / invested) * 100) if (price_gain is not None and invested) else None
        total_return_pct = ((total_return / invested) * 100) if (total_return is not None and invested) else None

        if invested: portfolio_invested += invested
        if current_value: portfolio_value += current_value
        if dividends_received: portfolio_dividends += dividends_received

        holding_perf.append({
            "ticker": h["ticker"],
            "name": h.get("name"),
            "shares": shares if has_money else None,
            "avg_cost": avg_cost if has_money else None,
            "purchase_date": h.get("purchase_date"),
            "current_price": round(current_price, 4) if current_price else None,
            "invested": round(invested, 2) if invested else None,
            "current_value": round(current_value, 2) if current_value else None,
            "price_gain": round(price_gain, 2) if price_gain is not None else None,
            "price_gain_pct": round(price_gain_pct, 2) if price_gain_pct is not None else None,
            "dividends_received": round(dividends_received, 2) if dividends_received else None,
            "total_return": round(total_return, 2) if total_return is not None else None,
            "total_return_pct": round(total_return_pct, 2) if total_return_pct is not None else None,
        })

    total_gain = portfolio_value - portfolio_invested if portfolio_invested else None
    total_return_all = (total_gain + portfolio_dividends) if total_gain is not None else None
    total_return_pct_all = ((total_return_all / portfolio_invested) * 100) if (total_return_all is not None and portfolio_invested) else None

    return {
        "portfolio_id": portfolio_id,
        "total_invested": round(portfolio_invested, 2) if portfolio_invested else None,
        "total_current_value": round(portfolio_value, 2) if portfolio_value else None,
        "total_dividends": round(portfolio_dividends, 2) if portfolio_dividends else None,
        "total_return": round(total_return_all, 2) if total_return_all is not None else None,
        "total_return_pct": round(total_return_pct_all, 2) if total_return_pct_all is not None else None,
        "holdings": holding_perf,
    }
