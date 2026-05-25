"""Backtest engine v2 — parameterized Triple Screen replay + multi-symbol + optimizer.

Strategy: D1 + H4 + H1 (Triple Screen). All previously-hardcoded thresholds are now
parameters so the optimizer can sweep them.

Modes:
  run_backtest(symbol, ...)            — single symbol
  run_backtest_multi(symbols, ...)     — N symbols, aggregated stats
  run_optimization(symbols, sweeps, ...) — grid search over parameter ranges
"""

import os
import datetime
import logging
import bisect
import itertools
from concurrent.futures import ProcessPoolExecutor, as_completed
import numpy as np
import pandas as pd
import MetaTrader5 as mt5

from app.core.database import SessionLocal, HistoricalData
from app.services.mt5_connector import resolve_symbol
from app.services.quant_desk import calculate_sma, calculate_rsi, calculate_atr

log = logging.getLogger(__name__)


# =========================
# Default strategy params
# =========================
DEFAULTS = {
    # Walk-forward-validated values (2026-05-24 — Run 3: OOS PF 4.35 / Deploy Candidate)
    "sl_atr_mult": 0.25,
    "tp_atr_mult": 4.0,
    "rsi_entry_low": 40.0,
    "rsi_entry_high": 55.0,
    "sma_fast_period": 10,
    "sma_slow_period": 60,
    "vma_period": 15,
    "rsi_period": 14,
    "atr_period": 14,
    "pending_max_age_bars": 24,
}


# =========================
# Data loading + meta
# =========================
def _load_ohlc(symbol: str, timeframe: str, start: datetime.datetime, end: datetime.datetime) -> pd.DataFrame:
    db = SessionLocal()
    try:
        rows = (
            db.query(HistoricalData)
            .filter(
                HistoricalData.symbol == symbol,
                HistoricalData.timeframe == timeframe,
                HistoricalData.time >= start,
                HistoricalData.time <= end,
            )
            .order_by(HistoricalData.time.asc())
            .all()
        )
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(
            [
                {
                    "time": r.time,
                    "open": r.open_price,
                    "high": r.high_price,
                    "low": r.low_price,
                    "close": r.close_price,
                    "tick_volume": r.tick_volume,
                    "spread": r.spread,         # may be None for pre-2026-05-26 rows
                    "real_volume": r.real_volume,
                }
                for r in rows
            ]
        )
    finally:
        db.close()


def _classify_trend(df: pd.DataFrame, idx: int) -> str:
    if idx < 50:
        return "Insufficient"
    row = df.iloc[idx]
    if pd.isna(row.get("SMA_fast")) or pd.isna(row.get("SMA_slow")):
        return "Insufficient"
    if row["close"] > row["SMA_fast"] > row["SMA_slow"]:
        return "Bullish"
    if row["close"] < row["SMA_fast"] < row["SMA_slow"]:
        return "Bearish"
    return "Sideways"


# Module-level cache so workers can be pre-populated without re-calling MT5.
# Each ProcessPoolExecutor worker has its own copy of this dict.
_symbol_meta_cache: dict[str, dict] = {}


def _get_symbol_meta(symbol: str) -> dict:
    """Fetch MT5 symbol metadata. Caches by symbol so workers can be pre-populated."""
    cached = _symbol_meta_cache.get(symbol)
    if cached is not None:
        return cached
    resolved = resolve_symbol(symbol)
    info = mt5.symbol_info(resolved)
    if info is None:
        meta = {"point": 0.0001, "digits": 5, "tick_value": 1.0, "tick_size": 0.0001, "pip_size": 0.001, "volume_min": 0.01, "volume_step": 0.01, "volume_max": 100.0}
    else:
        tick_size = info.trade_tick_size or info.point
        # Standardize "1 pip = 10 × tick_size" — matches IUX and most modern brokers.
        pip_size = tick_size * 10 if tick_size else 0
        meta = {
            "point": info.point,
            "digits": info.digits,
            "tick_value": info.trade_tick_value,
            "tick_size": tick_size,
            "pip_size": pip_size,
            "volume_min": info.volume_min,
            "volume_step": info.volume_step or 0.01,
            "volume_max": info.volume_max or 100.0,
        }
    _symbol_meta_cache[symbol] = meta
    return meta


def _prefetch_metas(symbols: list[str]) -> dict[str, dict]:
    """Parent-side: warm the cache for every symbol so workers can skip MT5 entirely."""
    return {sym: _get_symbol_meta(sym) for sym in symbols}


