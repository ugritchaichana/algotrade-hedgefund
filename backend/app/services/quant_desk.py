"""Quant Desk — Triple Screen MTF technical engine (D1 + H4 + H1).

Strategy logic
==============
1. D1 macro trend (SMA 20/50) — establishes the long-term bias. Bullish when
   close > SMA20 > SMA50, Bearish when close < SMA20 < SMA50, else Sideways.
2. H4 medium-term confirmation (SMA 20/50) — must AGREE with D1. If D1 and H4
   disagree or either is Sideways, no entry is generated.
3. H1 entry trigger — RSI(14) + ATR(14) + tick_volume vs VMA(20). Entry is
   placed at the high/low of the previous CLOSED H1 candle (iloc[-2]) as a
   pending limit order — institutional pullback entry, no repaint.

RSI threshold logic (kept from v1, documented intentionally)
============================================================
- RSI < 30 in bullish trend → ALERT only (not ENTRY).
  Rationale: deep oversold during a trend often precedes a real reversal.
  Wait for momentum to recover into the 40-60 band before entering.
- RSI 40-60 in bullish trend → ENTRY zone if volume confirms.
- RSI > 60 in bullish trend → no signal (chasing).
- Mirror for bearish trend with RSI > 70 = ALERT, 40-60 = ENTRY.

This is an UNCONVENTIONAL interpretation vs textbook (which would enter on
oversold). Keep until backtest data invalidates it. See Phase 1C backtest engine.

Risk model
==========
- 1% of EQUITY (not balance) per trade — drawdown-aware sizing.
- SL = entry +/- 1.5x ATR. TP = entry +/- 3.0x ATR. Fixed 1:2 R:R.
- risk_tolerance setting: Conservative=0.5% / Balanced=1.0% / Aggressive=2.0%.
"""

import datetime
import time
import logging
import pandas as pd
import numpy as np
import MetaTrader5 as mt5

from app.services.mt5_connector import get_historical_data, get_account_info, resolve_symbol
from app.core.asset_profiles import ASSET_PROFILES

log = logging.getLogger(__name__)

# D1/H4 OHLC cache (D1 barely changes intraday; H4 every 4h)
_mt5_data_cache: dict[str, dict] = {}
_TTL_D1 = 1800
_TTL_H4 = 300

RISK_TOLERANCE_MAP = {
    "Conservative": 0.5,
    "Balanced": 1.0,
    "Aggressive": 2.0,
}


def _get_cached_data(symbol: str, timeframe: int, num_candles: int):
    if timeframe == mt5.TIMEFRAME_D1:
        key, ttl = f"{symbol}_D1", _TTL_D1
    elif timeframe == mt5.TIMEFRAME_H4:
        key, ttl = f"{symbol}_H4", _TTL_H4
    else:
        return get_historical_data(symbol, timeframe, num_candles)

    now = time.time()
    cached = _mt5_data_cache.get(key)
    if cached and (now - cached["time"]) < ttl:
        return cached["data"]

    df = get_historical_data(symbol, timeframe, num_candles)
    if not df.empty:
        _mt5_data_cache[key] = {"data": df, "time": now}
    return df


def calculate_sma(df, period: int, column: str = "close"):
    return df[column].rolling(window=period).mean()


def calculate_rsi(df, period: int = 14, column: str = "close"):
    delta = df[column].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))


def calculate_atr(df, period: int = 14):
    high_low = df["high"] - df["low"]
    high_close = np.abs(df["high"] - df["close"].shift())
    low_close = np.abs(df["low"] - df["close"].shift())
    ranges = pd.concat([high_low, high_close, low_close], axis=1)
    true_range = np.max(ranges, axis=1)
    return true_range.rolling(window=period).mean()


