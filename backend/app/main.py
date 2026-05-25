"""FastAPI entry point for the AlgoTrade HedgeFund backend.

Responsibilities
================
1. Boot MT5 IPC + Postgres schema + scheduler on startup.
2. Serve REST endpoints under /api/* for the React dashboard.
3. Push live tick data + per-symbol signal updates over WebSocket (/api/ws/market).
4. Run the autonomous trade engine via APScheduler:
   - Every 2s: broadcast tick + orders + account snapshot to all WS clients.
   - Hourly at HH:00:05: scan symbols with Triple Screen (D1+H4+H1), auto-place
     pending limit orders for ENTRY signals (subject to safety gates below).
   - Daily 00:30 UTC+7: ingest D1 OHLC for all configured assets (backtest data).
   - Every 4h at HH:15: ingest H4 OHLC.
   - Hourly at HH:02 (just after signal scan): ingest fresh H1 OHLC.

Safety gates on the auto-trade path
===================================
- auto_trade_enabled setting must be 'true' (kill switch).
- MT5 ping < 1000ms.
- Currently open positions < max_open_positions.
- Today's realized drawdown < max_daily_drawdown_pct of starting-of-day equity.
- Per-symbol: spread under profile.max_spread (enforced in execution_desk).
- Per-symbol: no duplicate position / pending order in same direction.
"""

import os
import json
import uuid
import asyncio
import logging
import datetime
import requests
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from pydantic import BaseModel
from dotenv import load_dotenv

from app.services.mt5_connector import (
    init_mt5,
    shutdown_mt5,
    get_realtime_prices,
    get_active_orders,
    get_account_status_full,
    get_all_symbols,
    get_chart_data,
    check_terminal_health,
    get_account_info,
    ensure_connected,
)
from app.services.quant_desk import determine_regime_and_signal, analyze_all_assets
from app.services.macro_desk import get_morning_briefing, invalidate_briefing_cache
from app.services.risk_desk import get_risk_assessment, invalidate_risk_cache
from app.services.execution_desk import execute_trade
from app.services.discord_notifier import send_discord_alert, notify_trade_signal, notify_safety_event
from app.services.reflection_desk import run_daily_reflection
from app.services.historical_ingest import ingest_timeframe, get_ingest_status, ingest_all_configured, deep_backfill_all
from app.services.backtest_engine import run_backtest, run_backtest_multi, run_optimization, DEFAULTS as BT_DEFAULTS

from app.core.database import (
    init_db,
    get_db,
    SessionLocal,
    ActionLog,
    SystemSettings,
    TradeState,
    HistoricalData,
    EquitySnapshot,
    TradeJournalEntry,
    SignalState,
    OptimizeJob,
    PendingAction,
    log_action,
    reset_core_assets_to_defaults,
)
from app.core.asset_profiles import G1_ASSETS
from app.api.ws import router as ws_router, manager

import MetaTrader5 as mt5

load_dotenv()
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
# Attach JSON file sink alongside stdout — additive, no migration of existing log calls needed.
try:
    from app.core.logging_config import configure_json_logging
    configure_json_logging()
except Exception as _log_e:
    logging.getLogger(__name__).warning("JSON logging init failed: %s", _log_e)
log = logging.getLogger(__name__)


# ===== Cached settings (invalidated on POST /api/settings) =====
_cached_settings: dict[str, str] | None = None
# In-memory caches BACKED BY DB (signal_state table). Kept for sub-ms read performance
# in broadcast loops; reloaded from DB on lifespan startup so restart doesn't wipe.
_last_notified_signal: dict[str, str | None] = {}
_last_quant_data: dict[str, dict] = {}
_backend_started_at: str = datetime.datetime.utcnow().isoformat()
_last_quant_scan_time: datetime.datetime | None = None


def _persist_signal_state(symbol: str, signal: str, data: dict, notified: bool = False) -> None:
    """Upsert signal_state row. Idempotent. Called from background_quant_analysis."""
    db = SessionLocal()
    try:
        row = db.query(SignalState).filter(SignalState.symbol == symbol).first()
        now = datetime.datetime.utcnow()
        if row is None:
            row = SignalState(
                symbol=symbol,
                last_scan_at=now,
                last_signal=signal,
                last_data_json=json.dumps(data, default=str),
                last_notified_signal=signal if notified else None,
                last_notified_at=now if notified else None,
            )
            db.add(row)
        else:
            row.last_scan_at = now
            row.last_signal = signal
            row.last_data_json = json.dumps(data, default=str)
            if notified:
                row.last_notified_signal = signal
                row.last_notified_at = now
        db.commit()
    except Exception as e:
        log.error("persist_signal_state(%s) failed: %s", symbol, e)
        db.rollback()
    finally:
        db.close()


def _load_signal_state_into_memory() -> None:
    """Populate _last_quant_data + _last_notified_signal from signal_state table.
    Called once at lifespan startup so restart doesn't lose state."""
    db = SessionLocal()
    try:
        rows = db.query(SignalState).all()
        for r in rows:
            if r.last_data_json:
                try:
                    _last_quant_data[r.symbol] = json.loads(r.last_data_json)
                except Exception:
                    pass
            _last_notified_signal[r.symbol] = r.last_notified_signal
        log.info("Loaded %d signal_state rows into memory", len(rows))
    except Exception as e:
        log.warning("_load_signal_state_into_memory failed: %s", e)
    finally:
        db.close()

# NOTE: Long-running optimize jobs live in `optimize_jobs` table (DB-first as of 2026-05-26).
# In-memory _jobs dict + _jobs_lock + _gc_old_jobs removed. Persistence + history + multi-tab
# resilience handled via DB queries on /api/jobs/* endpoints.


def get_setting(key: str, default: str = "") -> str:
    global _cached_settings
    if _cached_settings is None:
        db = SessionLocal()
        try:
            _cached_settings = {row.key: row.value for row in db.query(SystemSettings).all()}
        finally:
            db.close()
    return _cached_settings.get(key, default)


def get_core_assets() -> list[str]:
    raw = get_setting("core_assets", json.dumps(G1_ASSETS))
    try:
        return json.loads(raw)
    except Exception:
        return list(G1_ASSETS)


def invalidate_settings_cache() -> None:
    global _cached_settings
    _cached_settings = None


def _today_realized_pnl() -> float:
    """Sum today's realized profit from MT5 history deals (BUY/SELL closing deals only)."""
    now = datetime.datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(midnight, now) or []
    total = 0.0
    for d in deals:
        if d.entry == mt5.DEAL_ENTRY_OUT:  # BUY or SELL closing
            total += d.profit + d.commission + d.swap
    return total


