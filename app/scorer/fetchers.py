import math
import time
import requests
from typing import Union, Optional
from app.config import settings

FMP_BASE      = "https://financialmodelingprep.com"
FINNHUB_BASE  = "https://finnhub.io/api/v1"
YAHOO_BASE    = "https://query1.finance.yahoo.com"
YAHOO2_BASE   = "https://query2.finance.yahoo.com"
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}

# ── Yahoo Finance crumb cache (for PE ratio lookups) ──────────────────────────
_yf_crumb: dict = {"crumb": None, "cookies": None, "fetched_at": 0.0}
_YF_CRUMB_TTL = 3600  # refresh crumb every hour


def _get_yahoo_crumb() -> Optional[tuple]:
    """Returns (crumb, cookies) for Yahoo Finance quoteSummary calls, cached 1h."""
    now = time.time()
    if _yf_crumb["crumb"] and now - _yf_crumb["fetched_at"] < _YF_CRUMB_TTL:
        return _yf_crumb["crumb"], _yf_crumb["cookies"]
    try:
        # Step 1: get cookies
        r1 = requests.get("https://fc.yahoo.com", headers=YAHOO_HEADERS, timeout=10)
        cookies = r1.cookies
        # Step 2: get crumb using those cookies
        r2 = requests.get(
            f"{YAHOO2_BASE}/v1/test/getcrumb",
            headers=YAHOO_HEADERS,
            cookies=cookies,
            timeout=10,
        )
        crumb = r2.text.strip()
        if crumb and len(crumb) < 50:
            _yf_crumb["crumb"]      = crumb
            _yf_crumb["cookies"]    = cookies
            _yf_crumb["fetched_at"] = now
            return crumb, cookies
    except Exception:
        pass
    return None, None


def _yahoo_pe(ticker: str) -> Optional[float]:
    """Fetch trailing P/E for an ETF from Yahoo Finance quoteSummary."""
    crumb, cookies = _get_yahoo_crumb()
    if not crumb:
        return None
    try:
        resp = requests.get(
            f"{YAHOO2_BASE}/v10/finance/quoteSummary/{ticker}",
            params={"modules": "summaryDetail", "crumb": crumb},
            headers=YAHOO_HEADERS,
            cookies=cookies,
            timeout=15,
        )
        if not resp.ok:
            return None
        data = resp.json()
        result = data.get("quoteSummary", {}).get("result")
        if not result:
            return None
        pe = result[0].get("summaryDetail", {}).get("trailingPE")
        if isinstance(pe, dict):
            pe = pe.get("raw")
        if pe and float(pe) > 0:
            return float(pe)
    except Exception:
        pass
    return None


# ── Finnhub (stocks) ─────────────────────────────────────────────────────────

def _fh_get(path: str, **params) -> dict:
    if not settings.finnhub_api_key:
        raise RuntimeError("FINNHUB_API_KEY environment variable is not set.")
    params["token"] = settings.finnhub_api_key
    resp = requests.get(f"{FINNHUB_BASE}{path}", params=params, timeout=15)
    if resp.status_code == 403:
        raise ValueError("This data requires a Finnhub premium plan.")
    resp.raise_for_status()
    if not resp.content or not resp.content.strip():
        return {}
    return resp.json()