def calculate_lot_size(symbol: str, equity: float, risk_percent: float, sl_distance: float) -> float:
    """Compute the lot size that risks exactly `risk_percent` of equity given the SL price distance.

    Uses MT5 trade_tick_value + trade_tick_size + volume_step for broker-correct math.
    Returns volume_min on any computation failure (fail safe).
    """
    if equity <= 0 or sl_distance <= 0:
        return 0.0

    risk_amount = equity * (risk_percent / 100.0)
    resolved = resolve_symbol(symbol)
    info = mt5.symbol_info(resolved)
    if not info:
        return 0.0

    tick_value = info.trade_tick_value
    tick_size = info.trade_tick_size
    if tick_size == 0:
        return info.volume_min

    point_value = tick_value / tick_size
    try:
        raw_lot = risk_amount / (sl_distance * point_value)
        step = info.volume_step or 0.01
        lot = np.round(raw_lot / step) * step
        lot = max(info.volume_min, min(info.volume_max, lot))
        return round(float(lot), 2)
    except Exception as e:
        log.warning("lot_size calc failed for %s: %s", symbol, e)
        return info.volume_min


def _classify_trend(df, label: str) -> str:
    """Bullish if close > SMA20 > SMA50, Bearish if close < SMA20 < SMA50, else Sideways."""
    if df.empty or len(df) < 50:
        return "Insufficient"
    sma20 = calculate_sma(df, 20).iloc[-1]
    sma50 = calculate_sma(df, 50).iloc[-1]
    close = df.iloc[-1]["close"]
    if pd.isna(sma20) or pd.isna(sma50):
        return "Insufficient"
    if close > sma20 > sma50:
        return "Bullish"
    if close < sma20 < sma50:
        return "Bearish"
    return "Sideways"


def _classify_entry_zone(rsi: float, trend: str) -> str:
    """Quality tag for filtering / backtesting later. Returns one of:
    'deep_oversold' (rsi<30 in bull) / 'shallow_pullback' (45-55) / 'mid_pullback' (40-45 or 55-60)
    / 'deep_overbought' (rsi>70 in bear) / 'no_zone'.
    """
    if trend == "Bullish":
        if rsi < 30:
            return "deep_oversold"
        if 45 <= rsi <= 55:
            return "shallow_pullback"
        if 40 <= rsi < 45 or 55 < rsi <= 60:
            return "mid_pullback"
    elif trend == "Bearish":
        if rsi > 70:
            return "deep_overbought"
        if 45 <= rsi <= 55:
            return "shallow_pullback"
        if 40 <= rsi < 45 or 55 < rsi <= 60:
            return "mid_pullback"
    return "no_zone"


def _get_risk_percent() -> float:
    """Read risk_tolerance setting from DB. Default Balanced (1.0%) if unset."""
    try:
        from app.core.database import SessionLocal, SystemSettings
        db = SessionLocal()
        row = db.query(SystemSettings).filter(SystemSettings.key == "risk_tolerance").first()
        db.close()
        if row:
            return RISK_TOLERANCE_MAP.get(row.value, 1.0)
    except Exception as e:
        log.warning("risk_tolerance read failed: %s", e)
    return 1.0


