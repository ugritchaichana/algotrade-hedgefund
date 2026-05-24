# Backend Changes — Ready to Apply After Run 4

Status: **DRAFT CODE — APPLY AFTER RUN 4 + BOOTH APPROVES**

Three backend additions to support the new frontend pages (Equity Curve, Trade Journal, System Health):

1. New `equity_snapshots` table + scheduled snapshot job + `/api/equity/series` endpoint
2. New `trade_journal` table + write hooks in execution_desk + trade_manager + `/api/journal` endpoint
3. New `/api/health/deep` endpoint (read-only aggregation, no schema change)

All three are ADDITIVE — no breaking changes to existing flows. Safe to apply after Run 4 finishes.

---

## 1. equity_snapshots — daily account capture

### Schema addition in `backend/app/core/database.py`

```python
class EquitySnapshot(Base):
    __tablename__ = "equity_snapshots"
    id = Column(Integer, primary_key=True, index=True)
    recorded_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    equity = Column(Float, nullable=False)
    balance = Column(Float, nullable=False)
    free_margin = Column(Float, nullable=False)
    margin_level = Column(Float, default=0.0)
    open_positions = Column(Integer, default=0)
    daily_pnl = Column(Float, default=0.0)  # realized PnL since 00:00 UTC
    floating_pnl = Column(Float, default=0.0)  # unrealized PnL at snapshot time
```

`_migrate_schema_if_needed` will create the table on next backend restart.

### New service module: `backend/app/services/equity_recorder.py`

```python
"""Equity recorder — captures MT5 account snapshot to Postgres on schedule."""

import datetime
import logging
import MetaTrader5 as mt5
from app.core.database import SessionLocal, EquitySnapshot

log = logging.getLogger(__name__)


def capture_snapshot() -> bool:
    """Single-shot equity capture. Called by scheduler."""
    info = mt5.account_info()
    if info is None:
        log.warning("equity_recorder: mt5.account_info() returned None — skipping")
        return False

    # Today's realized PnL from closed deals since 00:00 UTC
    today = datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(today, datetime.datetime.now(datetime.timezone.utc))
    daily_pnl = 0.0
    if deals:
        daily_pnl = sum(d.profit + d.commission + d.swap for d in deals if d.entry == mt5.DEAL_ENTRY_OUT)

    positions = mt5.positions_get() or []
    floating = sum(p.profit for p in positions)

    db = SessionLocal()
    try:
        snap = EquitySnapshot(
            equity=info.equity,
            balance=info.balance,
            free_margin=info.margin_free,
            margin_level=info.margin_level,
            open_positions=len(positions),
            daily_pnl=round(daily_pnl, 2),
            floating_pnl=round(floating, 2),
        )
        db.add(snap)
        db.commit()
        log.info("equity_snapshot: equity=%.2f balance=%.2f open=%d daily_pnl=%.2f",
                 info.equity, info.balance, len(positions), daily_pnl)
        return True
    finally:
        db.close()
```

### Schedule it in `main.py:lifespan` startup

```python
# Around where other scheduled jobs are added
from app.services.equity_recorder import capture_snapshot

scheduler.add_job(
    capture_snapshot,
    'cron',
    hour='0,4,8,12,16,20',  # 6 snapshots per day, every 4 hours
    minute=2,                # 2 min past the hour to avoid race with other jobs
    id='equity_snapshot',
    coalesce=True,
    misfire_grace_time=300,
)
```

### Endpoint: `GET /api/equity/series?range=7d|30d|90d|all`

```python
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
```

---

## 2. trade_journal — durable trade history

### Schema addition

```python
class TradeJournalEntry(Base):
    __tablename__ = "trade_journal"
    id = Column(Integer, primary_key=True, index=True)
    ticket = Column(Integer, unique=True, index=True)
    symbol = Column(String(20), index=True)
    side = Column(String(8))  # BUY / SELL
    opened_at = Column(DateTime, index=True)
    closed_at = Column(DateTime, nullable=True, index=True)
    entry_price = Column(Float)
    exit_price = Column(Float, nullable=True)
    sl = Column(Float)
    tp = Column(Float)
    lot = Column(Float)
    exit_reason = Column(String(30), nullable=True)  # PARTIAL_CLOSE, TRAIL_SL, TP, SL, MANUAL_CLOSE, etc.
    r_multiple = Column(Float, nullable=True)
    pnl = Column(Float, nullable=True)
    slippage_entry = Column(Float, nullable=True)  # in pips
    slippage_exit = Column(Float, nullable=True)
    signal_context_json = Column(Text, nullable=True)  # JSON: D1/H4/H1 trend + RSI + volume + ATR at entry
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
```

