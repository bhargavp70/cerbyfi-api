"""Portfolio management: create, manage holdings, optimize allocations."""
import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from app.db import score_db
from app.user_auth import require_user
from app.models import (
    HoldingIn, HoldingOut, HoldingsIn,
    PortfolioOut, OptimizedHolding, OptimizeResponse,
)

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


def _optimize(holdings: list, floor: float = 5.0, cap: float = 60.0) -> list:
    """
    Greedy allocation that maximizes weighted score.
    Each holding gets at least `floor`%, no single holding exceeds `cap`%.
    Remaining budget after floors is given to highest-scoring holdings first.
    """
    n = len(holdings)
    if n == 0:
        return holdings

    # Ensure cap makes sense (can't exceed what's left after others get their floors)
    max_possible = 100.0 - floor * (n - 1)
    effective_cap = min(cap, max_possible)

    scored_idx = sorted(range(n), key=lambda i: -(holdings[i].get("pct_score") or 0.0))
    allocs = [floor] * n
    remaining = 100.0 - floor * n

    for idx in scored_idx:
        if remaining <= 0:
            break
        headroom = effective_cap - floor  # how much more this holding can receive
        give = min(remaining, headroom)
        allocs[idx] += give
        remaining -= give

    # Fix rounding drift
    allocs = [round(a, 2) for a in allocs]
    drift = round(100.0 - sum(allocs), 2)
    if drift != 0:
        allocs[scored_idx[0]] = round(allocs[scored_idx[0]] + drift, 2)

    return [{**h, "optimized_allocation": allocs[i]} for i, h in enumerate(holdings)]


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
    if body.holdings and abs(total - 100.0) > 0.5:
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
def optimize_portfolio(portfolio_id: str, user_id: str = Depends(require_user)):
    p = score_db.get_portfolio(portfolio_id, user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Portfolio not found.")
    holdings = score_db.get_holdings(portfolio_id)
    if not holdings:
        raise HTTPException(status_code=422, detail="Portfolio has no holdings.")

    current_score = _aggregate_score(holdings) or 0.0
    optimized = _optimize(holdings)
    # Compute optimized aggregate score using new allocations
    for h in optimized:
        h["allocation"] = h["optimized_allocation"]
    optimized_score = _aggregate_score(optimized) or 0.0

    return OptimizeResponse(
        current_score=current_score,
        optimized_score=round(optimized_score, 2),
        holdings=[
            OptimizedHolding(
                ticker=h["ticker"],
                name=h.get("name"),
                current_allocation=h_orig["allocation"],
                optimized_allocation=h["optimized_allocation"],
            )
            for h, h_orig in zip(optimized, holdings)
        ],
    )