def fetch_stock_data(ticker: str, retries: int = 3, delay: float = 2.0) -> dict:
    last_error = None
    for attempt in range(retries):
        try:
            profile = _fh_get("/stock/profile2", symbol=ticker)
            metrics = _fh_get("/stock/metric",   symbol=ticker, metric="all")

            if not profile or not profile.get("name"):
                raise ValueError(f"No data found for '{ticker}'. Check the ticker symbol.")
            break
        except ValueError:
            raise  # wrong ticker or plan issue — don't retry
        except Exception as e:
            last_error = e
            if attempt < retries - 1:
                time.sleep(delay)
    else:
        raise RuntimeError(f"Could not fetch data for {ticker}. ({last_error})")

    m = metrics.get("metric", {}) if isinstance(metrics, dict) else {}

    def pct(val):
        """Finnhub returns percentages (47.33 = 47.33%); convert to decimal for scoring."""
        return val / 100.0 if val is not None else None

    info = {
        "symbol":   ticker.upper(),
        "longName": profile.get("name", ticker.upper()),
    }

    # Revenue growth YoY
    rev = pct(m.get("revenueGrowthTTMYoy"))
    if rev is not None:
        info["revenue_growth_yoy"] = rev

    # EPS growth YoY
    eps_g = pct(m.get("epsGrowthTTMYoy"))
    if eps_g is not None:
        info["eps_growth"] = eps_g

    # 5-year revenue CAGR (annualised %)
    rev5y = pct(m.get("revenueGrowth5Y"))
    if rev5y is not None:
        info["revenue_growth_5y"] = rev5y

    # Operating margin
    op = pct(m.get("operatingMarginTTM"))
    if op is not None:
        info["operatingMargins"] = op

    # Moat proxy: gross margin + ROE (both in %, convert to decimal)
    gm_raw  = m.get("grossMarginTTM")
    roe_raw = m.get("roeTTM")
    if gm_raw is not None:
        gm = gm_raw / 100.0
        if roe_raw is not None:
            roe = roe_raw / 100.0
            info["moat_proxy"] = (min(gm, 1.0) + min(max(roe, 0), 1.0)) / 2
        else:
            info["moat_proxy"] = min(gm, 1.0)

    # Debt/Equity (Finnhub: actual ratio e.g. 1.35 → store as 135 to match threshold scale)
    dte = m.get("totalDebt/totalEquityAnnual")
    if dte is not None:
        info["debtToEquity"] = dte * 100

    # FCF margin — not available from Finnhub free plan (will score N/A)

    # Capital allocation proxy (ROE as decimal)
    if roe_raw is not None:
        info["capital_allocation_proxy"] = roe_raw / 100.0

    # ROIC — Finnhub provides ROI TTM as the closest proxy
    roi = m.get("roiTTM")
    if roi is not None:
        info["roic"] = roi / 100.0

    # P/E ratio
    pe = m.get("peNormalizedAnnual")
    if pe and pe > 0:
        info["trailingPE"] = pe

    # Price / Free Cash Flow
    pfcf = m.get("pfcfShareTTM")
    if pfcf is not None and pfcf > 0:
        info["price_to_fcf"] = pfcf

    # FCF margin = P/S ÷ P/FCF  (no extra API call needed)
    ps = m.get("psTTM")
    if ps is not None and ps > 0 and pfcf is not None and pfcf > 0:
        info["fcf_margin"] = ps / pfcf

    return info


# ── FMP (ETFs / funds) ───────────────────────────────────────────────────────

def _fmp_get(path: str, **params) -> Union[dict, list]:
    if not settings.fmp_api_key:
        raise RuntimeError("FMP_API_KEY environment variable is not set.")
    params["apikey"] = settings.fmp_api_key
    resp = requests.get(f"{FMP_BASE}{path}", params=params, timeout=15)
    if resp.status_code == 404:
        return {}
    if resp.status_code == 402:
        raise ValueError(
            "This ETF requires an FMP paid plan. "
            "The free plan supports popular ETFs (e.g. SPY, QQQ, VTI, IVV, VOO)."
        )
    resp.raise_for_status()
    if not resp.content or not resp.content.strip():
        return {}
    data = resp.json()
    if isinstance(data, dict) and "Error Message" in data:
        raise ValueError(data["Error Message"])
    return data


def _yahoo_closes(ticker: str) -> list:
    """3 years of daily closes from Yahoo Finance. No API key required."""
    resp = requests.get(
        f"{YAHOO_BASE}/v8/finance/chart/{ticker}",
        params={"range": "3y", "interval": "1d"},
        headers=YAHOO_HEADERS,
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    result = data.get("chart", {}).get("result")
    if not result:
        return []
    raw = result[0].get("indicators", {}).get("quote", [{}])[0].get("close", [])
    return [c for c in raw if c is not None]


def fetch_fund_data(ticker: str, retries: int = 3, delay: float = 2.0) -> dict:
    last_error = None
    for attempt in range(retries):
        try:
            # FMP profile: name, AUM, dividend yield, isEtf validation (free for all ETFs)
            profile = _fmp_get("/stable/profile", symbol=ticker)

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

            # Yahoo Finance: price history (free, no key, all ETFs)
            closes = _yahoo_closes(ticker)
            break
        except ValueError:
            raise
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

    # P/E ratio — FMP profile has pe=null for most ETFs; use Yahoo Finance
    pe = None
    fmp_pe = p.get("pe")
    try:
        if fmp_pe and float(fmp_pe) > 0:
            pe = float(fmp_pe)
    except (TypeError, ValueError):
        pass
    if pe is None:
        pe = _yahoo_pe(ticker)
    if pe:
        result["trailingPE"] = pe

    # Dividend yield from lastDividend / price
    ld    = p.get("lastDividend")
    price = p.get("price")
    if ld and price and float(price) > 0:
        try:
            result["dividend_yield"] = float(ld) / float(price) * 100
        except (TypeError, ValueError):
            pass

    # expense_ratio not available on free plan — will score as N/A

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
