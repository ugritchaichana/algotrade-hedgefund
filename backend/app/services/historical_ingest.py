"""Historical OHLC ingest into Postgres.

Feeds the `historical_data` table used by the backtest engine. Run automatically
on a schedule (D1 daily, H4 every 4h, H1 hourly) from main.py, or manually via
POST /api/historical/ingest-now.

Storage model: one row per (symbol, timeframe, time) — enforced by the unique
constraint in app.core.database.HistoricalData. Re-runs are idempotent thanks
to Postgres ON CONFLICT DO NOTHING.

Initial backfill window per timeframe (broker returns whatever it has up to this cap):
  D1: 5000 candles (~14 years)
  H4: 5000 candles (~2.5 years)
  H1: 5000 candles (~7 months)
  M1: 300000 candles (~7 months — actual depth depends on IUX broker history)
Subsequent runs only fetch candles after the latest stored timestamp.
"""

import datetime
import logging
import MetaTrader5 as mt5
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy import func

from app.core.database import SessionLocal, HistoricalData
from app.services.mt5_connector import resolve_symbol, init_mt5

log = logging.getLogger(__name__)

TF_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}

INITIAL_BACKFILL = {
    "D1": 5000,   # ~14 years of daily candles
    "H4": 5000,   # ~2.5 years
    "H1": 5000,   # ~7 months
    "M30": 2000,
    "M15": 2000,
    "M5": 2000,
    "M1": 300000,  # ~7 months — broker returns whatever depth IUX provides
}


def _ensure_mt5() -> bool:
    if mt5.terminal_info():
        return True
    return init_mt5()


def ingest_timeframe(symbol: str, tf_str: str) -> dict:
    """Ingest OHLC for one (symbol, timeframe). Idempotent — no duplicates."""
    if tf_str not in TF_MAP:
        return {"ok": False, "symbol": symbol, "timeframe": tf_str, "error": "invalid_timeframe"}

    if not _ensure_mt5():
        return {"ok": False, "symbol": symbol, "timeframe": tf_str, "error": "mt5_not_initialized"}

    tf_const = TF_MAP[tf_str]
    resolved = resolve_symbol(symbol)
    db = SessionLocal()
    try:
        last_row = (
            db.query(HistoricalData)
            .filter(HistoricalData.symbol == symbol, HistoricalData.timeframe == tf_str)
            .order_by(HistoricalData.time.desc())
            .first()
        )

        if last_row:
            # Fetch candles since the last stored timestamp (+ small overlap to catch updates)
            from_dt = last_row.time - datetime.timedelta(minutes=1)
            rates = mt5.copy_rates_range(resolved, tf_const, from_dt, datetime.datetime.now())
        else:
            count = INITIAL_BACKFILL.get(tf_str, 1000)
            rates = mt5.copy_rates_from_pos(resolved, tf_const, 0, count)

        if rates is None or len(rates) == 0:
            return {
                "ok": True, "symbol": symbol, "timeframe": tf_str,
                "inserted": 0, "fetched": 0, "reason": "no_data",
            }

        # MT5 copy_rates returns numpy structured array; field names available via dtype.names
        rate_fields = set(rates.dtype.names or ()) if hasattr(rates, "dtype") else set()
        has_spread = "spread" in rate_fields
        has_real_volume = "real_volume" in rate_fields
        rows = [
            {
                "symbol": symbol,
                "timeframe": tf_str,
                "time": datetime.datetime.fromtimestamp(int(r["time"])),
                "open_price": float(r["open"]),
                "high_price": float(r["high"]),
                "low_price": float(r["low"]),
                "close_price": float(r["close"]),
                "tick_volume": int(r["tick_volume"]),
                "spread": int(r["spread"]) if has_spread else None,
                "real_volume": int(r["real_volume"]) if has_real_volume else None,
            }
            for r in rates
        ]

        stmt = pg_insert(HistoricalData.__table__).values(rows)
        stmt = stmt.on_conflict_do_nothing(index_elements=["symbol", "timeframe", "time"])
        result = db.execute(stmt)
        db.commit()

        inserted = result.rowcount or 0
        if inserted > 0:
            try:
                from app.core.events import broadcast_event
                broadcast_event("INGEST_TICK", {
                    "symbol": symbol,
                    "timeframe": tf_str,
                    "inserted": inserted,
                    "latest_time": rows[-1]["time"].isoformat() if rows else None,
                }, throttle_key=f"ingest:{tf_str}")
            except Exception:
                pass

        return {
            "ok": True, "symbol": symbol, "timeframe": tf_str,
            "fetched": len(rows), "inserted": inserted,
        }
    except Exception as e:
        db.rollback()
        log.error("ingest %s %s failed: %s", symbol, tf_str, e)
        return {"ok": False, "symbol": symbol, "timeframe": tf_str, "error": str(e)}
    finally:
        db.close()