# ===== Safety gates =====
def _safety_gates_pass(sym: str) -> tuple[bool, str]:
    """Return (allowed, reason_if_not). All gates must pass to proceed with auto-trade."""
    # Gate 1: kill switch
    if get_setting("auto_trade_enabled", "true").lower() != "true":
        return False, "kill_switch_off"

    # Gate 2: ping latency (with reconnect attempt on disconnect)
    health = check_terminal_health()
    if not health["connected"]:
        if not ensure_connected():
            notify_safety_event("MT5 Reconnect Failed", "Auto-trade halted — could not re-establish MT5 IPC after 3 attempts")
            return False, "mt5_disconnected"
        # Re-check after reconnect
        health = check_terminal_health()
        if not health["connected"]:
            return False, "mt5_disconnected"
    if not health["trade_allowed"]:
        return False, "algo_trading_disabled"
    if health["ping_ms"] > 1000:
        msg = f"Ping {health['ping_ms']:.0f}ms > 1000ms — auto-trade skipped this cycle"
        log.warning(msg)
        notify_safety_event("High Latency", msg)
        return False, "ping_too_high"

    # Gate 3: max open positions
    try:
        max_open = int(get_setting("max_open_positions", "5"))
    except ValueError:
        max_open = 5
    positions = mt5.positions_get() or []
    if len(positions) >= max_open:
        return False, f"max_positions_reached ({len(positions)}/{max_open})"

    # Gate 4: daily drawdown limit
    try:
        max_dd_pct = float(get_setting("max_daily_drawdown_pct", "3.0"))
    except ValueError:
        max_dd_pct = 3.0
    account = get_account_info()
    if account and account.get("equity", 0) > 0:
        realized = _today_realized_pnl()
        if realized < 0:
            # Drawdown as % of current equity (conservative — equity is post-drawdown)
            dd_pct = (abs(realized) / account["equity"]) * 100
            if dd_pct >= max_dd_pct:
                msg = f"Daily realized DD {dd_pct:.2f}% >= limit {max_dd_pct:.2f}% — auto-trade halted today"
                log.warning(msg)
                notify_safety_event("Daily DD Limit", msg)
                return False, "daily_dd_limit"

    # Gate 5: max daily trades
    try:
        max_daily_trades = int(get_setting("max_daily_trades", "8"))
    except ValueError:
        max_daily_trades = 8
        
    from app.core.database import SessionLocal, TradeJournalEntry
    db = SessionLocal()
    try:
        today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        trades_today = db.query(TradeJournalEntry).filter(TradeJournalEntry.created_at >= today_start).count()
        if trades_today >= max_daily_trades:
            msg = f"Max daily trades reached ({trades_today}/{max_daily_trades}) — auto-trade halted today"
            log.warning(msg)
            notify_safety_event("Daily Trade Cap Limit", msg)
            return False, "max_daily_trades"
    except Exception as e:
        log.error("_safety_gates_pass db check failed: %s", e)
    finally:
        db.close()

    # Gate 6: slippage forecast — when M1 historical_data has spread, predict current
    # spread for this (symbol, hour-of-day) and skip if forecast >> baseline.
    # Only fires when we have enough recent data (rolling 30d, at least 100 candles).
    try:
        slippage_max_mult = float(get_setting("slippage_forecast_max_mult", "3.0"))
    except ValueError:
        slippage_max_mult = 3.0
    if slippage_max_mult > 0:
        try:
            db2 = SessionLocal()
            try:
                cur_hour = datetime.datetime.utcnow().hour
                cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=30)
                from sqlalchemy import func as _func, extract as _extract
                row = (db2.query(_func.avg(HistoricalData.spread).label("avg_spread"),
                                  _func.count(HistoricalData.id).label("n"))
                       .filter(HistoricalData.symbol == sym,
                               HistoricalData.timeframe == "M1",
                               HistoricalData.time >= cutoff,
                               _extract("hour", HistoricalData.time) == cur_hour,
                               HistoricalData.spread != None)  # noqa: E711
                       .first())
                if row and row.n is not None and row.n >= 100 and row.avg_spread is not None:
                    # Get all-hours baseline for comparison
                    base = (db2.query(_func.avg(HistoricalData.spread))
                            .filter(HistoricalData.symbol == sym,
                                    HistoricalData.timeframe == "M1",
                                    HistoricalData.time >= cutoff,
                                    HistoricalData.spread != None)  # noqa: E711
                            .scalar())
                    if base and base > 0:
                        ratio = float(row.avg_spread) / float(base)
                        if ratio >= slippage_max_mult:
                            msg = (f"{sym} slippage forecast hour={cur_hour}h: avg_spread {row.avg_spread:.1f} "
                                   f"vs baseline {base:.1f} (ratio {ratio:.2f}x >= {slippage_max_mult}x) — skip")
                            log.warning(msg)
                            notify_safety_event("Slippage Forecast Block", msg)
                            return False, "slippage_forecast_high"
            finally:
                db2.close()
        except Exception as e:
            log.debug("slippage forecast gate failed (likely no spread data yet): %s", e)

    return True, "ok"


# ===== Background tasks =====
scheduler = AsyncIOScheduler()

# Per-job last-run + last-error tracking — surfaced in /api/health/deep so monitoring can
# detect silently-stuck scheduled jobs.
_job_runtime: dict[str, dict] = {}


def _tracked(job_id: str):
    """Decorator factory: wrap a scheduled job target so its last execution timestamp +
    last error (if any) are recorded for /api/health/deep visibility. HEALTH_DELTA is
    broadcast only when status flips (ok->error or error->ok) to avoid noise."""
    def deco(fn):
        def wrapper(*args, **kwargs):
            started = datetime.datetime.utcnow().isoformat()
            prev_status = _job_runtime.get(job_id, {}).get("last_status")
            try:
                result = fn(*args, **kwargs)
                _job_runtime[job_id] = {
                    "last_run": started,
                    "last_error": None,
                    "last_status": "ok",
                }
                if prev_status == "error":
                    try:
                        from app.core.events import broadcast_event
                        broadcast_event("HEALTH_DELTA", {"job_id": job_id, "last_status": "ok", "last_run": started})
                    except Exception:
                        pass
                return result
            except Exception as e:
                _job_runtime[job_id] = {
                    "last_run": started,
                    "last_error": str(e)[:300],
                    "last_status": "error",
                }
                if prev_status != "error":
                    try:
                        from app.core.events import broadcast_event
                        broadcast_event("HEALTH_DELTA", {"job_id": job_id, "last_status": "error", "last_error": str(e)[:300], "last_run": started})
                    except Exception:
                        pass
                raise
        wrapper.__name__ = fn.__name__
        return wrapper
    return deco


async def broadcast_tick_data():
    """Fire every 2s. Pushes prices + orders + account snapshot to all WS clients."""
    try:
        core_assets = get_core_assets()
        payload = {
            "type": "TICK_DATA",
            "prices": get_realtime_prices(core_assets),
            "orders": get_active_orders(),
            "account": get_account_status_full(),
            "auto_trade_enabled": get_setting("auto_trade_enabled", "true").lower() == "true",
        }
        await manager.broadcast(payload)
    except Exception as e:
        log.error("broadcast_tick_data failed: %s", e)


_uvicorn_loop = None

# Graceful shutdown flag — scheduled jobs check this and bail early to avoid leaving
# half-completed trade state. Set by lifespan exit BEFORE scheduler.shutdown(wait=True).
_shutting_down: bool = False


def is_shutting_down() -> bool:
    return _shutting_down


def background_quant_analysis():
    """Hourly cron. Run trade manager + per-symbol signal + auto-trade pending limit orders."""
    global _last_quant_scan_time
    if _shutting_down:
        log.info("quant_scan skipped — shutdown in progress")
        return
    _last_quant_scan_time = datetime.datetime.utcnow()
    try:
        # Trade manager — full 4-stage trailing state machine
        try:
            from app.services.trade_manager import manage_active_trades
            manage_active_trades()
        except Exception as e:
            log.error("trade_manager failed: %s", e)

        core_assets = get_core_assets()
        macro = get_morning_briefing()
        impacts = (
            macro.get("ai_briefing", {}).get("impacts", {})
            if isinstance(macro.get("ai_briefing"), dict) else {}
        )

        for sym in core_assets:
            try:
                result = determine_regime_and_signal(sym)
                if not result or "signal" not in result:
                    continue

                # Merge macro reason
                macro_info = impacts.get(sym)
                if isinstance(macro_info, dict):
                    result["reason_economic"] = macro_info.get("reasoning", "")
                    result["macro_trade_idea"] = macro_info.get("trade_idea", "")
                    result["macro_badge"] = macro_info.get("badge", "Neutral")
                else:
                    result["reason_economic"] = "No specific macro data."

                _last_quant_data[sym] = result
                signal = result["signal"]

                # Discord alert + auto-trade on new ENTRY signals
                notified_this_round = False
                if signal.startswith("ENTRY") and _last_notified_signal.get(sym) != signal:
                    notify_trade_signal(sym, result)
                    _last_notified_signal[sym] = signal
                    notified_this_round = True

                    allowed, reason = _safety_gates_pass(sym)
                    if not allowed:
                        log.info("Auto-trade skipped for %s: %s", sym, reason)
                        log_action("AutoTrader", "Skipped", f"{sym}: {reason}")
                    else:
                        trade_res = execute_trade(sym, result)
                        if trade_res.get("success"):
                            log_action(
                                "AutoTrader",
                                f"Executed {signal}",
                                f"{sym} ticket={trade_res['ticket']} lot={result.get('lot_size')}",
                            )
                            # Persist TradeState
                            db = SessionLocal()
                            try:
                                db.add(TradeState(
                                    ticket=trade_res["ticket"],
                                    symbol=sym,
                                    status="PENDING",
                                    order_type=signal,
                                    entry_price=result.get("entry"),
                                    sl=result.get("sl"),
                                    tp=result.get("tp"),
                                    volume=result.get("lot_size"),
                                    initial_volume=result.get("lot_size"),
                                    initial_sl_distance=abs(result.get("entry", 0) - result.get("sl", 0)),
                                    max_favorable=result.get("entry"),
                                    trail_stage=0,
                                    partial_closed=False,
                                    entry_atr=result.get("entry_atr", 0.0),
                                    trailing_active=False,
                                ))
                                db.commit()
                            except Exception as dbe:
                                log.error("TradeState persist failed: %s", dbe)
                                db.rollback()
                            finally:
                                db.close()
                        else:
                            log_action("AutoTrader", "Trade Failed", f"{sym}: {trade_res.get('error')}")
                            # Enqueue retry for transient failures (spread/ping/MT5 disconnect)
                            try:
                                from app.services.retry_worker import enqueue_retry
                                enqueue_retry(
                                    symbol=sym,
                                    signal_data=result,
                                    reason=trade_res.get("reason", "unknown"),
                                    error=trade_res.get("error", ""),
                                )
                            except Exception as re:
                                log.warning("enqueue_retry failed: %s", re)
                elif not signal.startswith("ENTRY"):
                    _last_notified_signal[sym] = None

                # Persist to signal_state DB (survives restart, multi-tab consistency)
                _persist_signal_state(sym, signal, result, notified=notified_this_round)

                if _uvicorn_loop:
                    asyncio.run_coroutine_threadsafe(
                        manager.broadcast({"type": "QUANT_UPDATE", "symbol": sym, "data": result}),
                        _uvicorn_loop
                    )

            except Exception as e:
                log.error("quant scan failed for %s: %s", sym, e)
    except Exception as e:
        log.error("background_quant_analysis failed at top level: %s", e)
        log_action("Scheduler", "Quant Cron Failed", str(e))


