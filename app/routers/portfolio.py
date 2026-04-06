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


def _optimize(holdings: list, floor: float = 5.0, cap: float = 50.0) -> list:
    """
    Multi-factor category-complementarity optimization.

    For each scoring category (e.g. Growth, Valuation, Financial Strength),
    each holding's allocation weight is proportional to its fractional share of
    that category's total score across all holdings.

    A holding that is uniquely strong in a category where others are weak
    earns proportionally more weight for that category — naturally rewarding
    complementary holdings and preventing one or two stocks from dominating.

    Falls back to overall-score proportional weighting if no category data is
    available in the score cache (e.g. holdings were never individually analyzed).
    """
    n = len(holdings)
    if n == 0:
        return holdings
    if n == 1:
        return [{**holdings[0], "optimized_allocation": 100.0}]

    # ── Step 1: Pull per-category scores from score cache ─────────────────
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

    # ── Step 2: Fill gaps ──────────────────────────────────────────────────
    # For holdings with partial or missing category data, use overall pct_score
    for i, h in enumerate(holdings):
        overall = float(h.get("pct_score") or 0.0)
        if not cat_scores[i]:
            # No cache data at all — synthesise using overall score
            for c in all_cats:
                cat_scores[i][c] = overall
        else:
            for c in all_cats:
                if c not in cat_scores[i]:
                    cat_scores[i][c] = overall

    # ── Step 3: No category data anywhere → proportional overall score ─────
    if not all_cats:
        total_pct = sum(float(h.get("pct_score") or 0.0) for h in holdings) or 1.0
        max_possible = 100.0 - floor * (n - 1)
        effective_cap = min(cap, max_possible)
        remaining = 100.0 - floor * n
        alloc = [floor] * n
        for i, h in enumerate(holdings):
            extra = (float(h.get("pct_score") or 0.0) / total_pct) * remaining
            alloc[i] += min(extra, effective_cap - floor)
        alloc = [round(a, 1) for a in alloc]
        drift = round(100.0 - sum(alloc), 1)
        if drift != 0:
            alloc[0] = round(alloc[0] + drift, 1)
        return [{**h, "optimized_allocation": alloc[i]} for i, h in enumerate(holdings)]

    # ── Step 4: Compute per-category fractional contributions ─────────────
    # contributions[i] = sum over categories of (score[i][c] / Σ_j score[j][c])
    # A holding earns full credit in a category where it alone scores high;
    # it shares credit proportionally when multiple holdings score well.
    contributions = [0.0] * n
    for cat in all_cats:
        scores_in_cat = [cat_scores[i][cat] for i in range(n)]
        total = sum(scores_in_cat) or 1.0
        for i in range(n):
            contributions[i] += scores_in_cat[i] / total

    # ── Step 5: Allocate — floor for everyone, rest proportional to contributions
    max_possible = 100.0 - floor * (n - 1)
    effective_cap = min(cap, max_possible)
    remaining = 100.0 - floor * n
    total_contrib = sum(contributions) or 1.0

    alloc = [floor] * n
    for i in range(n):
        extra = (contributions[i] / total_contrib) * remaining
        alloc[i] += min(extra, effective_cap - floor)

    # ── Step 6: Re-normalise to exactly 100 (cap clamping may leave a gap) ─
    for _ in range(30):
        total = sum(alloc)
        diff = 100.0 - total
        if abs(diff) < 0.01:
            break
        receivers = [i for i in range(n)
                     if (diff > 0 and alloc[i] < effective_cap - 0.01)
                     or (diff < 0 and alloc[i] > floor + 0.01)]
        if not receivers:
            break
        share = diff / len(receivers)
        for i in receivers:
            alloc[i] = max(floor, min(effective_cap, alloc[i] + share))

    # ── Step 7: Round and fix any remaining drift ──────────────────────────
    alloc = [round(a, 1) for a in alloc]
    drift = round(100.0 - sum(alloc), 1)
    if drift != 0:
        most_room = max(range(n), key=lambda i: effective_cap - alloc[i])
        alloc[most_room] = round(alloc[most_room] + drift, 1)

    return [{**h, "optimized_allocation": alloc[i]} for i, h in enumerate(holdings)]


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