def determine_regime_and_signal(symbol: str) -> dict:
    """Triple Screen MTF signal generator.

    Returns dict with: regime, signal, action, reason_technical, confidence,
    rsi, atr, entry, sl, tp, lot_size, sparkline, entry_zone_quality, trends.
    """
    profile = ASSET_PROFILES.get(symbol, {})

    # Peak-hour + weekend gates
    now_utc = datetime.datetime.utcnow()
    bkk_now = now_utc + datetime.timedelta(hours=7)
    curr_hour = bkk_now.hour
    is_peak = True
    peak_note = ""
    if "peak_hours" in profile:
        start, end = profile["peak_hours"]
        is_peak = (start <= curr_hour < end) if start <= end else (curr_hour >= start or curr_hour < end)
        if not is_peak:
            peak_note = f" (Off-Peak: {start}:00-{end}:00 UTC+7)"

    is_weekend = bkk_now.weekday() >= 5

    base_response = {
        "trends": {"D1": None, "H4": None, "H1_rsi": None},
        "regime": "Loading",
        "signal": "WAITING",
        "action": "",
        "reason_technical": "",
        "confidence": 0,
        "rsi": 0,
        "atr": 0,
        "entry": None,
        "sl": None,
        "tp": None,
        "lot_size": None,
        "sparkline": [],
        "entry_zone_quality": "no_zone",
    }

    # === D1 macro trend ===
    df_d1 = _get_cached_data(symbol, mt5.TIMEFRAME_D1, 100)
    d1_trend = _classify_trend(df_d1, "D1")
    base_response["trends"]["D1"] = d1_trend

    if d1_trend in ("Insufficient",):
        base_response["regime"] = "Market Closed" if is_weekend else "D1 data insufficient"
        base_response["action"] = "Need at least 50 daily candles for trend determination."
        base_response["reason_technical"] = (
            "ตลาดปิดวันหยุด ไม่มีข้อมูลใหม่" if is_weekend else "MT5 ไม่มีข้อมูล D1 เพียงพอสำหรับสินทรัพย์นี้"
        )
        return base_response

    # === H4 medium-term confirmation ===
    df_h4 = _get_cached_data(symbol, mt5.TIMEFRAME_H4, 100)
    h4_trend = _classify_trend(df_h4, "H4")
    base_response["trends"]["H4"] = h4_trend

    if h4_trend == "Insufficient":
        base_response["regime"] = f"D1: {d1_trend} | H4 data insufficient"
        base_response["action"] = "Waiting for H4 data."
        base_response["reason_technical"] = f"D1 trend confirmed ({d1_trend}) but H4 data unavailable."
        base_response["confidence"] = 30
        return base_response

    # === Strict D1 == H4 alignment requirement ===
    if d1_trend == "Sideways" or h4_trend == "Sideways" or d1_trend != h4_trend:
        base_response["regime"] = f"D1: {d1_trend} | H4: {h4_trend}"
        base_response["signal"] = "WAITING"
        base_response["action"] = "Multi-timeframe disagreement — no trade until D1 and H4 align."
        base_response["reason_technical"] = (
            f"D1={d1_trend}, H4={h4_trend}. "
            "Triple Screen requires D1+H4 to agree before checking H1 entry."
        )
        base_response["confidence"] = 40
        # Still emit sparkline so UI doesn't go blank
        if not df_h4.empty:
            base_response["sparkline"] = df_h4["close"].tail(24).tolist()
        return base_response

    macro_trend = d1_trend  # both equal here

    # === H1 entry trigger ===
    df_h1 = get_historical_data(symbol, mt5.TIMEFRAME_H1, 100)
    if df_h1.empty or len(df_h1) < 20:
        base_response["regime"] = f"D1: {d1_trend} | H4: {h4_trend} | H1 data insufficient"
        base_response["signal"] = "WAITING"
        base_response["action"] = "H1 entry timing data unavailable."
        base_response["reason_technical"] = f"Macro aligned ({macro_trend}). H1 data unavailable."
        base_response["confidence"] = 50
        return base_response

    df_h1["RSI_14"] = calculate_rsi(df_h1, 14)
    df_h1["ATR_14"] = calculate_atr(df_h1, 14)
    df_h1["VMA_20"] = calculate_sma(df_h1, 20, column="tick_volume")

    closed_h1 = df_h1.iloc[-2]  # last fully-closed bar
    current_h1 = df_h1.iloc[-1]

    rsi = float(closed_h1["RSI_14"]) if not pd.isna(closed_h1["RSI_14"]) else 0.0
    atr = float(closed_h1["ATR_14"]) if not pd.isna(closed_h1["ATR_14"]) else 0.0
    current_vol = float(closed_h1["tick_volume"])
    vma = float(closed_h1["VMA_20"]) if not pd.isna(closed_h1["VMA_20"]) else 0.0
    base_response["trends"]["H1_rsi"] = round(rsi, 1)

    signal = "WAITING"
    action_text = "Macro aligned. Waiting for H1 entry trigger."
    entry_price = 0.0
    sl_price = 0.0
    tp_price = 0.0
    lot_size = 0.0
    confidence = 50
    entry_zone_quality = _classify_entry_zone(rsi, macro_trend)

    # Equity-aware lot sizing (drawdown-safe — never use balance)
    account = get_account_info()
    if not account:
        base_response["regime"] = f"D1: {d1_trend} | H4: {h4_trend} | Account info unavailable"
        base_response["action"] = "Account info unavailable — refusing to size trade."
        base_response["reason_technical"] = "MT5 account_info() returned None. Trade refused for safety."
        base_response["confidence"] = 0
        return base_response

    equity = account.get("equity") or 0.0
    if equity <= 0:
        base_response["regime"] = f"D1: {d1_trend} | H4: {h4_trend} | Equity <= 0"
        base_response["action"] = "Equity is zero or negative — refusing to trade."
        base_response["confidence"] = 0
        return base_response

    risk_percent = _get_risk_percent()

    # === Strategy decision ===
    # Walk-forward-validated thresholds (2026-05-24):
    #   SL = 0.5×ATR (tight), TP = 4×ATR (wide; trailing usually exits first)
    #   RSI entry zone 40-55 (narrower than the v2.0 40-60 default)
    if macro_trend == "Bullish":
        confidence = 60
        if rsi < 30:
            signal = "ALERT"
            action_text = "Deep oversold in D1+H4 uptrend — waiting for RSI to recover to 40-55 before ENTRY."
            confidence = 70
        elif 40 <= rsi <= 55:
            confidence = 75
            if current_vol > vma:
                entry_price = float(closed_h1["low"])
                sl_price = entry_price - (atr * 0.5)
                tp_price = entry_price + (atr * 4.0)
                sl_distance = entry_price - sl_price
                lot_size = calculate_lot_size(symbol, equity, risk_percent, sl_distance)
                if is_peak and not is_weekend and lot_size > 0:
                    signal = "ENTRY_BUY_LIMIT"
                    action_text = (
                        f"Triple Screen aligned (D1+H4 Bullish). "
                        f"H1 pullback (RSI {rsi:.1f}, {entry_zone_quality}) with volume confirmation. BUY_LIMIT."
                    )
                    confidence = 85
                else:
                    signal = "ALERT"
                    action_text = (
                        "Triple Screen aligned + volume confirmed, but outside peak hours or weekend."
                    )
                    confidence = 75
            else:
                signal = "WAITING"
                action_text = f"RSI {rsi:.1f} in entry zone, but H1 volume ({current_vol:.0f}) < VMA20 ({vma:.0f})."

    elif macro_trend == "Bearish":
        confidence = 60
        if rsi > 70:
            signal = "ALERT"
            action_text = "Deep overbought in D1+H4 downtrend — waiting for RSI to recover to 40-55 before ENTRY."
            confidence = 70
        elif 40 <= rsi <= 55:
            confidence = 75
            if current_vol > vma:
                entry_price = float(closed_h1["high"])
                sl_price = entry_price + (atr * 0.5)
                tp_price = entry_price - (atr * 4.0)
                sl_distance = sl_price - entry_price
                lot_size = calculate_lot_size(symbol, equity, risk_percent, sl_distance)
                if is_peak and not is_weekend and lot_size > 0:
                    signal = "ENTRY_SELL_LIMIT"
                    action_text = (
                        f"Triple Screen aligned (D1+H4 Bearish). "
                        f"H1 rally (RSI {rsi:.1f}, {entry_zone_quality}) with volume confirmation. SELL_LIMIT."
                    )
                    confidence = 85
                else:
                    signal = "ALERT"
                    action_text = "Triple Screen aligned + volume confirmed, but outside peak hours or weekend."
                    confidence = 75
            else:
                signal = "WAITING"
                action_text = f"RSI {rsi:.1f} in entry zone, but H1 volume ({current_vol:.0f}) < VMA20 ({vma:.0f})."

    regime_label = f"D1: {d1_trend} | H4: {h4_trend} | H1 RSI {rsi:.1f}"
    if not is_peak:
        regime_label += peak_note
    if is_weekend:
        regime_label += " [Weekend]"

    return {
        "trends": {"D1": d1_trend, "H4": h4_trend, "H1_rsi": round(rsi, 1)},
        "regime": regime_label,
        "signal": signal,
        "action": action_text,
        "reason_technical": action_text,
        "confidence": confidence,
        "rsi": round(rsi, 1) if rsi else 0,
        "atr": round(atr, 4) if atr else 0,
        "entry": round(entry_price, 4) if signal.startswith("ENTRY") else None,
        "sl": round(sl_price, 4) if signal.startswith("ENTRY") else None,
        "tp": round(tp_price, 4) if signal.startswith("ENTRY") else None,
        "lot_size": lot_size if signal.startswith("ENTRY") else None,
        "sparkline": df_h1["close"].tail(24).tolist(),
        "entry_zone_quality": entry_zone_quality,
        "risk_percent_used": risk_percent,
    }


def analyze_all_assets(symbols: list[str]) -> dict:
    return {sym: determine_regime_and_signal(sym) for sym in symbols}