def schedule_d1_ingest():
    try:
        for sym in get_core_assets():
            ingest_timeframe(sym, "D1")
    except Exception as e:
        log.error("D1 ingest failed: %s", e)


def schedule_h4_ingest():
    try:
        for sym in get_core_assets():
            ingest_timeframe(sym, "H4")
    except Exception as e:
        log.error("H4 ingest failed: %s", e)


def schedule_h1_ingest():
    try:
        for sym in get_core_assets():
            ingest_timeframe(sym, "H1")
    except Exception as e:
        log.error("H1 ingest failed: %s", e)


def schedule_m1_ingest():
    try:
        for sym in get_core_assets():
            ingest_timeframe(sym, "M1")
    except Exception as e:
        log.error("M1 ingest failed: %s", e)


# ===== App lifecycle =====
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _uvicorn_loop
    _uvicorn_loop = asyncio.get_running_loop()
    log.info("Starting up — init_db + MT5 + scheduler")
    init_db()
    init_mt5()

    # Wire WS event broadcaster (used by service modules without circular import)
    from app.core.events import attach as attach_events
    attach_events(_uvicorn_loop, manager, is_shutting_down)

    # === Autonomous self-heal on startup ===

    # 1. Mark interrupted optimize jobs (running/queued at last shutdown -> interrupted)
    _db = SessionLocal()
    try:
        stale_jobs = _db.query(OptimizeJob).filter(OptimizeJob.status.in_(["queued", "running"])).all()
        for sj in stale_jobs:
            sj.status = "interrupted"
            sj.error = "Backend restart during execution"
            if not sj.completed_at:
                sj.completed_at = datetime.datetime.utcnow()
        if stale_jobs:
            _db.commit()
            log.info("Self-heal: marked %d interrupted optimize jobs", len(stale_jobs))
    except Exception as e:
        log.warning("Startup: mark interrupted jobs failed: %s", e)
    finally:
        _db.close()

    # 2. Reload signal_state into in-memory cache (gates Discord re-spam after restart)
    _load_signal_state_into_memory()

    # 3. Drop expired pending_actions (signal too stale to retry meaningfully)
    _db = SessionLocal()
    try:
        from app.core.database import PendingAction as _PA
        now = datetime.datetime.utcnow()
        expired = _db.query(_PA).filter(_PA.status == "pending", _PA.expires_at < now).all()
        for p in expired:
            p.status = "expired"
        if expired:
            _db.commit()
            log.info("Self-heal: expired %d stale pending_actions", len(expired))
    except Exception as e:
        log.warning("Startup: pending_actions expire failed: %s", e)
    finally:
        _db.close()

    # 4. Drop expired pending_actions older than 24h regardless of status (keeps DB lean)
    _db = SessionLocal()
    try:
        from app.core.database import PendingAction as _PA
        cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=7)
        old = _db.query(_PA).filter(_PA.created_at < cutoff).all()
        for p in old:
            _db.delete(p)
        if old:
            _db.commit()
            log.info("Self-heal: purged %d ancient pending_actions (>7 days)", len(old))
    except Exception as e:
        log.warning("Startup: ancient pending_actions purge failed: %s", e)
    finally:
        _db.close()

    from app.services.discord_notifier import notify_system_startup
    notify_system_startup()

    from app.services.trade_manager import sync_closed_positions
    scheduler.add_job(_tracked("sync_closed_positions")(sync_closed_positions), "interval", minutes=5, id="sync_closed_positions")

    scheduler.add_job(_tracked("tick_broadcast")(broadcast_tick_data), "interval", seconds=2, id="tick_broadcast")
    scheduler.add_job(_tracked("quant_scan")(background_quant_analysis), "cron", minute=0, second=5, id="quant_scan")
    scheduler.add_job(_tracked("ingest_d1")(schedule_d1_ingest), "cron", hour=0, minute=30, id="ingest_d1")
    scheduler.add_job(_tracked("ingest_h4")(schedule_h4_ingest), "cron", minute=15, hour="*/4", id="ingest_h4")
    scheduler.add_job(_tracked("ingest_h1")(schedule_h1_ingest), "cron", minute=2, id="ingest_h1")
    scheduler.add_job(
        _tracked("ingest_m1")(schedule_m1_ingest),
        "interval",
        minutes=1,
        id="ingest_m1",
        coalesce=True,
        max_instances=1,
        misfire_grace_time=30,
    )
    from app.services.equity_recorder import capture_snapshot
    scheduler.add_job(
        _tracked("equity_snapshot")(capture_snapshot),
        'cron',
        hour='0,4,8,12,16,20',
        minute=2,
        id='equity_snapshot',
        coalesce=True,
        misfire_grace_time=300,
    )

    # Retry queue drainer (pending_actions table) — runs every 1min, piggybacks ingest_m1 cadence
    from app.services.retry_worker import drain_pending_actions
    scheduler.add_job(
        _tracked("retry_worker")(lambda: drain_pending_actions(is_shutting_down)),
        "interval",
        minutes=1,
        id="retry_worker",
        coalesce=True,
        max_instances=1,
        misfire_grace_time=30,
    )

    # Auto-optimize monthly cron — 1st of month at 02:00 UTC+7 (= 19:00 UTC previous day)
    from app.services.auto_optimize import run_monthly_auto_optimize
    scheduler.add_job(
        _tracked("auto_optimize_monthly")(run_monthly_auto_optimize),
        "cron",
        day=1,
        hour=19,
        minute=0,
        id="auto_optimize_monthly",
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()

    # Pre-warm signal data + first H1/H4/D1 ingest via background threads so it doesn't block startup
    scheduler.add_job(background_quant_analysis, id="startup_quant")
    scheduler.add_job(schedule_d1_ingest, id="startup_d1")
    scheduler.add_job(schedule_h4_ingest, id="startup_h4")
    scheduler.add_job(schedule_h1_ingest, id="startup_h1")
    scheduler.add_job(schedule_m1_ingest, id="startup_m1")

    yield

    global _shutting_down
    log.info("Shutting down — graceful drain begin")
    _shutting_down = True
    # Wait briefly so in-flight scheduled jobs that just checked the flag can exit cleanly.
    # 3s covers fast paths (broadcast_tick, equity_snapshot). Long-running jobs (M1 ingest
    # during deep backfill) won't complete here — that's accepted; partial ingest is idempotent.
    try:
        await asyncio.sleep(3.0)
    except Exception:
        pass
    try:
        scheduler.shutdown(wait=True)
    except Exception as e:
        log.error("scheduler.shutdown failed: %s", e)
    shutdown_mt5()
    log.info("Shutdown complete")


async def _safe_call(coro_fn, label: str):
    try:
        await coro_fn()
    except Exception as e:
        log.error("%s failed: %s", label, e)
        log_action("Lifecycle", label, str(e))


app = FastAPI(title="AlgoTrade HedgeFund", version="2.0", lifespan=lifespan)

# Restricted CORS — local-only deployment per user requirement
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def pin_auth_middleware(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if path.startswith("/api") and not path.startswith("/api/auth/pin") and not path.startswith("/api/ws"):
        pin = request.headers.get("x-pin")
        correct_pin = get_setting("access_pin", "130944")
        if pin != correct_pin:
            log.warning(f"Auth failed. Received pin: {pin}, Expected: {correct_pin}, Path: {path}")
            return JSONResponse(status_code=401, content={"error": "Unauthorized. Invalid PIN."})
    return await call_next(request)

class PinRequest(BaseModel):
    pin: str


# PIN brute-force protection — track failed attempts per client IP with sliding window.
# Allows 5 failures per 60s window before blocking. Records cleared on successful login.
_pin_failures: dict[str, list[float]] = {}
_PIN_FAIL_LIMIT = 5
_PIN_FAIL_WINDOW_SECONDS = 60.0
_PIN_BLOCK_SECONDS = 300.0  # 5min block after limit hit


def _pin_attempt_allowed(client_ip: str) -> tuple[bool, str]:
    import time as _time
    now = _time.time()
    failures = _pin_failures.get(client_ip, [])
    # Drop entries outside the window
    failures = [t for t in failures if now - t < _PIN_FAIL_WINDOW_SECONDS]
    _pin_failures[client_ip] = failures
    if len(failures) >= _PIN_FAIL_LIMIT:
        # Block if the most recent failure is within the block window
        if failures and (now - failures[-1]) < _PIN_BLOCK_SECONDS:
            return False, f"rate_limited (until {int(_PIN_BLOCK_SECONDS - (now - failures[-1]))}s)"
        _pin_failures[client_ip] = []
    return True, "ok"


def _pin_record_failure(client_ip: str) -> None:
    import time as _time
    _pin_failures.setdefault(client_ip, []).append(_time.time())


def _pin_clear_failures(client_ip: str) -> None:
    _pin_failures.pop(client_ip, None)


@app.post("/api/auth/pin")
def verify_pin(payload: PinRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    allowed, reason = _pin_attempt_allowed(client_ip)
    if not allowed:
        log.warning(f"PIN attempt blocked: ip={client_ip} reason={reason}")
        return JSONResponse(status_code=429, content={"ok": False, "error": f"Too many failed attempts. {reason}"})
    correct_pin = get_setting("access_pin", "130944")
    if payload.pin == correct_pin:
        _pin_clear_failures(client_ip)
        return {"ok": True}
    _pin_record_failure(client_ip)
    return JSONResponse(status_code=401, content={"ok": False, "error": "Invalid PIN"})

app.include_router(ws_router, prefix="/api")


# ===== Schemas =====
class SettingUpdate(BaseModel):
    key: str
    value: str


class RecommendRequest(BaseModel):
    symbols: list[str]


class BacktestRequest(BaseModel):
    symbols: list[str]  # 1+ symbols. Use ["ALL"] to expand to all configured core_assets.
    start_date: str  # ISO YYYY-MM-DD
    end_date: str
    risk_percent: float = 1.0
    spread_pips: float = 2.0
    slippage_pips: float = 1.0
    starting_equity: float = 10000.0
    # Optional strategy overrides (omit to use DEFAULTS)
    sl_atr_mult: float | None = None
    tp_atr_mult: float | None = None
    rsi_entry_low: float | None = None
    rsi_entry_high: float | None = None
    sma_fast_period: int | None = None
    sma_slow_period: int | None = None
    vma_period: int | None = None


class OptimizeRequest(BaseModel):
    symbols: list[str]
    start_date: str
    end_date: str
    sweeps: dict[str, list]
    fixed: dict | None = None
    rank_by: str = "profit_factor"
    top_n: int = 20
    require_min_trades: int = 5
    parallel: bool = True
    max_workers: int | None = None  # default = 80% of logical CPUs, capped at 10
    walk_forward: bool = False       # split date range into train + test, validate OOS
    train_ratio: float = 0.67        # fraction of window used for training (0.4-0.9)

    def model_post_init(self, __context) -> None:
        """Reject TP sweeps. Run 2 (2026-05-24) proved TP is decorative — exits always
        fire via partial close or trail before TP binds. Sweeping it just wastes 4x compute.
        Pin TP via the `fixed` dict instead."""
        if isinstance(self.sweeps, dict) and "tp_atr_mult" in self.sweeps:
            raise ValueError(
                "tp_atr_mult sweep is rejected: TP is decorative in this strategy "
                "(Run 2 finding 2026-05-24 — trailing/partial-close always exits first). "
                "Pin TP via the `fixed` dict, e.g. fixed={'tp_atr_mult': 4.0}."
            )




@app.get("/api/health")
def health():
    return {
        "mt5": check_terminal_health(),
        "auto_trade_enabled": get_setting("auto_trade_enabled", "true").lower() == "true",
        "core_assets_count": len(get_core_assets()),
    }


@app.get("/api/health/deep")
def health_deep():
    """Comprehensive health probe for monitoring + dashboard. Aggregates Postgres, MT5,
    scheduler, last activity, DD status."""
    import time
    from sqlalchemy import text

    # Postgres ping
    pg_ok = False
    pg_latency = None
    try:
        t0 = time.time()
        db_ = SessionLocal()
        db_.execute(text("SELECT 1"))
        db_.close()
        pg_latency = round((time.time() - t0) * 1000, 1)
        pg_ok = True
    except Exception as e:
        log.warning("health_deep postgres ping failed: %s", e)

    mt5_health = check_terminal_health()

    # Scheduler jobs with last_run + last_error from _job_runtime
    jobs = []
    sched = globals().get("scheduler")
    if sched:
        try:
            for j in sched.get_jobs():
                runtime = _job_runtime.get(j.id, {})
                jobs.append({
                    "id": j.id,
                    "next_run": j.next_run_time.isoformat() if j.next_run_time else None,
                    "last_run": runtime.get("last_run"),
                    "last_status": runtime.get("last_status"),
                    "last_error": runtime.get("last_error"),
                })
        except Exception:
            pass

    # Today realized PnL
    realized = 0.0
    try:
        realized = _today_realized_pnl()
    except Exception:
        pass

    # DD calc
    dd_limit = float(get_setting("daily_dd_limit_pct", "5.0"))
    info = mt5.account_info()
    eq = info.equity if info else 10000.0
    dd_pct = (abs(realized) / eq * 100) if (realized < 0 and eq > 0) else 0.0
    dd_hit = dd_pct >= dd_limit

    # Last ingest per timeframe
    last_ingest = {}
    try:
        db_ = SessionLocal()
        try:
            for tf in ("D1", "H4", "H1"):
                row = db_.query(HistoricalData).filter(HistoricalData.timeframe == tf).order_by(HistoricalData.time.desc()).first()
                last_ingest[tf] = row.time.isoformat() if row else None
        finally:
            db_.close()
    except Exception:
        last_ingest = {"D1": None, "H4": None, "H1": None}

    return {
        "uvicorn_started_at": _backend_started_at,
        "postgres": {"ok": pg_ok, "latency_ms": pg_latency},
        "mt5": {
            "ok": mt5_health.get("connected", False) if isinstance(mt5_health, dict) else False,
            "trade_allowed": mt5_health.get("trade_allowed", False) if isinstance(mt5_health, dict) else False,
            "ping_ms": mt5_health.get("ping_ms") if isinstance(mt5_health, dict) else None,
        },
        "scheduler": {"jobs": jobs},
        "last_quant_scan": _last_quant_scan_time.isoformat() if _last_quant_scan_time else None,
        "last_ingest": last_ingest,
        "auto_trade_enabled": get_setting("auto_trade_enabled", "true").lower() == "true",
        "realized_pnl_today": round(realized, 2),
        "daily_dd_limit_pct": dd_limit,
        "daily_dd_limit_hit": dd_hit,
        "core_assets_count": len(get_core_assets()),
    }


@app.get("/api/equity/series")
def equity_series(range: str = "30d"):
    """Equity snapshots + summary stats for plotting. range: 7d / 30d / 90d / all."""
    db_ = SessionLocal()
    try:
        q = db_.query(EquitySnapshot).order_by(EquitySnapshot.recorded_at.asc())
        if range != "all":
            days = {"7d": 7, "30d": 30, "90d": 90}.get(range, 30)
            cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=days)
            q = q.filter(EquitySnapshot.recorded_at >= cutoff)
        rows = q.all()
        if not rows:
            return {"snapshots": [], "stats": None}
        equities = [r.equity for r in rows]
        start_eq = equities[0]
        current_eq = equities[-1]
        peak_eq = max(equities)
        running_max = start_eq
        max_dd = 0.0
        for e in equities:
            running_max = max(running_max, e)
            dd = (running_max - e) / running_max * 100 if running_max > 0 else 0
            max_dd = max(max_dd, dd)
        current_dd = (peak_eq - current_eq) / peak_eq * 100 if peak_eq > 0 else 0
        first_time = rows[0].recorded_at
        last_time = rows[-1].recorded_at
        days_tracked = (last_time - first_time).total_seconds() / 86400
        return {
            "snapshots": [
                {
                    "id": r.id,
                    "recorded_at": r.recorded_at.isoformat(),
                    "equity": r.equity,
                    "balance": r.balance,
                    "free_margin": r.free_margin,
                    "open_positions": r.open_positions,
                    "daily_pnl": r.daily_pnl,
                } for r in rows
            ],
            "stats": {
                "start_equity": start_eq,
                "current_equity": current_eq,
                "peak_equity": peak_eq,
                "total_return_pct": (current_eq - start_eq) / start_eq * 100 if start_eq > 0 else 0,
                "current_dd_pct": current_dd,
                "max_dd_pct": max_dd,
                "days_tracked": days_tracked,
            }
        }
    finally:
        db_.close()


@app.get("/api/journal")
def journal_list(days: int = 30, symbol: str | None = None, side: str | None = None):
    """Trade journal entries for filtering + plotting. Populated by trade lifecycle hooks."""
    db_ = SessionLocal()
    try:
        cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=days)
        q = db_.query(TradeJournalEntry).filter(TradeJournalEntry.opened_at >= cutoff)
        if symbol:
            q = q.filter(TradeJournalEntry.symbol.ilike(f"%{symbol}%"))
        if side:
            q = q.filter(TradeJournalEntry.side == side.upper())
        rows = q.order_by(TradeJournalEntry.opened_at.desc()).limit(2000).all()
        return {
            "rows": [
                {
                    "id": r.id,
                    "ticket": r.ticket,
                    "symbol": r.symbol,
                    "side": r.side,
                    "opened_at": r.opened_at.isoformat(),
                    "closed_at": r.closed_at.isoformat() if r.closed_at else None,
                    "entry_price": r.entry_price,
                    "exit_price": r.exit_price,
                    "sl": r.sl,
                    "tp": r.tp,
                    "lot": r.lot,
                    "exit_reason": r.exit_reason,
                    "r_multiple": r.r_multiple,
                    "pnl": r.pnl,
                    "slippage_entry": r.slippage_entry,
                    "slippage_exit": r.slippage_exit,
                    "signal_context": (json.loads(r.signal_context_json) if r.signal_context_json else None),
                } for r in rows
            ],
            "count": len(rows),
        }
    finally:
        db_.close()


# Edge vs Noise classification — decisive Phase 2 demo decision tool.
# Edge = strategy thesis worked: PARTIAL_TP + TRAIL_SL after stage 3+ + TP
# Noise = exit didn't pass through trailing logic: initial SL + early TRAIL_SL (stage 1 or 2)
_EDGE_REASONS = {"PARTIAL_TP", "TP", "Take Profit"}
_NOISE_REASONS = {"SL", "Stop Loss", "Manual Close"}


def _classify_attribution(exit_reason: str | None, r_multiple: float | None) -> str:
    """Bucket each trade into 'edge', 'noise', or 'mixed'.

    Edge = thesis trades (partial close hit OR full TP hit OR trail-out at >= 2R).
    Noise = stopped out before trail had time to advance (initial SL or low-R close).
    Mixed = late-stage trail exits (manual / unclear / system close)."""
    if exit_reason is None:
        return "open"
    er = (exit_reason or "").strip()
    if er in _EDGE_REASONS:
        return "edge"
    if er.startswith("TRAIL_SL") or er == "Trail SL":
        return "edge" if (r_multiple or 0) >= 1.5 else "noise"
    if er in _NOISE_REASONS:
        return "noise"
    return "mixed"


def _aggregate_bucket(trades: list) -> dict:
    if not trades:
        return {"count": 0, "win_rate": 0.0, "avg_r": 0.0, "total_pnl": 0.0, "profit_factor": 0.0}
    wins = [t for t in trades if (t.pnl or 0) > 0]
    losses = [t for t in trades if (t.pnl or 0) < 0]
    gross_profit = sum(t.pnl or 0 for t in wins)
    gross_loss = abs(sum(t.pnl or 0 for t in losses))
    pf = (gross_profit / gross_loss) if gross_loss > 0 else float("inf") if gross_profit > 0 else 0.0
    return {
        "count": len(trades),
        "win_rate": round(len(wins) / len(trades) * 100, 2),
        "avg_r": round(sum(t.r_multiple or 0 for t in trades) / len(trades), 3),
        "total_pnl": round(sum(t.pnl or 0 for t in trades), 2),
        "profit_factor": round(pf, 3) if pf != float("inf") else None,
    }


@app.get("/api/journal/attribution")
def journal_attribution(days: int = 30, symbol: str | None = None):
    """Edge vs Noise breakdown — decisive Phase 2 decision tool.

    Returns:
      - overall: aggregate metrics across all closed trades in window
      - edge: trades where strategy thesis worked (partial close, TP, stage 3+ trail)
      - noise: trades stopped out early (initial SL or sub-1.5R trail)
      - mixed: ambiguous (manual close, system exits)
      - by_exit_reason: distribution of exit reasons
      - r_distribution: histogram bins [-3, -2, -1, 0, 1, 2, 3, 4+]
      - by_symbol: per-symbol breakdown
    """
    db_ = SessionLocal()
    try:
        cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=days)
        q = db_.query(TradeJournalEntry).filter(
            TradeJournalEntry.opened_at >= cutoff,
            TradeJournalEntry.closed_at != None,  # noqa: E711  (closed trades only)
        )
        if symbol:
            q = q.filter(TradeJournalEntry.symbol.ilike(f"%{symbol}%"))
        trades = q.all()

        edge_trades = []
        noise_trades = []
        mixed_trades = []
        for t in trades:
            bucket = _classify_attribution(t.exit_reason, t.r_multiple)
            if bucket == "edge":
                edge_trades.append(t)
            elif bucket == "noise":
                noise_trades.append(t)
            elif bucket == "mixed":
                mixed_trades.append(t)

        # R-multiple distribution
        bins = {"<-2": 0, "-2 to -1": 0, "-1 to 0": 0, "0 to 1": 0, "1 to 1.5": 0, "1.5 to 2": 0, "2 to 3": 0, ">=3": 0}
        for t in trades:
            r = t.r_multiple or 0
            if r < -2: bins["<-2"] += 1
            elif r < -1: bins["-2 to -1"] += 1
            elif r < 0: bins["-1 to 0"] += 1
            elif r < 1: bins["0 to 1"] += 1
            elif r < 1.5: bins["1 to 1.5"] += 1
            elif r < 2: bins["1.5 to 2"] += 1
            elif r < 3: bins["2 to 3"] += 1
            else: bins[">=3"] += 1

        # By exit_reason
        by_reason: dict = {}
        for t in trades:
            r_key = t.exit_reason or "unknown"
            by_reason.setdefault(r_key, []).append(t)
        by_reason_out = {k: _aggregate_bucket(v) for k, v in by_reason.items()}

        # By symbol
        by_sym: dict = {}
        for t in trades:
            by_sym.setdefault(t.symbol, []).append(t)
        by_sym_out = {k: _aggregate_bucket(v) for k, v in by_sym.items()}

        return {
            "window_days": days,
            "overall": _aggregate_bucket(trades),
            "edge": _aggregate_bucket(edge_trades),
            "noise": _aggregate_bucket(noise_trades),
            "mixed": _aggregate_bucket(mixed_trades),
            "r_distribution": bins,
            "by_exit_reason": by_reason_out,
            "by_symbol": by_sym_out,
        }
    finally:
        db_.close()


