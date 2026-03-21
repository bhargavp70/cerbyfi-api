from pydantic import BaseModel
from typing import Optional, Dict


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