def _worker_run_combo(args: tuple) -> tuple[dict, dict]:
    """ProcessPoolExecutor worker. Pickles cleanly because it's a module-level function.

    Workers populate their local meta cache from the parent-fetched dict, so they never
    need to call mt5.initialize() or hit the MT5 IPC.
    """
    combo, fixed, symbols, start_date, end_date, symbol_metas, common = args
    global _symbol_meta_cache
    _symbol_meta_cache.update(symbol_metas)
    merged = {**fixed, **combo, **common}
    multi = run_backtest_multi(symbols, start_date=start_date, end_date=end_date, **merged)
    return combo, multi


def _calc_lot(equity: float, risk_pct: float, sl_distance: float, meta: dict) -> float:
    if equity <= 0 or sl_distance <= 0 or meta["tick_size"] == 0:
        return meta["volume_min"]
    risk_amount = equity * (risk_pct / 100.0)
    point_value = meta["tick_value"] / meta["tick_size"]
    raw_lot = risk_amount / (sl_distance * point_value)
    step = meta["volume_step"]
    lot = np.round(raw_lot / step) * step
    lot = max(meta["volume_min"], min(meta.get("volume_max", 100.0), lot))
    return round(float(lot), 2)


def _gross_pnl(direction: str, entry: float, exit_price: float, lot: float, meta: dict) -> float:
    point_value = meta["tick_value"] / meta["tick_size"]
    delta = (exit_price - entry) if direction == "BUY" else (entry - exit_price)
    return delta * point_value * lot


def _cost(spread_pips: float, slippage_pips: float, lot: float, meta: dict,
          actual_spread_points: float | None = None) -> float:
    """Round-trip cost in account currency = (spread + slippage) pips × pip_value × lot.

    pip_value = pip_size × point_value where point_value = tick_value / tick_size.
    For EURUSD 5-digit: pip_size=0.0001, point_value=$100,000 → pip_value=$10/lot.
    For XAUUSD 2-digit: pip_size=0.10,   point_value=$100     → pip_value=$10/lot.

    If `actual_spread_points` provided (from per-candle MT5 data), it overrides the flat
    `spread_pips` parameter — gives realistic backtest with spread variance across time.
    Falls back to `spread_pips` when None (legacy data without spread column).
    """
    if not meta["tick_size"]:
        return 0.0
    point_value = meta["tick_value"] / meta["tick_size"]
    pip_value = meta["pip_size"] * point_value
    if actual_spread_points is not None and meta.get("point") and meta.get("pip_size"):
        # Convert MT5 spread (in points) to pips. points_per_pip = pip_size / point.
        points_per_pip = meta["pip_size"] / meta["point"]
        effective_spread_pips = float(actual_spread_points) / points_per_pip if points_per_pip > 0 else spread_pips
        # Slippage model: 30% of spread (empirical CFD retail rule)
        effective_slippage_pips = 0.3 * effective_spread_pips
        return (effective_spread_pips + effective_slippage_pips) * pip_value * lot
    return (spread_pips + slippage_pips) * pip_value * lot


