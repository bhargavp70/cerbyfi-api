from pydantic import BaseModel
from typing import Optional, Dict, List


class MetricResult(BaseModel):
    label: str
    score: int
    max: int
    display: str


class CategoryResult(BaseModel):
    label: str
    score: int
    max: int
    pct: float
    metrics: Dict[str, MetricResult]


class ScoreResult(BaseModel):
    ticker: str
    name: str
    type: str          # "stock" or "fund"
    total: int
    max_total: int
    pct: float
    stars: int         # 1–5
    rating_label: str
    categories: Dict[str, CategoryResult]
    cached: bool
    fetched_at: Optional[str] = None


class ErrorResponse(BaseModel):
    ticker: str
    error: str
    detail: Optional[str] = None


class CacheStatsResponse(BaseModel):
    total_entries: int
    live_entries: int
    expired_entries: int


class HealthResponse(BaseModel):
    status: str
    version: str


class TopItem(BaseModel):
    ticker: str
    name: str
    score: int
    max_score: int
    pct: float
    stars: int
    count: int


class TopResponse(BaseModel):
    stocks: List[TopItem]
    funds: List[TopItem]


class StatsResponse(BaseModel):
    total_analyses: int


# ── Portfolio models ──────────────────────────────────────

class HoldingIn(BaseModel):
    ticker: str
    mode: str
    name: Optional[str] = None
    score: Optional[int] = None
    max_score: Optional[int] = None
    pct_score: Optional[float] = None
    stars: Optional[int] = None
    allocation: float  # 0.0 – 100.0


class HoldingOut(BaseModel):
    ticker: str
    mode: str
    name: Optional[str]
    score: Optional[int]
    max_score: Optional[int]
    pct_score: Optional[float]
    stars: Optional[int]
    allocation: float


class HoldingsIn(BaseModel):
    holdings: List[HoldingIn]


class PortfolioOut(BaseModel):
    id: str
    name: str
    created_at: float
    updated_at: float
    holdings: List[HoldingOut]
    aggregate_score: Optional[float]


class OptimizedHolding(BaseModel):
    ticker: str
    name: Optional[str]
    current_allocation: float
    optimized_allocation: float


class OptimizeResponse(BaseModel):
    current_score: float
    optimized_score: float
    holdings: List[OptimizedHolding]
