import math
import time
import requests
from app.config import settings

FINNHUB_BASE = "https://finnhub.io/api/v1"


def _get(endpoint: str, **params) -> dict:
    params["token"] = settings.finnhub_api_key
    resp = requests.get(f"{FINNHUB_BASE}/{endpoint}", params=params, timeout=15)
    resp.raise_for_status()
    if not resp.content or not resp.content.strip():
        return {}
    return resp.json()


def fetch_stock_data(ticker: str, retries: int = 3, delay: float = 2.0) -> dict:
    last_error = None
    for attempt in range(retries):
        try:
            profile    = _get("stock/profile2",      symbol=ticker)
            financials = _get("stock/metric",         symbol=ticker, metric="all")
            recs       = _get("stock/recommendation", symbol=ticker)

            if not profile or "ticker" not in profile:
                raise ValueError(f"No data found for '{ticker}'. Check the ticker symbol.")

            metrics = financials.get("metric", {})
            break
        except Exception as e:
            last_error = e
            if attempt < retries - 1:
                time.sleep(delay)
    else:
        raise RuntimeError(f"Could not fetch data for {ticker}. ({last_error})")

    info = {
        "symbol":   ticker.upper(),
        "longName": profile.get("name", ticker.upper()),
    }

    rev = metrics.get("revenueGrowthTTMYoy")
    if rev is not None:
        info["revenue_growth_yoy"] = rev / 100

    op = metrics.get("operatingMarginTTM")
    if op is not None:
        info["operatingMargins"] = op / 100

    gm  = metrics.get("grossMarginTTM")
    roe = metrics.get("roeTTM")
    if gm is not None:
        gm_dec = gm / 100
        if roe is not None:
            info["moat_proxy"] = (min(gm_dec, 1.0) + min(max(roe / 100, 0), 1.0)) / 2
        else:
            info["moat_proxy"] = min(gm_dec, 1.0)

    dte = metrics.get("totalDebt/totalEquityAnnual")
    if dte is not None:
        info["debtToEquity"] = dte * 100

    fcf     = metrics.get("freeCashFlowTTM")
    revenue = metrics.get("revenueTTM")
    if fcf is not None and revenue and revenue > 0:
        info["fcf_margin"] = fcf / revenue

    info["industry_growth_proxy"] = info.get("revenue_growth_yoy")

    if recs:
        latest = recs[0]
        total = sum(latest.get(k, 0) for k in ["strongBuy", "buy", "hold", "sell", "strongSell"])
        if total > 0:
            weighted = (
                latest.get("strongBuy",  0) * 1 +
                latest.get("buy",        0) * 2 +
                latest.get("hold",       0) * 3 +
                latest.get("sell",       0) * 4 +
                latest.get("strongSell", 0) * 5
            ) / total
            info["analyst_buy_score"] = 6.0 - weighted
            info["analyst_coverage"]  = total

    if roe is not None:
        info["capital_allocation_proxy"] = roe / 100

    pe = metrics.get("peTTM") or metrics.get("peAnnual")
    if pe and pe > 0:
        info["trailingPE"] = pe

    peg = metrics.get("pegRatio")
    if peg is not None:
        info["trailingPegRatio"] = peg

    return info


def fetch_fund_data(ticker: str, retries: int = 3, delay: float = 2.0) -> dict:
    """Fetch ETF/fund data via Yahoo Finance (yfinance)."""
    import yfinance as yf

    last_error = None
    for attempt in range(retries):
        try:
            t    = yf.Ticker(ticker)
            info = t.info
            if not info or not (info.get("longName") or info.get("shortName")):
                raise ValueError(f"No ETF/fund data found for '{ticker}'. Check the ticker symbol.")
            hist = t.history(period="3y", interval="1wk")
            break
        except Exception as e:
            last_error = e
            if attempt < retries - 1:
                time.sleep(delay)
    else:
        raise RuntimeError(f"Could not fetch data for {ticker}. ({last_error})")

    result = {
        "symbol":   ticker.upper(),
        "longName": info.get("longName") or info.get("shortName") or ticker.upper(),
    }

    aum = info.get("totalAssets")
    if aum and aum > 0:
        result["aum_billions"] = aum / 1e9

    pe = info.get("trailingPE")
    if pe and pe > 0:
        result["trailingPE"] = pe

    yld = info.get("yield") or info.get("dividendYield")
    if yld and yld > 0:
        result["dividend_yield"] = yld * 100

    if not hist.empty:
        closes = hist["Close"].tolist()
        if len(closes) >= 4:
            weekly_returns = [(closes[i] - closes[i-1]) / closes[i-1] for i in range(1, len(closes))]
            mean_r   = sum(weekly_returns) / len(weekly_returns)
            variance = sum((r - mean_r) ** 2 for r in weekly_returns) / len(weekly_returns)
            result["annual_volatility"] = math.sqrt(variance * 52) * 100

            peak = closes[0]
            max_dd = 0.0
            for c in closes:
                if c > peak:
                    peak = c
                dd = (peak - c) / peak
                if dd > max_dd:
                    max_dd = dd
            result["max_drawdown"] = max_dd * 100

            lb1 = min(52, len(closes) - 1)
            result["return_1y"] = (closes[-1] - closes[-1 - lb1]) / closes[-1 - lb1] * 100

            if len(closes) >= 52:
                lb3 = min(156, len(closes) - 1)
                total_ret = (closes[-1] - closes[-1 - lb3]) / closes[-1 - lb3]
                years = lb3 / 52
                result["return_3y_annualized"] = ((1 + total_ret) ** (1 / years) - 1) * 100

    return result