# =========================
# Single-symbol backtest
# =========================
def run_backtest(
    symbol: str,
    start_date: str | datetime.datetime,
    end_date: str | datetime.datetime,
    risk_percent: float = 1.0,
    spread_pips: float = 2.0,
    slippage_pips: float = 1.0,
    starting_equity: float = 10000.0,
    sl_atr_mult: float | None = None,
    tp_atr_mult: float | None = None,
    rsi_entry_low: float | None = None,
    rsi_entry_high: float | None = None,
    sma_fast_period: int | None = None,
    sma_slow_period: int | None = None,
    vma_period: int | None = None,
    rsi_period: int | None = None,
    atr_period: int | None = None,
    pending_max_age_bars: int | None = None,
) -> dict:
    """Replay Triple Screen with parameterized thresholds. All parameter kwargs fall back to DEFAULTS."""
    # Resolve params
    p = {
        "sl_atr_mult": sl_atr_mult if sl_atr_mult is not None else DEFAULTS["sl_atr_mult"],
        "tp_atr_mult": tp_atr_mult if tp_atr_mult is not None else DEFAULTS["tp_atr_mult"],
        "rsi_entry_low": rsi_entry_low if rsi_entry_low is not None else DEFAULTS["rsi_entry_low"],
        "rsi_entry_high": rsi_entry_high if rsi_entry_high is not None else DEFAULTS["rsi_entry_high"],
        "sma_fast_period": sma_fast_period if sma_fast_period is not None else DEFAULTS["sma_fast_period"],
        "sma_slow_period": sma_slow_period if sma_slow_period is not None else DEFAULTS["sma_slow_period"],
        "vma_period": vma_period if vma_period is not None else DEFAULTS["vma_period"],
        "rsi_period": rsi_period if rsi_period is not None else DEFAULTS["rsi_period"],
        "atr_period": atr_period if atr_period is not None else DEFAULTS["atr_period"],
        "pending_max_age_bars": pending_max_age_bars if pending_max_age_bars is not None else DEFAULTS["pending_max_age_bars"],
    }

    # Parse dates
    if isinstance(start_date, str):
        try:
            start = datetime.datetime.fromisoformat(start_date)
        except ValueError as e:
            return {"ok": False, "symbol": symbol, "error": f"Invalid start_date: {e}"}
    else:
        start = start_date
    if isinstance(end_date, str):
        try:
            end = datetime.datetime.fromisoformat(end_date)
        except ValueError as e:
            return {"ok": False, "symbol": symbol, "error": f"Invalid end_date: {e}"}
    else:
        end = end_date
    if end <= start:
        return {"ok": False, "symbol": symbol, "error": "end_date must be after start_date"}

    # Load — H4 needs ~30 days of warmup for SMA50, D1 needs ~120 days
    h1 = _load_ohlc(symbol, "H1", start, end)
    h4 = _load_ohlc(symbol, "H4", start - datetime.timedelta(days=30), end)
    d1 = _load_ohlc(symbol, "D1", start - datetime.timedelta(days=120), end)

    if h1.empty or h4.empty or d1.empty:
        return {
            "ok": False, "symbol": symbol,
            "error": f"Insufficient data: H1={len(h1)} H4={len(h4)} D1={len(d1)}. Run /api/historical/ingest-now first.",
        }

    # Indicators
    h1["RSI"] = calculate_rsi(h1, p["rsi_period"])
    h1["ATR"] = calculate_atr(h1, p["atr_period"])
    h1["VMA"] = calculate_sma(h1, p["vma_period"], column="tick_volume")
    for df in (h4, d1):
        df["SMA_fast"] = calculate_sma(df, p["sma_fast_period"])
        df["SMA_slow"] = calculate_sma(df, p["sma_slow_period"])

    h4_times = h4["time"].tolist()
    d1_times = d1["time"].tolist()

    meta = _get_symbol_meta(symbol)

    equity = starting_equity
    trades: list[dict] = []
    equity_curve: list[dict] = []
    active = None
    pending = None

    sma_warmup = max(p["sma_fast_period"], p["sma_slow_period"])

    def _bar_spread(bar) -> float | None:
        """Pull MT5 spread (in points) from a pandas Series row. None when column absent
        or value missing — caller falls back to flat spread_pips parameter."""
        try:
            if "spread" not in bar.index:
                return None
            v = bar["spread"]
            if v is None or pd.isna(v):
                return None
            return float(v)
        except Exception:
            return None

    def _close_position(pos: dict, exit_price: float, exit_time, reason: str, lot: float,
                        actual_spread: float | None = None) -> float:
        """Record a closing trade. Returns realized P/L (gross - cost).

        actual_spread: per-candle spread in MT5 points at the exit bar. When provided,
        backtest cost reflects spread variance (NFP spike, weekend gap) instead of flat
        spread_pips parameter. Backward-compatible: NULL/missing → falls back to flat.
        """
        nonlocal equity
        gross = _gross_pnl(pos["type"], pos["entry"], exit_price, lot, meta)
        cost = _cost(spread_pips, slippage_pips, lot, meta, actual_spread_points=actual_spread)
        pnl = gross - cost
        equity += pnl
        trades.append({
            "type": pos["type"], "symbol": symbol,
            "entry": pos["entry"], "sl": pos["initial_sl"], "tp": pos["tp"],
            "entry_time": pos["entry_time"], "exit_price": exit_price,
            "exit_time": exit_time.isoformat() if hasattr(exit_time, "isoformat") else str(exit_time),
            "reason": reason, "lot": lot,
            "gross_pnl": round(gross, 2), "cost": round(cost, 2),
            "pnl": round(pnl, 2), "equity_after": round(equity, 2),
        })
        return pnl

    def _advance_trailing(pos: dict, next_bar):
        """Update SL based on how far price has moved favorably. Handles partial close at 1.5R.

        State machine (BUY direction; SELL is mirror):
          stage 0 (initial)          : no trail yet
          stage 1 (>= 1.0R)          : SL moved to breakeven
          stage 2 (>= 1.5R)          : partial close 50%, SL locked at +0.5R
          stage 3 (>= 2.0R)          : trailing SL at max_favorable - 1.0 × ATR
          stage 4 (>= 3.0R)          : tighter trail at max_favorable - 0.5 × ATR
        """
        is_buy = pos["type"] == "BUY"
        if is_buy:
            pos["max_favorable"] = max(pos["max_favorable"], next_bar["high"])
            r = (pos["max_favorable"] - pos["entry"]) / pos["initial_sl_distance"] if pos["initial_sl_distance"] > 0 else 0
        else:
            pos["max_favorable"] = min(pos["max_favorable"], next_bar["low"])
            r = (pos["entry"] - pos["max_favorable"]) / pos["initial_sl_distance"] if pos["initial_sl_distance"] > 0 else 0

        # Stage 1 — breakeven
        if r >= 1.0 and pos["trail_stage"] < 1:
            pos["sl"] = max(pos["sl"], pos["entry"]) if is_buy else min(pos["sl"], pos["entry"])
            pos["trail_stage"] = 1

        # Stage 2 — partial close 50% + lock 0.5R
        if r >= 1.5 and pos["trail_stage"] < 2:
            close_price = pos["entry"] + 1.5 * pos["initial_sl_distance"] if is_buy else pos["entry"] - 1.5 * pos["initial_sl_distance"]
            partial_lot = round(pos["current_lot"] / 2, 2)
            if partial_lot > 0:
                _close_position(pos, close_price, next_bar["time"], "PARTIAL_TP", partial_lot,
                                actual_spread=_bar_spread(next_bar))
                pos["current_lot"] = round(pos["current_lot"] - partial_lot, 2)
            lock_price = pos["entry"] + 0.5 * pos["initial_sl_distance"] if is_buy else pos["entry"] - 0.5 * pos["initial_sl_distance"]
            pos["sl"] = max(pos["sl"], lock_price) if is_buy else min(pos["sl"], lock_price)
            pos["trail_stage"] = 2

        # Stage 3 — trail 1×ATR behind max_favorable
        if r >= 2.0 and pos["trail_stage"] < 3:
            trail = pos["max_favorable"] - pos["entry_atr"] if is_buy else pos["max_favorable"] + pos["entry_atr"]
            pos["sl"] = max(pos["sl"], trail) if is_buy else min(pos["sl"], trail)
            pos["trail_stage"] = 3

        # Stage 4 — tighter trail at 0.5×ATR
        if r >= 3.0 and pos["trail_stage"] < 4:
            trail = pos["max_favorable"] - 0.5 * pos["entry_atr"] if is_buy else pos["max_favorable"] + 0.5 * pos["entry_atr"]
            pos["sl"] = max(pos["sl"], trail) if is_buy else min(pos["sl"], trail)
            pos["trail_stage"] = 4

        # Continuous trail in stage 3+ (re-apply on each bar so SL keeps moving with new highs/lows)
        if pos["trail_stage"] == 3:
            trail = pos["max_favorable"] - pos["entry_atr"] if is_buy else pos["max_favorable"] + pos["entry_atr"]
            pos["sl"] = max(pos["sl"], trail) if is_buy else min(pos["sl"], trail)
        elif pos["trail_stage"] == 4:
            trail = pos["max_favorable"] - 0.5 * pos["entry_atr"] if is_buy else pos["max_favorable"] + 0.5 * pos["entry_atr"]
            pos["sl"] = max(pos["sl"], trail) if is_buy else min(pos["sl"], trail)

    for idx in range(sma_warmup, len(h1) - 1):
        row = h1.iloc[idx]
        next_bar = h1.iloc[idx + 1]
        bar_time = row["time"]

        d1_idx = bisect.bisect_right(d1_times, bar_time) - 1
        h4_idx = bisect.bisect_right(h4_times, bar_time) - 1
        if d1_idx < sma_warmup or h4_idx < sma_warmup:
            continue

        d1_trend = _classify_trend(d1, d1_idx)
        h4_trend = _classify_trend(h4, h4_idx)

        # === Manage active position ===
        if active:
            # 1. Update trailing state BEFORE checking SL/TP — captures momentum on the bar that's about to play out
            _advance_trailing(active, next_bar)

            # 2. Check SL/TP hit
            bar_spread = _bar_spread(next_bar)
            if active["type"] == "BUY":
                if next_bar["low"] <= active["sl"]:
                    exit_price = active["sl"] - slippage_pips * meta["pip_size"]
                    _close_position(active, exit_price, next_bar["time"], "TRAIL_SL" if active["trail_stage"] >= 1 else "SL", active["current_lot"], actual_spread=bar_spread)
                    active = None
                elif next_bar["high"] >= active["tp"]:
                    _close_position(active, active["tp"], next_bar["time"], "TP", active["current_lot"], actual_spread=bar_spread)
                    active = None
            else:
                if next_bar["high"] >= active["sl"]:
                    exit_price = active["sl"] + slippage_pips * meta["pip_size"]
                    _close_position(active, exit_price, next_bar["time"], "TRAIL_SL" if active["trail_stage"] >= 1 else "SL", active["current_lot"], actual_spread=bar_spread)
                    active = None
                elif next_bar["low"] <= active["tp"]:
                    _close_position(active, active["tp"], next_bar["time"], "TP", active["current_lot"], actual_spread=bar_spread)
                    active = None

        # Fill pending
        if pending and active is None:
            if pending["type"] == "BUY_LIMIT" and next_bar["low"] <= pending["entry"]:
                entry_p = pending["entry"]
                active = {
                    "type": "BUY", "entry": entry_p,
                    "initial_sl": pending["sl"], "sl": pending["sl"], "tp": pending["tp"],
                    "initial_sl_distance": entry_p - pending["sl"],
                    "lot": pending["lot"], "current_lot": pending["lot"],
                    "max_favorable": entry_p, "entry_atr": pending["entry_atr"],
                    "trail_stage": 0, "entry_time": next_bar["time"].isoformat(),
                }
                pending = None
            elif pending["type"] == "SELL_LIMIT" and next_bar["high"] >= pending["entry"]:
                entry_p = pending["entry"]
                active = {
                    "type": "SELL", "entry": entry_p,
                    "initial_sl": pending["sl"], "sl": pending["sl"], "tp": pending["tp"],
                    "initial_sl_distance": pending["sl"] - entry_p,
                    "lot": pending["lot"], "current_lot": pending["lot"],
                    "max_favorable": entry_p, "entry_atr": pending["entry_atr"],
                    "trail_stage": 0, "entry_time": next_bar["time"].isoformat(),
                }
                pending = None
            elif pending:
                pending["_bars_since_create"] += 1
                if pending["_bars_since_create"] > p["pending_max_age_bars"]:
                    pending = None

        # New signal
        if active is None and pending is None:
            if d1_trend == h4_trend and d1_trend in ("Bullish", "Bearish"):
                rsi = row["RSI"]
                atr = row["ATR"]
                vol = row["tick_volume"]
                vma = row["VMA"]
                if not (pd.isna(rsi) or pd.isna(atr) or pd.isna(vma)):
                    if p["rsi_entry_low"] <= rsi <= p["rsi_entry_high"] and vol > vma:
                        if d1_trend == "Bullish":
                            entry = float(row["low"])
                            sl = entry - p["sl_atr_mult"] * atr
                            tp = entry + p["tp_atr_mult"] * atr
                            lot = _calc_lot(equity, risk_percent, entry - sl, meta)
                            if lot > 0:
                                pending = {"type": "BUY_LIMIT", "entry": entry, "sl": sl, "tp": tp, "lot": lot, "entry_atr": atr, "create_time": bar_time, "_bars_since_create": 0}
                        else:
                            entry = float(row["high"])
                            sl = entry + p["sl_atr_mult"] * atr
                            tp = entry - p["tp_atr_mult"] * atr
                            lot = _calc_lot(equity, risk_percent, sl - entry, meta)
                            if lot > 0:
                                pending = {"type": "SELL_LIMIT", "entry": entry, "sl": sl, "tp": tp, "lot": lot, "entry_atr": atr, "create_time": bar_time, "_bars_since_create": 0}

        # Mark-to-market
        if active:
            mtm = _gross_pnl(active["type"], active["entry"], row["close"], active["current_lot"], meta)
            current_equity = equity + mtm
        else:
            current_equity = equity
        equity_curve.append({"time": bar_time.isoformat(), "equity": round(current_equity, 2)})

    stats = _compute_stats(trades, equity_curve, starting_equity)

    return {
        "ok": True,
        "symbol": symbol,
        "start_date": start.isoformat() if isinstance(start, datetime.datetime) else start_date,
        "end_date": end.isoformat() if isinstance(end, datetime.datetime) else end_date,
        "config": {
            "risk_percent": risk_percent,
            "spread_pips": spread_pips,
            "slippage_pips": slippage_pips,
            "starting_equity": starting_equity,
            **p,
        },
        "stats": stats,
        "equity_curve": equity_curve,
        "trades": trades,
        "candles_processed": max(0, len(h1) - sma_warmup),
    }