# ===== Analysis =====
@app.get("/api/analysis/quant")
def get_quant_analysis():
    return _last_quant_data


@app.get("/api/analysis/technical")
def technical_full_rescan():
    """Full re-scan + Discord alert on new ENTRY signals. Heavy — use sparingly."""
    symbols = get_core_assets()
    results = analyze_all_assets(symbols)
    for sym, data in results.items():
        if not data or "signal" not in data:
            continue
        signal = data["signal"]
        if signal.startswith("ENTRY") and _last_notified_signal.get(sym) != signal:
            notify_trade_signal(sym, data)
            _last_notified_signal[sym] = signal
        elif not signal.startswith("ENTRY"):
            _last_notified_signal[sym] = None
    return {"technical_regimes": results}


@app.get("/api/analysis/technical/{symbol}")
def technical_single(symbol: str):
    return {"symbol": symbol, "data": determine_regime_and_signal(symbol)}


@app.get("/api/analysis/macro")
def macro_analysis():
    return get_morning_briefing()


@app.get("/api/analysis/risk")
def risk_analysis():
    return get_risk_assessment()


@app.get("/api/analysis/logs")
def logs_critique(db: Session = Depends(get_db)):
    """Send last 50 action logs to MiMo for critique."""
    rows = db.query(ActionLog).order_by(ActionLog.timestamp.desc()).limit(50).all()
    if not rows:
        return {"status": "No logs available"}
    log_text = "\n".join(f"[{r.timestamp}] {r.source}/{r.action}: {r.message}" for r in rows)

    api_key = os.getenv("MIMO_API_KEY")
    base_url = os.getenv("MIMO_BASE_URL", "https://token-plan-sgp.xiaomimimo.com/v1")
    if not api_key:
        return {"error": "MIMO_API_KEY not set"}

    try:
        r = requests.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": "mimo-v2.5-pro",
                "messages": [
                    {"role": "system", "content": "You are a senior quantitative developer."},
                    {"role": "user", "content": (
                        f"Analyze these recent trading system action logs and suggest improvements:\n\n{log_text}"
                    )},
                ],
            },
            timeout=60,
        )
        if r.status_code == 200:
            return {"ai_suggestions": r.json()["choices"][0]["message"]["content"]}
        return {"error": r.text}
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/analysis/recommend")
def recommend_assets(payload: RecommendRequest):
    """MiMo-powered asset selection — pre-filter by class then ask MiMo to pick the best 10-15."""
    api_key = os.getenv("MIMO_API_KEY")
    if not api_key:
        return {"error": "MIMO_API_KEY not set"}

    target_set = set(payload.symbols)
    target_symbols = [s for s in get_all_symbols() if s["name"] in target_set][:100]

    base_url = os.getenv("MIMO_BASE_URL", "https://token-plan-sgp.xiaomimimo.com/v1")
    prompt = (
        "You are an AI Trading Assistant. From these MT5 symbols, suggest 10-15 best assets "
        "for intraday/swing trading. Prefer high liquidity, low spread, and clear trends. "
        "Return ONLY a JSON array of symbol strings.\n\n"
        f"{json.dumps([{'name': s['name'], 'spread': s['spread']} for s in target_symbols])}"
    )
    try:
        r = requests.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": "mimo-v2.5",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
            },
            timeout=30,
        )
        if r.status_code == 200:
            content = r.json()["choices"][0]["message"]["content"]
            if "```" in content:
                content = content.replace("```json", "").replace("```", "").strip()
            return {"recommended_assets": json.loads(content)}
        return {"error": r.text}
    except Exception as e:
        return {"error": str(e)}