### Write hooks

In `execution_desk.execute_trade` after successful order_send:
```python
from app.core.database import TradeJournalEntry
import json

journal = TradeJournalEntry(
    ticket=result.order,  # pending order ticket initially
    symbol=symbol,
    side="BUY" if "BUY" in signal_type else "SELL",
    opened_at=datetime.datetime.utcnow(),
    entry_price=float(entry),
    exit_price=None,
    sl=float(sl),
    tp=float(tp),
    lot=float(lot),
    exit_reason=None,
    r_multiple=None,
    pnl=None,
    slippage_entry=None,  # filled when order fills (separate handler)
    signal_context_json=json.dumps({
        "d1_trend": signal_data.get("d1_trend"),
        "h4_trend": signal_data.get("h4_trend"),
        "h1_rsi": signal_data.get("h1_rsi"),
        "h1_volume": signal_data.get("h1_volume"),
        "h1_vma": signal_data.get("h1_vma"),
        "atr": signal_data.get("entry_atr"),
    }),
)
db.add(journal)
db.commit()
```

In `trade_manager._manage_one` when position closes (or on partial close):
```python
def _close_journal_entry(db, ticket, exit_price, exit_reason, r_multiple, pnl, slippage_exit):
    entry = db.query(TradeJournalEntry).filter(TradeJournalEntry.ticket == ticket).first()
    if entry:
        entry.closed_at = datetime.datetime.utcnow()
        entry.exit_price = float(exit_price)
        entry.exit_reason = exit_reason
        entry.r_multiple = round(r_multiple, 3)
        entry.pnl = round(pnl, 2)
        entry.slippage_exit = round(slippage_exit, 2) if slippage_exit else None
        db.commit()
```

### Endpoint

```python
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
```

---

## 3. /api/health/deep — comprehensive health probe

```python
@app.get("/api/health/deep")
def health_deep():
    """Aggregate health check for monitoring + SystemHealth dashboard."""
    import time
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
    eq = info.equity if info else 10000
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
            "ok": mt5_health.get("ok", False),
            "trade_allowed": mt5_health.get("trade_allowed", False),
            "ping_ms": mt5_health.get("ping_ms"),
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
```

Add at top of main.py:
```python
_backend_started_at = datetime.datetime.utcnow().isoformat()
_last_quant_scan_time = None  # update in background_quant_analysis
```

---

## Migration checklist

- [ ] Apply schema changes to `backend/app/core/database.py` (3 new tables: EquitySnapshot, TradeJournalEntry; also add new columns to TradeState per docs/04)
- [ ] Create `backend/app/services/equity_recorder.py`
- [ ] Add equity_snapshot scheduled job in `main.py:lifespan`
- [ ] Add `/api/equity/series` endpoint
- [ ] Add `/api/journal` endpoint
- [ ] Add `/api/health/deep` endpoint
- [ ] Add `_backend_started_at` + `_last_quant_scan_time` globals at top of main.py
- [ ] Update `execution_desk.execute_trade` to write journal entry on success
- [ ] Update `trade_manager` to update journal on close (deferred to Phase 4 work)
- [ ] Restart backend (will run _migrate_schema_if_needed and create new tables)
- [ ] Verify in browser: visit /equity, /journal, /system/health pages — should populate

---

## Risk + rollback

| Risk | Mitigation |
|---|---|
| _migrate_schema_if_needed drops tables on schema drift | Already drops + recreates trade_states. Adding new tables is safe — won't affect existing. |
| Scheduled equity job overlaps with quant_scan | Coalesce=true, misfire_grace=300, runs at HH:02 to avoid HH:00 quant_scan |
| Trade journal hook silently fails | Wrap in try/except, log warning, don't propagate (so trade still places) |
| Backend hot-reload on file save kills running optimize | Apply all changes when no job is running |
| New endpoint returns 500 because globals not initialized | Use getattr with default; surface clear error in JSON |