def _compute_stats(trades: list[dict], equity_curve: list[dict], starting_equity: float) -> dict:
    if not trades:
        return {
            "trade_count": 0, "win_count": 0, "loss_count": 0,
            "win_rate": 0, "total_pnl": 0, "total_return_pct": 0,
            "profit_factor": 0, "max_drawdown_pct": 0, "sharpe_like": 0,
            "avg_win": 0, "avg_loss": 0, "largest_win": 0, "largest_loss": 0,
        }
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    total_pnl = sum(t["pnl"] for t in trades)
    gross_win = sum(t["pnl"] for t in wins)
    gross_loss = abs(sum(t["pnl"] for t in losses))

    equity_values = [e["equity"] for e in equity_curve]
    if equity_values:
        peak = equity_values[0]
        max_dd_pct = 0.0
        for v in equity_values:
            if v > peak:
                peak = v
            dd_pct = ((peak - v) / peak) * 100 if peak > 0 else 0
            max_dd_pct = max(max_dd_pct, dd_pct)
    else:
        max_dd_pct = 0.0

    # Sharpe-like: mean return / std return (per trade)
    pnls = [t["pnl"] for t in trades]
    sharpe_like = 0.0
    if len(pnls) > 1:
        mean_pnl = sum(pnls) / len(pnls)
        var = sum((p - mean_pnl) ** 2 for p in pnls) / (len(pnls) - 1)
        std = var ** 0.5
        sharpe_like = round(mean_pnl / std, 3) if std > 0 else 0.0

    return {
        "trade_count": len(trades),
        "win_count": len(wins),
        "loss_count": len(losses),
        "win_rate": round(len(wins) / len(trades) * 100, 2) if trades else 0,
        "total_pnl": round(total_pnl, 2),
        "total_return_pct": round((total_pnl / starting_equity) * 100, 2) if starting_equity > 0 else 0,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else (round(gross_win, 2) if gross_win > 0 else 0),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "sharpe_like": sharpe_like,
        "avg_win": round(gross_win / len(wins), 2) if wins else 0,
        "avg_loss": round(-gross_loss / len(losses), 2) if losses else 0,
        "largest_win": round(max((t["pnl"] for t in wins), default=0), 2),
        "largest_loss": round(min((t["pnl"] for t in losses), default=0), 2),
    }