# ===== Market data =====
@app.get("/api/prices")
def prices():
    return {"prices": get_realtime_prices(get_core_assets())}


@app.get("/api/orders")
def orders():
    return {"active_orders": get_active_orders()}


@app.get("/api/account/status")
def account_status():
    return get_account_status_full()


@app.get("/api/mt5/symbols")
def mt5_symbols():
    return {"symbols": get_all_symbols()}


@app.get("/api/mt5/history/{symbol}")
def mt5_history(symbol: str, timeframe: str = "H1", count: int = 500):
    tf_map = {
        "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }
    tf = tf_map.get(timeframe, mt5.TIMEFRAME_H1)
    return {"symbol": symbol, "data": get_chart_data(symbol, tf, count)}


# ===== Historical backtest data layer (Phase 1B) =====
# IMPORTANT: specific paths must be declared BEFORE the {symbol} catch-all
@app.get("/api/historical/status")
def historical_status():
    return get_ingest_status()


@app.get("/api/historical/date-range")
def historical_date_range(symbols: str = "", db: Session = Depends(get_db)):
    """Return the date range available for each symbol AND the intersection across symbols.

    Args (query):
        symbols: comma-separated list. Empty or 'ALL' = all configured core_assets.

    The intersection is the most-recent of the per-symbol first-dates and the
    earliest of the per-symbol last-dates. Used by the frontend calendar to
    restrict selectable dates to ranges where all chosen symbols have data.
    """
    from sqlalchemy import func
    if not symbols or symbols == "ALL":
        sym_list = get_core_assets()
    else:
        sym_list = [s.strip() for s in symbols.split(",") if s.strip()]

    if not sym_list:
        return {"ok": False, "error": "no symbols"}

    rows = (
        db.query(
            HistoricalData.symbol,
            HistoricalData.timeframe,
            func.min(HistoricalData.time).label("first"),
            func.max(HistoricalData.time).label("last"),
            func.count(HistoricalData.id).label("count"),
        )
        .filter(HistoricalData.symbol.in_(sym_list))
        .group_by(HistoricalData.symbol, HistoricalData.timeframe)
        .all()
    )

    per_symbol: dict[str, dict] = {}
    for r in rows:
        slot = per_symbol.setdefault(r.symbol, {"timeframes": {}, "first": None, "last": None})
        slot["timeframes"][r.timeframe] = {
            "count": int(r.count),
            "first": r.first.isoformat() if r.first else None,
            "last": r.last.isoformat() if r.last else None,
        }

    # Per-symbol overall first/last across timeframes (need all of D1/H4/H1 for backtest)
    required_tfs = ["D1", "H4", "H1"]
    intersect_first = None
    intersect_last = None
    fully_ready: list[str] = []
    not_ready: list[dict] = []

    for sym in sym_list:
        if sym not in per_symbol:
            not_ready.append({"symbol": sym, "reason": "no data at all"})
            continue
        tfs = per_symbol[sym]["timeframes"]
        missing = [tf for tf in required_tfs if tf not in tfs]
        if missing:
            not_ready.append({"symbol": sym, "reason": f"missing timeframes: {missing}"})
            continue
        # Per-symbol effective range = latest first across tfs, earliest last across tfs
        symbol_first = max(
            datetime.datetime.fromisoformat(tfs[tf]["first"]) for tf in required_tfs
        )
        symbol_last = min(
            datetime.datetime.fromisoformat(tfs[tf]["last"]) for tf in required_tfs
        )
        per_symbol[sym]["first"] = symbol_first.isoformat()
        per_symbol[sym]["last"] = symbol_last.isoformat()
        fully_ready.append(sym)
        if intersect_first is None or symbol_first > intersect_first:
            intersect_first = symbol_first
        if intersect_last is None or symbol_last < intersect_last:
            intersect_last = symbol_last

    return {
        "ok": True,
        "requested": sym_list,
        "fully_ready": fully_ready,
        "not_ready": not_ready,
        "intersection": {
            "first": intersect_first.isoformat() if intersect_first else None,
            "last": intersect_last.isoformat() if intersect_last else None,
            "days_available": (intersect_last - intersect_first).days if intersect_first and intersect_last else 0,
        },
        "per_symbol": per_symbol,
    }


@app.post("/api/historical/ingest-now")
def historical_ingest_now():
    """Incremental ingest — pull only new candles since last stored timestamp."""
    summary = ingest_all_configured(get_core_assets())
    return summary


@app.post("/api/historical/deep-backfill")
async def historical_deep_backfill():
    """Force-fetch the full INITIAL_BACKFILL window (5000 candles per TF) regardless of existing rows.

    Use this AFTER raising INITIAL_BACKFILL to deepen history. Runs in a thread so it doesn't
    block the event loop — large symbol universes take 30-90s.
    """
    return await asyncio.to_thread(deep_backfill_all, get_core_assets())


@app.get("/api/historical/{symbol}")
def historical_data(symbol: str, timeframe: str = "H1", limit: int = 100, db: Session = Depends(get_db)):
    """Read OHLC from Postgres (backtest data store), NOT directly from MT5."""
    q = (
        db.query(HistoricalData)
        .filter(HistoricalData.symbol == symbol, HistoricalData.timeframe == timeframe)
        .order_by(HistoricalData.time.desc())
        .limit(limit)
    )
    rows = q.all()
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(rows),
        "data": [
            {
                "time": r.time.isoformat(),
                "open": r.open_price,
                "high": r.high_price,
                "low": r.low_price,
                "close": r.close_price,
                "volume": r.tick_volume,
            }
            for r in reversed(rows)
        ],
    }


