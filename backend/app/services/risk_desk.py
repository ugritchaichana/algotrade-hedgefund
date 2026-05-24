"""Risk Desk — 4-Pillar Intermarket regime classification.

Pillars: US30 (equities), XAUUSD (safe haven), DXY (liquidity), USOIL (energy).

DXY note: most retail brokers (including IUX) do not list DXY. We proxy it by
inverting USDJPY's daily % change — correlation is historically ~0.85. When
USDJPY rises, DXY tends to rise. Negation gives us the same directional signal.
"""

import time
import logging
import MetaTrader5 as mt5
from app.services.mt5_connector import get_historical_data

log = logging.getLogger(__name__)

_risk_cache: dict | None = None
_risk_cache_time: float = 0.0
_RISK_TTL = 600


def get_daily_change_percent(symbol: str) -> float | None:
    """Return today's % change for `symbol` based on the last two D1 closes.
    Returns None when data is unavailable (so callers can distinguish from genuine 0%).
    """
    df = get_historical_data(symbol, mt5.TIMEFRAME_D1, 2)
    if df.empty or len(df) < 2:
        return None
    prev_close = df.iloc[-2]["close"]
    current_close = df.iloc[-1]["close"]
    if prev_close == 0:
        return None
    return ((current_close - prev_close) / prev_close) * 100


def _classify_sentiment(us30, xau, dxy, usoil) -> str:
    """Classify regime. Pillars may be None (unavailable). Treat None as 0 for thresholding
    but flag in availability dict (caller decides UX).
    """
    u = us30 if us30 is not None else 0.0
    x = xau if xau is not None else 0.0
    d = dxy if dxy is not None else 0.0
    o = usoil if usoil is not None else 0.0

    if u > 0.1 and d < -0.1:
        return "Risk-On (Capital flowing to Equities)"
    if u < -0.1 and d > 0.1 and x > 0.1:
        return "Risk-Off (Fear / Safe Haven bid)"
    if d > 0.3 and u < -0.1 and x < -0.1 and o < -0.1:
        return "Liquidity Crunch (Cash is King)"
    if u < -0.1 and x > 0.1 and o > 0.1:
        return "Stagflation Fear (Commodities up, Growth down)"
    if u > 0.1 and o > 0.1 and d > 0.1:
        return "Strong Growth (Equities and Dollar strong)"
    if x > 0.1 and u > 0.1:
        return "Mixed / Easy Money (Everything Rally)"
    return "Neutral / Transitioning"


def evaluate_intermarket_risk() -> dict:
    us30_pct = get_daily_change_percent("US30")
    xau_pct = get_daily_change_percent("XAUUSD")
    usoil_pct = get_daily_change_percent("USOIL")

    # DXY proxy via inverted USDJPY (most retail brokers don't list DXY directly)
    usdjpy_pct = get_daily_change_percent("USDJPY")
    dxy_pct = -usdjpy_pct if usdjpy_pct is not None else None
    dxy_source = "USDJPY_inverted_proxy" if dxy_pct is not None else "unavailable"

    sentiment = _classify_sentiment(us30_pct, xau_pct, dxy_pct, usoil_pct)

    return {
        "sentiment": sentiment,
        "us30_daily_change": round(us30_pct, 2) if us30_pct is not None else None,
        "xau_daily_change": round(xau_pct, 2) if xau_pct is not None else None,
        "dxy_daily_change": round(dxy_pct, 2) if dxy_pct is not None else None,
        "usoil_daily_change": round(usoil_pct, 2) if usoil_pct is not None else None,
        "data_availability": {
            "US30": us30_pct is not None,
            "XAUUSD": xau_pct is not None,
            "DXY": dxy_pct is not None,
            "USOIL": usoil_pct is not None,
        },
        "dxy_source": dxy_source,
    }


def get_risk_assessment() -> dict:
    """Cached entry point — re-evaluates every _RISK_TTL seconds (default 600s)."""
    global _risk_cache, _risk_cache_time
    now = time.time()
    if _risk_cache and (now - _risk_cache_time) < _RISK_TTL:
        return _risk_cache
    _risk_cache = evaluate_intermarket_risk()
    _risk_cache_time = now
    return _risk_cache


def invalidate_risk_cache() -> None:
    global _risk_cache, _risk_cache_time
    _risk_cache = None
    _risk_cache_time = 0.0