# =========================
# Multi-symbol backtest
# =========================
def run_backtest_multi(symbols: list[str], starting_equity: float = 10000.0, **kwargs) -> dict:
    """Run backtest on each symbol with the same params. Aggregate stats across all.

    Equity for sizing is shared/independent? In this v1 we run each symbol with the same
    starting_equity (parallel portfolios — independent test). The aggregate stats sum the
    P/L numbers across symbols.
    """
    per_symbol = []
    all_trades = []
    aggregate_equity_seed = starting_equity * max(1, len(symbols))
    aggregate_pnl = 0.0

    for sym in symbols:
        res = run_backtest(sym, starting_equity=starting_equity, **kwargs)
        if not res.get("ok"):
            per_symbol.append({"symbol": sym, "ok": False, "error": res.get("error"), "stats": None})
            continue
        per_symbol.append({"symbol": sym, "ok": True, "stats": res["stats"], "trade_count": res["stats"]["trade_count"]})
        for t in res["trades"]:
            all_trades.append({**t, "symbol": sym})
        aggregate_pnl += res["stats"]["total_pnl"]

    successful = [s for s in per_symbol if s.get("ok")]
    failed = [s for s in per_symbol if not s.get("ok")]

    # Build aggregate stats from successful runs
    if successful:
        total_trades = sum(s["stats"]["trade_count"] for s in successful)
        total_wins = sum(s["stats"]["win_count"] for s in successful)
        total_losses = sum(s["stats"]["loss_count"] for s in successful)
        gross_win = sum(s["stats"]["avg_win"] * s["stats"]["win_count"] for s in successful)
        gross_loss = abs(sum(s["stats"]["avg_loss"] * s["stats"]["loss_count"] for s in successful))
        # Max DD per symbol — we report the worst single-symbol DD as a portfolio proxy
        max_dd = max(s["stats"]["max_drawdown_pct"] for s in successful) if successful else 0

        aggregate = {
            "total_pnl": round(aggregate_pnl, 2),
            "total_return_pct": round((aggregate_pnl / aggregate_equity_seed) * 100, 2) if aggregate_equity_seed > 0 else 0,
            "trade_count": total_trades,
            "win_count": total_wins,
            "loss_count": total_losses,
            "win_rate": round(total_wins / total_trades * 100, 2) if total_trades > 0 else 0,
            "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else (round(gross_win, 2) if gross_win > 0 else 0),
            "max_drawdown_pct": round(max_dd, 2),
            "symbols_traded": len([s for s in successful if s["trade_count"] > 0]),
            "symbols_no_trades": len([s for s in successful if s["trade_count"] == 0]),
        }
    else:
        aggregate = {"total_pnl": 0, "trade_count": 0, "error": "All symbols failed", "max_drawdown_pct": 0, "win_rate": 0, "profit_factor": 0}

    return {
        "ok": len(successful) > 0,
        "symbols_requested": symbols,
        "successful": [s["symbol"] for s in successful],
        "failed": [{"symbol": s["symbol"], "error": s.get("error")} for s in failed],
        "aggregate": aggregate,
        "per_symbol": per_symbol,
        "all_trades": all_trades,
        "config": {"starting_equity": starting_equity, **kwargs},
    }