# ===== Backtest engine =====
@app.get("/api/backtest/defaults")
def backtest_defaults():
    """Return the strategy default parameters used by the backtest engine.
    Useful for pre-filling the optimize UI with sensible centers.
    """
    return {"defaults": BT_DEFAULTS}


@app.post("/api/backtest")
async def backtest(req: BacktestRequest):
    """Multi-symbol backtest. Runs in a thread when >5 symbols to keep the event loop responsive."""
    symbols = req.symbols
    if symbols == ["ALL"] or "ALL" in symbols:
        symbols = get_core_assets()
    if not symbols:
        return {"ok": False, "error": "symbols list is empty"}

    overrides = {
        k: getattr(req, k)
        for k in (
            "sl_atr_mult", "tp_atr_mult", "rsi_entry_low", "rsi_entry_high",
            "sma_fast_period", "sma_slow_period", "vma_period",
        )
        if getattr(req, k) is not None
    }

    if len(symbols) == 1:
        # Single-symbol path keeps the rich equity curve + trade detail
        result = await asyncio.to_thread(
            run_backtest,
            symbols[0],
            req.start_date,
            req.end_date,
            req.risk_percent,
            req.spread_pips,
            req.slippage_pips,
            req.starting_equity,
            **overrides,
        )
        # Wrap in multi shape for frontend uniformity
        if result.get("ok"):
            return {
                "ok": True,
                "mode": "single",
                "symbols_requested": symbols,
                "successful": [result["symbol"]],
                "failed": [],
                "aggregate": result["stats"],
                "per_symbol": [{"symbol": result["symbol"], "ok": True, "stats": result["stats"], "trade_count": result["stats"]["trade_count"]}],
                "all_trades": [{**t, "symbol": result["symbol"]} for t in result["trades"]],
                "equity_curve": result["equity_curve"],
                "config": result["config"],
                "candles_processed": result.get("candles_processed", 0),
            }
        return result

    # Multi-symbol — run off the event loop
    multi = await asyncio.to_thread(
        run_backtest_multi,
        symbols,
        start_date=req.start_date,
        end_date=req.end_date,
        risk_percent=req.risk_percent,
        spread_pips=req.spread_pips,
        slippage_pips=req.slippage_pips,
        starting_equity=req.starting_equity,
        **overrides,
    )
    multi["mode"] = "multi"
    return multi


