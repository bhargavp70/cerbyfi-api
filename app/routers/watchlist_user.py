"""Server-side watchlist for authenticated users."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.db import score_db
from app.user_auth import require_user

router = APIRouter(prefix="/api/me/watchlist", tags=["watchlist"])


class WatchlistItemIn(BaseModel):
    ticker: str
    mode: str
    name: Optional[str] = None
    score: Optional[int] = None
    max_score: Optional[int] = None
    pct: Optional[float] = None
    stars: Optional[int] = None
    rating: Optional[str] = None


@router.get("")
def get_watchlist(user_id: str = Depends(require_user)):
    return score_db.get_watchlist(user_id)


@router.post("")
def add_item(body: WatchlistItemIn, user_id: str = Depends(require_user)):
    score_db.add_to_watchlist(user_id, body.model_dump())
    return {"ok": True}


@router.delete("/{ticker}")
def remove_item(ticker: str, user_id: str = Depends(require_user)):
    removed = score_db.remove_from_watchlist(user_id, ticker.upper())
    if not removed:
        raise HTTPException(status_code=404, detail="Ticker not in watchlist.")
    return {"ok": True}