# =========================
# Optimizer (grid search)
# =========================
def _build_grid(sweeps: dict) -> list[dict]:
    """Convert {param: [v1, v2, v3]} to [{param: v1}, {param: v2}, {param: v3}].

    sweeps may include None values (= use default). Empty arrays are skipped.
    """
    names: list[str] = []
    ranges: list[list] = []
    for name, vals in sweeps.items():
        if not vals:
            continue
        if not isinstance(vals, list):
            continue
        names.append(name)
        ranges.append(list(vals))
    combos: list[dict] = []
    for tup in itertools.product(*ranges):
        combos.append(dict(zip(names, tup)))
    return combos


METRIC_NAMES = ["total_pnl", "total_return_pct", "profit_factor", "win_rate", "sharpe_like", "max_drawdown_pct", "trade_count"]


def _rank_value(stats: dict, metric: str) -> float:
    """Higher = better. For drawdown we invert."""
    v = stats.get(metric, 0)
    if metric == "max_drawdown_pct":
        return -float(v) if v else 0
    return float(v) if v is not None else 0


def _default_max_workers() -> int:
    """Cap at 80% of logical CPUs per user preference. Leave 2-3 cores for OS+MT5+browser."""
    cpu = os.cpu_count() or 4
    # 80% rule: floor(cpu * 0.8) — leaves at least 2 cores for OS even on small machines.
    return max(2, min(int(cpu * 0.8), 10))