def ingest_all_configured(symbols: list[str], timeframes: list[str] | None = None) -> dict:
    """Batch ingest across symbols x timeframes. Used by POST /api/historical/ingest-now."""
    timeframes = timeframes or ["D1", "H4", "H1"]
    summary = {"runs": [], "totals": {"fetched": 0, "inserted": 0, "errors": 0}}
    for sym in symbols:
        for tf in timeframes:
            res = ingest_timeframe(sym, tf)
            summary["runs"].append(res)
            if res.get("ok"):
                summary["totals"]["fetched"] += res.get("fetched", 0)
                summary["totals"]["inserted"] += res.get("inserted", 0)
            else:
                summary["totals"]["errors"] += 1
    return summary


def deep_backfill_timeframe(symbol: str, tf_str: str, count: int | None = None) -> dict:
    """Force-fetch the LATEST N candles regardless of what's already in Postgres.

    Unlike ingest_timeframe (which only fetches forward from the last stored timestamp),
    this always pulls the full historical window. Unique constraint handles overlap.

    Used to backfill deeper history when INITIAL_BACKFILL is increased post-deploy.
    """
    if tf_str not in TF_MAP:
        return {"ok": False, "symbol": symbol, "timeframe": tf_str, "error": "invalid_timeframe"}
    if not _ensure_mt5():
        return {"ok": False, "symbol": symbol, "timeframe": tf_str, "error": "mt5_not_initialized"}

    tf_const = TF_MAP[tf_str]
    target_count = count or INITIAL_BACKFILL.get(tf_str, 5000)
    resolved = resolve_symbol(symbol)
    db = SessionLocal()
    try:
        rates = mt5.copy_rates_from_pos(resolved, tf_const, 0, target_count)
        if rates is None or len(rates) == 0:
            return {"ok": True, "symbol": symbol, "timeframe": tf_str, "fetched": 0, "inserted": 0, "reason": "broker_returned_empty"}

        # MT5 copy_rates returns numpy structured array; field names available via dtype.names
        rate_fields = set(rates.dtype.names or ()) if hasattr(rates, "dtype") else set()
        has_spread = "spread" in rate_fields
        has_real_volume = "real_volume" in rate_fields
        rows = [
            {
                "symbol": symbol,
                "timeframe": tf_str,
                "time": datetime.datetime.fromtimestamp(int(r["time"])),
                "open_price": float(r["open"]),
                "high_price": float(r["high"]),
                "low_price": float(r["low"]),
                "close_price": float(r["close"]),
                "tick_volume": int(r["tick_volume"]),
                "spread": int(r["spread"]) if has_spread else None,
                "real_volume": int(r["real_volume"]) if has_real_volume else None,
            }
            for r in rates
        ]
        stmt = pg_insert(HistoricalData.__table__).values(rows)
        stmt = stmt.on_conflict_do_nothing(index_elements=["symbol", "timeframe", "time"])
        result = db.execute(stmt)
        db.commit()
        return {
            "ok": True, "symbol": symbol, "timeframe": tf_str,
            "fetched": len(rows), "inserted": result.rowcount or 0,
        }
    except Exception as e:
        db.rollback()
        log.error("deep_backfill %s %s failed: %s", symbol, tf_str, e)
        return {"ok": False, "symbol": symbol, "timeframe": tf_str, "error": str(e)}
    finally:
        db.close()


def deep_backfill_all(symbols: list[str], timeframes: list[str] | None = None) -> dict:
    """Full deep backfill across all symbols x timeframes. Idempotent thanks to ON CONFLICT."""
    timeframes = timeframes or ["D1", "H4", "H1"]
    summary = {"runs": [], "totals": {"fetched": 0, "inserted": 0, "errors": 0}}
    for sym in symbols:
        for tf in timeframes:
            res = deep_backfill_timeframe(sym, tf)
            summary["runs"].append(res)
            if res.get("ok"):
                summary["totals"]["fetched"] += res.get("fetched", 0)
                summary["totals"]["inserted"] += res.get("inserted", 0)
            else:
                summary["totals"]["errors"] += 1
    return summary


def get_ingest_status() -> dict:
    """Return count + first/last timestamp per (symbol, timeframe). Used by Data Status UI."""
    db = SessionLocal()
    try:
        rows = (
            db.query(
                HistoricalData.symbol,
                HistoricalData.timeframe,
                func.count(HistoricalData.id).label("count"),
                func.min(HistoricalData.time).label("first"),
                func.max(HistoricalData.time).label("last"),
            )
            .group_by(HistoricalData.symbol, HistoricalData.timeframe)
            .all()
        )
        return {
            "rows": [
                {
                    "symbol": r.symbol,
                    "timeframe": r.timeframe,
                    "count": int(r.count),
                    "first": r.first.isoformat() if r.first else None,
                    "last": r.last.isoformat() if r.last else None,
                }
                for r in rows
            ]
        }
    finally:
        db.close()