@app.post("/api/backtest/optimize")
async def backtest_optimize(req: OptimizeRequest):
    """Long-running grid search — returns a job_id immediately. Poll /api/jobs/{job_id} for status + result.

    Job state persists to optimize_jobs DB table: survives backend restart, closing browser tab
    doesn't lose progress, and the run is part of permanent history. Old _jobs in-memory dict
    decommissioned in favor of DB-first.
    """
    symbols = req.symbols
    if symbols == ["ALL"] or "ALL" in symbols:
        symbols = get_core_assets()
    if not symbols:
        return {"ok": False, "error": "symbols list is empty"}

    job_id = str(uuid.uuid4())
    request_payload = {
        "symbols": symbols,
        "start_date": req.start_date,
        "end_date": req.end_date,
        "sweeps": req.sweeps,
        "fixed": req.fixed,
        "rank_by": req.rank_by,
        "top_n": req.top_n,
        "walk_forward": req.walk_forward,
        "train_ratio": req.train_ratio,
        "parallel": req.parallel,
    }
    db = SessionLocal()
    try:
        db.add(OptimizeJob(
            id=job_id,
            status="queued",
            progress_current=0,
            progress_total=0,
            request_json=json.dumps(request_payload),
            triggered_by="user_ui",
        ))
        db.commit()
    finally:
        db.close()

    async def _run_job():
        # Mark running
        db = SessionLocal()
        try:
            row = db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
            if row:
                row.status = "running"
                row.started_at = datetime.datetime.utcnow()
                db.commit()
        finally:
            db.close()

        # Throttle DB writes: progress callback fires per combo, can be 100s of times.
        # Update DB max once per 500ms; broadcast WS more often (lighter).
        last_db_write = [0.0]

        def progress_cb(combos_done: int, combos_total: int, runs_done: int, runs_total: int):
            import time
            now = time.time()
            payload = {
                "job_id": job_id,
                "combos_done": combos_done,
                "combos_total": combos_total,
                "runs_done": runs_done,
                "runs_total": runs_total,
                "pct": round((runs_done / runs_total) * 100, 1) if runs_total else 0,
            }
            try:
                from app.core.events import broadcast_event
                broadcast_event("OPTIMIZE_PROGRESS", payload)
            except Exception:
                pass
            # Throttled DB write
            if now - last_db_write[0] >= 0.5:
                last_db_write[0] = now
                _db = SessionLocal()
                try:
                    row = _db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
                    if row:
                        row.progress_current = runs_done
                        row.progress_total = runs_total
                        _db.commit()
                finally:
                    _db.close()

        try:
            start_ts = datetime.datetime.utcnow()
            result = await asyncio.to_thread(
                run_optimization,
                symbols=symbols,
                start_date=req.start_date,
                end_date=req.end_date,
                sweeps=req.sweeps,
                fixed=req.fixed or {},
                rank_by=req.rank_by,
                top_n=req.top_n,
                require_min_trades=req.require_min_trades,
                progress_callback=progress_cb,
                parallel=req.parallel,
                max_workers=req.max_workers,
                walk_forward=req.walk_forward,
                train_ratio=req.train_ratio,
            )
            db = SessionLocal()
            try:
                row = db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
                if row:
                    row.status = "done"
                    row.result_json = json.dumps(result, default=str)
                    row.completed_at = datetime.datetime.utcnow()
                    row.duration_seconds = (row.completed_at - start_ts).total_seconds()
                    db.commit()
            finally:
                db.close()
            try:
                from app.core.events import broadcast_event
                broadcast_event("OPTIMIZE_DONE", {"job_id": job_id, "status": "done"})
            except Exception:
                pass
        except Exception as e:
            log.error("Optimize job %s failed: %s", job_id, e)
            db = SessionLocal()
            try:
                row = db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
                if row:
                    row.status = "failed"
                    row.error = str(e)[:1000]
                    row.completed_at = datetime.datetime.utcnow()
                    db.commit()
            finally:
                db.close()
            try:
                from app.core.events import broadcast_event
                broadcast_event("OPTIMIZE_DONE", {"job_id": job_id, "status": "failed", "error": str(e)[:200]})
            except Exception:
                pass

    asyncio.create_task(_run_job())
    return {"ok": True, "job_id": job_id, "status": "queued"}


def _serialize_optimize_job(row: OptimizeJob, include_result: bool = True) -> dict:
    return {
        "id": row.id,
        "kind": "optimize",
        "status": row.status,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "finished_at": row.completed_at.isoformat() if row.completed_at else None,
        "duration_seconds": row.duration_seconds,
        "progress": {
            "runs_done": row.progress_current,
            "runs_total": row.progress_total,
            "pct": round((row.progress_current / row.progress_total) * 100, 1) if row.progress_total else 0,
        },
        "config": json.loads(row.request_json) if row.request_json else None,
        "result": (json.loads(row.result_json) if (row.result_json and include_result) else None),
        "has_result": bool(row.result_json),
        "error": row.error,
        "triggered_by": row.triggered_by,
    }


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    db = SessionLocal()
    try:
        row = db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
        if not row:
            return {"ok": False, "error": "job not found", "status": "not_found"}
        return _serialize_optimize_job(row, include_result=True)
    finally:
        db.close()


@app.get("/api/jobs")
def list_jobs(limit: int = 20, status: str | None = None):
    db = SessionLocal()
    try:
        q = db.query(OptimizeJob)
        if status:
            q = q.filter(OptimizeJob.status == status)
        rows = q.order_by(OptimizeJob.created_at.desc()).limit(limit).all()
        return {"jobs": [_serialize_optimize_job(r, include_result=False) for r in rows]}
    finally:
        db.close()


@app.get("/api/system/watchdog")
def system_watchdog():
    """External watchdog endpoint. Returns 200 OK only if ALL critical autonomous loops
    have run within their expected cadence (auto-restart scripts can hit this and trigger
    NSSM/cron to restart on persistent failure)."""
    now = datetime.datetime.utcnow()
    failures = []

    # tick_broadcast should fire every 2s → last_run within 30s
    tick_runtime = _job_runtime.get("tick_broadcast", {})
    if tick_runtime.get("last_run"):
        try:
            last = datetime.datetime.fromisoformat(tick_runtime["last_run"])
            if (now - last).total_seconds() > 30:
                failures.append(f"tick_broadcast stale: {(now - last).total_seconds():.0f}s")
        except Exception:
            failures.append("tick_broadcast last_run unparseable")
    else:
        failures.append("tick_broadcast never ran")

    # MT5 must be connected + trade_allowed
    mt5_h = check_terminal_health()
    if not mt5_h.get("connected"):
        failures.append("MT5 disconnected")
    if not mt5_h.get("trade_allowed"):
        failures.append("MT5 trade_allowed=false")

    # Scheduler must be alive
    if not scheduler.running:
        failures.append("scheduler not running")

    if failures:
        return JSONResponse(status_code=503, content={"ok": False, "failures": failures})
    return {"ok": True, "checked_at": now.isoformat()}


@app.post("/api/optimize/auto-refresh")
async def trigger_auto_optimize():
    """Manual trigger for the monthly auto-optimize pipeline. Returns immediately;
    progress + result via WS OPTIMIZE_DONE event + /api/jobs/{id}."""
    from app.services.auto_optimize import run_monthly_auto_optimize
    async def _run():
        await asyncio.to_thread(run_monthly_auto_optimize)
    asyncio.create_task(_run())
    return {"ok": True, "status": "triggered", "note": "Watch WS OPTIMIZE_DONE event or /api/jobs?triggered_by=auto_cron"}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    db = SessionLocal()
    try:
        row = db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
        if not row:
            return {"ok": False, "error": "not found"}
        db.delete(row)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


# ===== Settings + kill switch =====
@app.get("/api/config/assets")
def get_assets():
    return {"assets": get_core_assets()}


@app.get("/api/settings")
def settings_all(db: Session = Depends(get_db)):
    return {r.key: r.value for r in db.query(SystemSettings).all()}


@app.post("/api/settings")
async def settings_update(payload: SettingUpdate, db: Session = Depends(get_db)):
    row = db.query(SystemSettings).filter(SystemSettings.key == payload.key).first()
    if row:
        row.value = payload.value
    else:
        db.add(SystemSettings(key=payload.key, value=payload.value))
    db.commit()
    log_action("System", "Settings Update", f"{payload.key}={payload.value}")

    # Invalidate caches that depend on settings
    invalidate_settings_cache()
    if payload.key == "core_assets":
        invalidate_briefing_cache()
        invalidate_risk_cache()
        if scheduler.running:
            asyncio.create_task(_safe_call(background_quant_analysis, "settings_re_analysis"))

    # Broadcast to all WS clients so other tabs reflect the change
    try:
        from app.core.events import broadcast_event
        broadcast_event("SETTING_CHANGED", {"key": payload.key, "value": payload.value})
    except Exception:
        pass

    return {"status": "success", "key": payload.key, "value": payload.value}


@app.post("/api/settings/reset-assets")
def settings_reset_assets():
    """Restore core_assets to G1_ASSETS. Explicit user action only."""
    reset_core_assets_to_defaults()
    invalidate_settings_cache()
    invalidate_briefing_cache()
    invalidate_risk_cache()
    log_action("System", "Reset Assets", "core_assets reset to defaults")
    return {"status": "success", "assets": G1_ASSETS}