def run_optimization(
    symbols: list[str],
    start_date: str,
    end_date: str,
    sweeps: dict,
    fixed: dict | None = None,
    rank_by: str = "profit_factor",
    top_n: int = 20,
    require_min_trades: int = 5,
    progress_callback=None,
    parallel: bool = True,
    max_workers: int | None = None,
    walk_forward: bool = False,
    train_ratio: float = 0.67,
) -> dict:
    """Grid-search across sweeps × symbols.

    Args:
        symbols: list of symbols. Each combo runs on each symbol; results are aggregated.
        sweeps: {param_name: [values_to_try]}. Empty/missing param = use default.
        fixed: {param_name: value} for non-swept params. Applied to all runs.
        rank_by: metric in METRIC_NAMES.
        top_n: number of best combos to return.
        require_min_trades: filter out combos that traded fewer than this across the portfolio.

    Returns:
        {
          ok, total_combos, total_runs, ranked: [{rank, params, aggregate, per_symbol_trades}, ...],
          best, worst, rank_by, ...
        }
    """
    if rank_by not in METRIC_NAMES:
        return {"ok": False, "error": f"rank_by must be one of {METRIC_NAMES}"}

    combos = _build_grid(sweeps)
    if not combos:
        return {"ok": False, "error": "No parameter combinations to test (sweeps was empty)"}

    # ── Walk-forward split (optional) ──
    # Train on the first `train_ratio` of the window, test on the rest.
    # Each ranked combo is then ALSO scored on the test window. The OOS/IS ratio
    # tells us if the winning params are robust or overfit to in-sample noise.
    is_start, is_end = start_date, end_date
    oos_start, oos_end = None, None
    if walk_forward:
        try:
            s = datetime.datetime.fromisoformat(start_date)
            e = datetime.datetime.fromisoformat(end_date)
        except ValueError as ex:
            return {"ok": False, "error": f"walk-forward date parse failed: {ex}"}
        if e <= s:
            return {"ok": False, "error": "end_date must be after start_date"}
        if not (0.4 <= train_ratio <= 0.9):
            return {"ok": False, "error": "train_ratio must be between 0.4 and 0.9"}
        total_days = (e - s).total_seconds() / 86400
        train_days = total_days * train_ratio
        split_date = s + datetime.timedelta(days=train_days)
        is_start, is_end = s.isoformat(), split_date.isoformat()
        oos_start, oos_end = split_date.isoformat(), e.isoformat()

    fixed = fixed or {}
    results = []
    started = datetime.datetime.now()
    total_runs = len(combos) * len(symbols)
    runs_done = 0
    combos_done = 0

    def _record(combo: dict, multi: dict):
        """Filter + accumulate one combo's result."""
        agg = multi.get("aggregate", {})
        if agg.get("trade_count", 0) < require_min_trades:
            return
        results.append({
            "params": combo,
            "aggregate": agg,
            "per_symbol_trades": [
                {"symbol": s["symbol"], "trade_count": s.get("trade_count", 0), "total_pnl": s["stats"]["total_pnl"] if s.get("ok") else 0}
                for s in multi.get("per_symbol", [])
            ],
        })

    use_parallel = parallel and len(combos) > 1
    workers_actual = max_workers or _default_max_workers()

    if use_parallel:
        # Pre-fetch symbol metas in PARENT (workers won't touch MT5).
        metas = _prefetch_metas(symbols)
        common: dict = {}
        worker_args = [
            (combo, fixed, symbols, is_start, is_end, metas, common)
            for combo in combos
        ]

        with ProcessPoolExecutor(max_workers=workers_actual) as executor:
            futures = {executor.submit(_worker_run_combo, args): args[0] for args in worker_args}
            for future in as_completed(futures):
                try:
                    combo, multi = future.result()
                    _record(combo, multi)
                except Exception as e:
                    log.error("Parallel worker combo failed: %s", e)
                finally:
                    combos_done += 1
                    runs_done += len(symbols)
                    if progress_callback:
                        try:
                            progress_callback(combos_done, len(combos), runs_done, total_runs)
                        except Exception:
                            pass
    else:
        for i, combo in enumerate(combos):
            merged_params = {**fixed, **combo}
            multi = run_backtest_multi(symbols, start_date=is_start, end_date=is_end, **merged_params)
            runs_done += len(symbols)
            combos_done += 1
            if progress_callback:
                try:
                    progress_callback(combos_done, len(combos), runs_done, total_runs)
                except Exception:
                    pass
            _record(combo, multi)

    # Rank by IS performance
    results.sort(key=lambda r: _rank_value(r["aggregate"], rank_by), reverse=True)
    for i, r in enumerate(results):
        r["rank"] = i + 1

    # ── Walk-forward: validate top-N IS results on the OOS test window ──
    if walk_forward and results:
        top_to_validate = results[:top_n]
        for r in top_to_validate:
            try:
                oos_multi = run_backtest_multi(
                    symbols, start_date=oos_start, end_date=oos_end,
                    **{**fixed, **r["params"]},
                )
                oos_agg = oos_multi.get("aggregate", {})
                r["is_aggregate"] = r["aggregate"]  # rename in-sample for clarity
                r["oos_aggregate"] = oos_agg
                is_pf = r["aggregate"].get("profit_factor", 0) or 0
                oos_pf = oos_agg.get("profit_factor", 0) or 0
                r["robustness_score"] = round(oos_pf / is_pf, 3) if is_pf > 0 else 0
                # Robustness label
                if r["robustness_score"] >= 0.85:
                    r["robustness_label"] = "Robust"
                elif r["robustness_score"] >= 0.50:
                    r["robustness_label"] = "Marginal"
                else:
                    r["robustness_label"] = "Overfit"
            except Exception as e:
                log.warning("WF validation failed for rank %d: %s", r["rank"], e)
                r["oos_aggregate"] = {"error": str(e)}
                r["robustness_score"] = 0
                r["robustness_label"] = "Error"

    duration_s = (datetime.datetime.now() - started).total_seconds()

    return {
        "ok": True,
        "rank_by": rank_by,
        "total_combos": len(combos),
        "qualified": len(results),
        "filtered_out_low_trades": len(combos) - len(results),
        "ranked": results[:top_n],
        "best": results[0] if results else None,
        "worst": results[-1] if results else None,
        "duration_seconds": round(duration_s, 2),
        "parallel": use_parallel,
        "workers_used": workers_actual if use_parallel else 1,
        "walk_forward": walk_forward,
        "walk_forward_split": {
            "train_ratio": train_ratio,
            "train_start": is_start,
            "train_end": is_end,
            "test_start": oos_start,
            "test_end": oos_end,
        } if walk_forward else None,
        "config": {
            "symbols": symbols,
            "start_date": start_date,
            "end_date": end_date,
            "sweeps": sweeps,
            "fixed": fixed,
            "rank_by": rank_by,
            "require_min_trades": require_min_trades,
        },
    }
