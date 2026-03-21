import math
import time
import requests
from typing import Union
from app.config import settings

FMP_BASE = "https://financialmodelingprep.com"


def _get(path: str, **params) -> Union[dict, list]:
    params["apikey"] = settings.fmp_api_key
    resp = requests.get(f"{FMP_BASE}{path}", params=params, timeout=15)
    if resp.status_code == 404:
        return {}
    resp.raise_for_status()
    if not resp.content or not resp.content.strip():
        return {}
    data = resp.json()
    if isinstance(data, dict) and "Error Message" in data:
        raise ValueError(data["Error Message"])
    return data


def fetch_stock_data(ticker: str, retries: int = 3, delay: float = 2.0) -> dict:
    last_error = None
    for attempt in range(retries):
        try:
            profile     = _get("/stable/profile",                       symbol=ticker)
            ratios      = _get("/stable/ratios-ttm",                    symbol=ticker)
            growth      = _get("/stable/financial-growth",              symbol=ticker, limit=1)
            analyst     = _get("/stable/analyst-stock-recommendations", symbol=ticker, limit=1)
            key_metrics = _get("/stable/key-metrics-ttm",               symbol=ticker)

            if not profile or not isinstance(profile, list) or not profile[0].get("companyName"):
                raise ValueError(f"No data found for '{ticker}'. Check the ticker symbol.")
            break
        except Exception as e:
            last_error = e
            if attempt < retries - 1:
                time.sleep(delay)
    else:
        raise RuntimeError(f"Could not fetch data for {ticker}. ({last_error})")

    p  = profile[0]
    r  = ratios[0]      if ratios and isinstance(ratios, list)      else {}
    g  = growth[0]      if growth and isinstance(growth, list)       else {}
    a  = analyst[0]     if analyst and isinstance(analyst, list)     else {}
    km = key_metrics[0] if key_metrics and isinstance(key_metrics, list) else {}

    info = {
        "symbol":   ticker.upper(),
        "longName": p.get("companyName", ticker.upper()),
    }

    # Revenue growth (already decimal, e.g. 0.07 = 7%)
    rev = g.get("revenueGrowth")
    if rev is not None:
        info["revenue_growth_yoy"] = rev

    # Operating margin
    op = r.get("operatingProfitMarginTTM")
    if op is not None:
        info["operatingMargins"] = op

    # Moat proxy: gross margin + ROE (ROE is now in key-metrics)
    gm  = r.get("grossProfitMarginTTM")
    roe = km.get("returnOnEquityTTM")
    if gm is not None:
        if roe is not None:
            info["moat_proxy"] = (min(gm, 1.0) + min(max(roe, 0), 1.0)) / 2
        else:
            info["moat_proxy"] = min(gm, 1.0)

    # Debt/Equity (field renamed in stable API)
    dte = r.get("debtToEquityRatioTTM")
    if dte is not None:
        info["debtToEquity"] = dte * 100

    # FCF margin (freeCashFlowPerShareTTM and revenuePerShareTTM now in ratios)
    fcf_ps = r.get("freeCashFlowPerShareTTM")
    rev_ps = r.get("revenuePerShareTTM")
    if fcf_ps is not None and rev_ps and rev_ps > 0:
        info["fcf_margin"] = fcf_ps / rev_ps

    info["industry_growth_proxy"] = info.get("revenue_growth_yoy")

    # Analyst score
    buy   = a.get("analystRatingsStrongBuy", 0) + a.get("analystRatingsbuy", 0)
    hold  = a.get("analystRatingsHold", 0)
    sell  = a.get("analystRatingsSell", 0) + a.get("analystRatingsStrongSell", 0)
    total_a = buy + hold + sell
    if total_a > 0:
        weighted = (
            a.get("analystRatingsStrongBuy", 0) * 1 +
            a.get("analystRatingsbuy",        0) * 2 +
            a.get("analystRatingsHold",        0) * 3 +
            a.get("analystRatingsSell",        0) * 4 +
            a.get("analystRatingsStrongSell",  0) * 5
        ) / total_a
        info["analyst_buy_score"] = 6.0 - weighted
        info["analyst_coverage"]  = total_a

    if roe is not None:
        info["capital_allocation_proxy"] = roe

    # PE / PEG (renamed in stable API)
    pe = r.get("priceToEarningsRatioTTM")
    if pe and pe > 0:
        info["trailingPE"] = pe

    peg = r.get("priceToEarningsGrowthRatioTTM")
    if peg is not None:
        info["trailingPegRatio"] = peg

    return info


def fetch_fund_data(ticker: str, retries: int = 3, delay: float = 2.0) -> dict:
    last_error = None
    for attempt in range(retries):
        try:
            profile = _get("/stable/profile", symbol=ticker)
            # 800 trading days ≈ 3.2 years of daily closes
            history = _get("/stable/historical-price-eod/light", symbol=ticker, limit=800)

            if not profile or not isinstance(profile, list) or not profile[0].get("companyName"):
                raise ValueError(
                    f"No ETF/fund data found for '{ticker}'. "
                    "Supports ETFs (e.g. SPY, QQQ, VTI). Check the ticker symbol."
                )
            p = profile[0]
            if not p.get("isEtf"):
                raise ValueError(
                    f"'{ticker}' does not appear to be an ETF. "
                    "Use the Stock option for individual stocks."
                )
            break
        except Exception as e:
            last_error = e
            if attempt < retries - 1:
                time.sleep(delay)
    else:
        raise RuntimeError(f"Could not fetch data for {ticker}. ({last_error})")

    p = profile[0]
    result = {
        "symbol":   ticker.upper(),
        "longName": p.get("companyName", ticker.upper()),
    }

    # AUM proxy from market cap
    mc = p.get("marketCap")
    if mc:
        try:
            result["aum_billions"] = float(mc) / 1e9
        except (TypeError, ValueError):
            pass

    # Dividend yield from lastDividend / price
    ld    = p.get("lastDividend")
    price = p.get("price")
    if ld and price and float(price) > 0:
        try:
            result["dividend_yield"] = float(ld) / float(price) * 100
        except (TypeError, ValueError):
            pass

    # expense_ratio not available on free plan — will score as N/A

    # Historical prices: list of {symbol, date, price, volume}, newest-first
    hist = history if isinstance(history, list) else []
    if hist:
        closes = [float(d["price"]) for d in reversed(hist)]

        if len(closes) >= 4:
            daily_returns = [(closes[i] - closes[i-1]) / closes[i-1]
                             for i in range(1, len(closes))]
            mean_r   = sum(daily_returns) / len(daily_returns)
            variance = sum((r - mean_r) ** 2 for r in daily_returns) / len(daily_returns)
            result["annual_volatility"] = math.sqrt(variance * 252) * 100

            peak = closes[0]
            max_dd = 0.0
            for c in closes:
                if c > peak:
                    peak = c
                dd = (peak - c) / peak
                if dd > max_dd:
                    max_dd = dd
            result["max_drawdown"] = max_dd * 100

            # 1-year return (~252 trading days)
            lb1 = min(252, len(closes) - 1)
            result["return_1y"] = (closes[-1] - closes[-1 - lb1]) / closes[-1 - lb1] * 100

            # 3-year annualized return
            if len(closes) >= 252:
                lb3 = min(756, len(closes) - 1)
                total_ret = (closes[-1] - closes[-1 - lb3]) / closes[-1 - lb3]
                years = lb3 / 252
                result["return_3y_annualized"] = ((1 + total_ret) ** (1 / years) - 1) * 100

    return result