@app.post("/api/kill-switch")
async def kill_switch(db: Session = Depends(get_db)):
    """Emergency stop — set auto_trade_enabled = false. Frontend's red header button calls this."""
    row = db.query(SystemSettings).filter(SystemSettings.key == "auto_trade_enabled").first()
    if row:
        row.value = "false"
    else:
        db.add(SystemSettings(key="auto_trade_enabled", value="false"))
    db.commit()
    invalidate_settings_cache()
    log_action("System", "KILL SWITCH", "Auto-trade disabled via emergency button")
    notify_safety_event("Kill Switch Activated", "Auto-trade disabled by user")
    return {"status": "success", "auto_trade_enabled": False}


@app.post("/api/kill-switch/restore")
async def kill_switch_restore(db: Session = Depends(get_db)):
    """Re-enable auto-trade after manual stop."""
    row = db.query(SystemSettings).filter(SystemSettings.key == "auto_trade_enabled").first()
    if row:
        row.value = "true"
    else:
        db.add(SystemSettings(key="auto_trade_enabled", value="true"))
    db.commit()
    invalidate_settings_cache()
    log_action("System", "Restore Auto-Trade", "Auto-trade re-enabled by user")
    return {"status": "success", "auto_trade_enabled": True}


# ===== Reflection (manual trigger from frontend) =====
@app.post("/api/reflection/run-daily")
def reflection_run():
    return run_daily_reflection()


# ===== Logs read =====
@app.get("/api/logs/recent")
def logs_recent(limit: int = 50, db: Session = Depends(get_db)):
    rows = (
        db.query(ActionLog)
        .order_by(ActionLog.timestamp.desc())
        .limit(min(limit, 500))
        .all()
    )
    return {
        "logs": [
            {
                "timestamp": r.timestamp.isoformat(),
                "source": r.source,
                "action": r.action,
                "message": r.message,
            }
            for r in rows
        ]
    }


@app.get("/api/logs/range")
def logs_range(start: str, end: str, limit: int = 5000, db: Session = Depends(get_db)):
    """Return ActionLog entries between start (ISO) and end (ISO). Used by 'Copy Report'."""
    try:
        s = datetime.datetime.fromisoformat(start)
        e = datetime.datetime.fromisoformat(end)
    except ValueError as ex:
        return {"ok": False, "error": f"invalid date: {ex}"}
    rows = (
        db.query(ActionLog)
        .filter(ActionLog.timestamp >= s, ActionLog.timestamp <= e)
        .order_by(ActionLog.timestamp.asc())
        .limit(min(limit, 10000))
        .all()
    )
    return {
        "ok": True,
        "start": start,
        "end": end,
        "count": len(rows),
        "logs": [
            {
                "timestamp": r.timestamp.isoformat(),
                "source": r.source,
                "action": r.action,
                "message": r.message,
            }
            for r in rows
        ],
    }


@app.get("/api/equity/series")
def equity_series(range: str = "30d"):
    """Return equity snapshots + summary stats for the requested range."""
    db = SessionLocal()
    try:
        q = db.query(EquitySnapshot).order_by(EquitySnapshot.recorded_at.asc())
        if range != "all":
            days = {"7d": 7, "30d": 30, "90d": 90}.get(range, 30)
            cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
            q = q.filter(EquitySnapshot.recorded_at >= cutoff)
        rows = q.all()
        if not rows:
            return {"snapshots": [], "stats": None}
        equities = [r.equity for r in rows]
        start_eq = equities[0]
        current_eq = equities[-1]
        peak_eq = max(equities)
        # Running max for DD
        running_max = start_eq
        max_dd = 0.0
        for e in equities:
            running_max = max(running_max, e)
            dd = (running_max - e) / running_max * 100 if running_max > 0 else 0
            max_dd = max(max_dd, dd)
        current_dd = (peak_eq - current_eq) / peak_eq * 100 if peak_eq > 0 else 0
        first_time = rows[0].recorded_at
        last_time = rows[-1].recorded_at
        days_tracked = (last_time - first_time).total_seconds() / 86400
        return {
            "snapshots": [
                {
                    "id": r.id,
                    "recorded_at": r.recorded_at.isoformat(),
                    "equity": r.equity,
                    "balance": r.balance,
                    "free_margin": r.free_margin,
                    "open_positions": r.open_positions,
                    "daily_pnl": r.daily_pnl,
                } for r in rows
            ],
            "stats": {
                "start_equity": start_eq,
                "current_equity": current_eq,
                "peak_equity": peak_eq,
                "total_return_pct": (current_eq - start_eq) / start_eq * 100 if start_eq > 0 else 0,
                "current_dd_pct": current_dd,
                "max_dd_pct": max_dd,
                "days_tracked": days_tracked,
            }
        }
    finally:
        db.close()


@app.get("/api/journal")
def journal_list(days: int = 30, symbol: str | None = None, side: str | None = None):
    db = SessionLocal()
    try:
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
        q = db.query(TradeJournalEntry).filter(TradeJournalEntry.opened_at >= cutoff)
        if symbol:
            q = q.filter(TradeJournalEntry.symbol.ilike(f"%{symbol}%"))
        if side:
            q = q.filter(TradeJournalEntry.side == side)
        rows = q.order_by(TradeJournalEntry.opened_at.desc()).limit(2000).all()
        return {
            "rows": [
                {
                    "id": r.id,
                    "ticket": r.ticket,
                    "symbol": r.symbol,
                    "side": r.side,
                    "opened_at": r.opened_at.isoformat(),
                    "closed_at": r.closed_at.isoformat() if r.closed_at else None,
                    "entry_price": r.entry_price,
                    "exit_price": r.exit_price,
                    "sl": r.sl,
                    "tp": r.tp,
                    "lot": r.lot,
                    "exit_reason": r.exit_reason,
                    "r_multiple": r.r_multiple,
                    "pnl": r.pnl,
                    "slippage_entry": r.slippage_entry,
                    "slippage_exit": r.slippage_exit,
                    "signal_context": json.loads(r.signal_context_json) if r.signal_context_json else None,
                } for r in rows
            ],
            "count": len(rows),
        }
    finally:
        db.close()


@app.get("/api/health/deep")
def health_deep():
    """Aggregate health check for monitoring + SystemHealth dashboard."""
    import time
    from sqlalchemy import text
    started_at = _backend_started_at if "_backend_started_at" in globals() else datetime.datetime.utcnow().isoformat()

    # Postgres ping
    pg_ok = False
    pg_latency = None
    try:
        t0 = time.time()
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
        pg_latency = (time.time() - t0) * 1000
        pg_ok = True
    except Exception:
        pass

    # MT5 ping
    mt5_health = check_terminal_health()  # already exists

    # Scheduler jobs
    jobs = []
    if scheduler:
        for j in scheduler.get_jobs():
            jobs.append({
                "id": j.id,
                "next_run": j.next_run_time.isoformat() if j.next_run_time else None,
                "last_run": None,  # APScheduler doesn't expose this directly; track via events if needed
            })

    # Today realized PnL (uses the bug-fixed version)
    realized = _today_realized_pnl()

    # DD limit check
    dd_limit = float(get_setting("daily_dd_limit_pct", "5.0"))
    info = mt5.account_info()
    eq = info.get("equity", 10000) if info else 10000
    dd_pct = abs(realized) / eq * 100 if realized < 0 and eq > 0 else 0
    dd_hit = dd_pct >= dd_limit

    # Last historical ingest per timeframe
    last_ingest = {}
    db = SessionLocal()
    try:
        for tf in ("D1", "H4", "H1"):
            row = db.query(HistoricalData).filter(HistoricalData.timeframe == tf).order_by(HistoricalData.time.desc()).first()
            last_ingest[tf] = row.time.isoformat() if row else None
    finally:
        db.close()

    return {
        "uvicorn_started_at": started_at,
        "postgres": {"ok": pg_ok, "latency_ms": pg_latency},
        "mt5": {
            "ok": mt5_health.get("ok", False) if isinstance(mt5_health, dict) else False,
            "trade_allowed": mt5_health.get("trade_allowed", False) if isinstance(mt5_health, dict) else False,
            "ping_ms": mt5_health.get("ping_ms") if isinstance(mt5_health, dict) else None,
        },
        "scheduler": {"jobs": jobs},
        "last_quant_scan": _last_quant_scan_time.isoformat() if "_last_quant_scan_time" in globals() and _last_quant_scan_time else None,
        "last_ingest": last_ingest,
        "auto_trade_enabled": get_setting("auto_trade_enabled", "true").lower() == "true",
        "realized_pnl_today": round(realized, 2),
        "daily_dd_limit_pct": dd_limit,
        "daily_dd_limit_hit": dd_hit,
        "core_assets_count": len(get_core_assets()),
    }


# ===== Serve React Frontend =====
dist_path = os.path.join(os.path.dirname(__file__), "../../frontend/dist")
if os.path.isdir(dist_path):
    app.mount("/assets", StaticFiles(directory=os.path.join(dist_path, "assets")), name="assets")
    
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        path = os.path.join(dist_path, full_path)
        if os.path.isfile(path):
            return FileResponse(path)
        return FileResponse(os.path.join(dist_path, "index.html"))
