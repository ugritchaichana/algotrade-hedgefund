# Technical Architecture & System Design
**System**: AlgoTrade HedgeFund v2.1

## 1. High-Level Architecture

Decoupled client-server architecture running locally on Windows.

- **Backend (`backend/`):** Python 3.12 + FastAPI + APScheduler + SQLAlchemy + MetaTrader5 IPC + ProcessPoolExecutor.
- **Frontend (`frontend/`):** React 19 + Vite + TypeScript + Zustand + Tailwind + Lightweight-Charts.
- **Databases (Docker):** PostgreSQL :5432 (operational + historical OHLC) + ChromaDB :8001 (LLM long-term memory).
- **External:** MetaTrader5 IPC (local terminal), Xiaomi MiMo LLM (REST), Discord webhook, ForexFactory JSON.

**Communication:**
- REST API for config, history, backtest, settings (`/api/*`)
- WebSocket `/api/ws/market` for live tick + signal updates (2-second push interval)

```
+---------------+        +-----------------+        +-------------+
|  React :5173  | <-WS-> |  FastAPI :8000  | <-IPC-> | MT5 Terminal|
| (Vite/Zustand)| <-REST>| (uvicorn async) |         | (terminal64)|
+---------------+        +-----------------+        +-------------+
                                  | SQLAlchemy
                                  v
                         +--------------+      +-----------+
                         | Postgres :5432|     | ChromaDB  |
                         | (action_logs, |     |  :8001    |
                         |  trade_states,|     | (reflection|
                         |  historical_data)|  |  memory)  |
                         +--------------+      +-----------+
```

## 2. Backend Structure

### `backend/app/`

| File | Purpose |
|---|---|
| `main.py` | FastAPI app + APScheduler. Hourly cron at HH:00:05 runs signal scan + auto-trade. 2-sec tick broadcast. Job registry for long-running optimize. |
| `api/ws.py` | WebSocket manager (broadcast TICK_DATA + QUANT_UPDATE) |
| `core/database.py` | SQLAlchemy models (ActionLog, HistoricalData, SystemSettings, TradeState). Postgres URL via env. Migration helper (`init_db`). |
| `core/asset_profiles.py` | 11-symbol G1 profile dict (class + peak_hours + max_spread). Forex pairs disabled by design. |
| `services/quant_desk.py` | Triple Screen signal engine. Uses equity (not balance) for sizing. `_classify_trend`, `determine_regime_and_signal`. |
| `services/execution_desk.py` | **SINGLE place that calls `mt5.order_send`.** Spread + swap + duplicate-position checks. |
| `services/mt5_connector.py` | MT5 IPC wrappers (init, prices, history, account, positions, pending orders). NEVER calls order_send. |
| `services/risk_desk.py` | 4-Pillar intermarket regime classifier. USDJPY-inverted proxies for DXY. |
| `services/macro_desk.py` | ForexFactory news → MiMo class-batched briefing. Informational only. |
| `services/trade_manager.py` | Trailing + partial close on LIVE positions. Runs in hourly cron before signal scan. |
| `services/reflection_desk.py` | End-of-day MiMo critique → ChromaDB. Run via CLI or POST /api/reflection/run-daily. |
| `services/ai_memory.py` | ChromaDB wrapper (`store_memory`, `query_memory`). |
| `services/discord_notifier.py` | Webhook with retry/timeout/truncation. |
| `services/historical_ingest.py` | Incremental + Deep Backfill OHLC ingest. Idempotent (Postgres ON CONFLICT DO NOTHING). |
| `services/backtest_engine.py` | Strategy replay (single + multi + parallel optimize + walk-forward). |

### Background Schedule (APScheduler)

| Job | Trigger | Purpose |
|---|---|---|
| `broadcast_tick_data` | interval, 2s | Push prices+orders+account to all WS clients |
| `background_quant_analysis` | cron, HH:00:05 | Triple Screen scan → auto-trade pending limits |
| `schedule_d1_ingest` | cron, 00:30 daily | Pull new D1 candles for all core_assets |
| `schedule_h4_ingest` | cron, every 4h at HH:15 | Pull new H4 candles |
| `schedule_h1_ingest` | cron, HH:02 hourly | Pull new H1 candles |
| `_gc_old_jobs` | interval, 15 min | Purge optimize jobs older than 1 hour |

### Safety Gates (`main.py:_safety_gates_pass()`)

Every auto-trade signal passes through these checks BEFORE `execute_trade()`:

```python
1. auto_trade_enabled setting == "true"           (kill switch)
2. MT5 terminal_info.connected == true
3. MT5 terminal_info.trade_allowed == true        (Algo Trading button green)
4. MT5 terminal_info.ping_last < 1000ms
5. len(mt5.positions_get()) < max_open_positions
6. today_realized_pnl_pct > -max_daily_drawdown_pct
```

Inside `execute_trade()` (per-symbol checks):
- Spread vs `ASSET_PROFILES[symbol].max_spread`
- `mt5.positions_get(symbol)` no duplicate direction
- `mt5.orders_get(symbol)` no duplicate pending

## 3. Frontend Structure

### `frontend/src/`

| File | Purpose |
|---|---|
| `App.tsx` | Router + global layout. Kill-switch red button in header (with confirm). |
| `main.tsx` | Vite entry. |
| `store/useMarketStore.ts` | Zustand. WebSocket with exponential-backoff reconnect (1s→2s→4s→…→30s max). localStorage v6 cache for offline hydration. Auto-cleans v1-v5 keys. |
| `components/Sidebar.tsx` | Nav: Dashboard, Quant, Execution, Backtest (Data/Run/Optimize), Settings. Dual status indicators (Backend Live + Auto-Trade ON/OFF). |
| `components/CalendarPicker.tsx` | Custom calendar popup. Disabled dates outside data intersection. Quick-jump "Earliest/Latest". |
| `components/ChartWidget.tsx` | Lightweight-Charts wrapper with Entry/SL/TP price lines. |
| `pages/Dashboard.tsx` | 4-Pillar Intermarket + AI Morning Briefing + Account snapshot + recent deals. |
| `pages/QuantScreener.tsx` | Per-symbol Triple Screen table. Sparkline + confidence bar + expandable chart per row. Auto-animate on signal change. |
| `pages/ExecutionDesk.tsx` | Live signal panel + active orders/positions + closed deals. |
| `pages/Settings.tsx` | Asset universe (select MT5 symbols + AI Suggest + Reset). Discord webhook. Risk Tolerance (Conservative/Balanced/Aggressive). Max Open Positions. Daily DD Limit. Auto-Trade toggle. |
| `pages/BacktestDataStatus.tsx` | OHLC inventory per (symbol, timeframe). Buttons: Incremental Sync + Deep Backfill (5k). |
| `pages/BacktestRun.tsx` | Multi-symbol backtest. Smart calendar. Per-symbol breakdown. Copy Report (Markdown with action logs). |
| `pages/BacktestOptimize.tsx` | Grid search. Parameter sweep checkboxes. Walk-Forward checkbox. Rank table with IS PF / OOS PF / Robustness. Per-row Apply Winners (🎯) + Copy + Expand. Copy All / Download .md. |

### State synchronization

- WebSocket pushes TICK_DATA every 2s (prices, orders, account, auto_trade_enabled)
- WebSocket pushes QUANT_UPDATE per symbol when signal scan completes (HH:00:05)
- localStorage caches `technical` / `macro` / `risk` for instant repaint on page reload (1800s TTL)
- Pages that need core_assets (Backtest pages) also fetch via REST as fallback to handle WS-disconnected state

## 4. Data Flow Lifecycle

### Startup
```
1. uvicorn boots → lifespan begins
2. init_db() — Postgres schema migrate if needed
3. init_mt5() — attach to running terminal64.exe
4. Scheduler.add_job(...) × 6
5. Scheduler.start()
6. yield (FastAPI ready to accept connections)
7. Background tasks fire: startup_quant_warmup, startup_d1/h4/h1_ingest
```

### Hourly cron at HH:00:05
```
trade_manager.manage_active_trades()
    └── For each open MT5 position:
        └── Advance trailing state machine
        └── Move SL if R-thresholds crossed
        └── Optionally partial close 50% at 1.5R

For each symbol in core_assets:
    └── determine_regime_and_signal()
        └── D1 trend → H4 trend → H1 trigger
        └── If ENTRY signal:
            └── Notify Discord
            └── Pass through safety gates
            └── execute_trade() → pending limit order on MT5
            └── Persist TradeState row
    └── Broadcast QUANT_UPDATE via WebSocket
```

### Backtest run
```
POST /api/backtest with {symbols, dates, params}
    └── If 1 symbol: run_backtest() in thread (asyncio.to_thread)
    └── If >1 symbol: run_backtest_multi() in thread
        └── For each symbol: load OHLC from Postgres → indicators → bar-by-bar replay
        └── Includes trailing state machine + partial close simulation
        └── Returns per-symbol stats + aggregate + trades + equity curve
```

### Optimize run
```
POST /api/backtest/optimize with {symbols, sweeps, walk_forward: true}
    └── Returns job_id immediately
    └── _run_job() spawned via asyncio.create_task
        └── _prefetch_metas() — fetch MT5 symbol_info in PARENT
        └── ProcessPoolExecutor(max_workers=9)
            └── Workers receive metas + run combos in parallel
            └── Each worker: run_backtest_multi() on TRAIN window only
            └── as_completed loop collects + updates progress_callback
        └── Rank results by chosen metric
        └── If walk_forward: re-run top-N on TEST window → compute Robustness
        └── Persist result to _jobs[job_id]

Frontend polls GET /api/jobs/{job_id} every 1s
    └── Render progress bar while running
    └── Render result table when status=done
```

## 5. Database Schema

```sql
-- action_logs: append-only audit trail
CREATE TABLE action_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP INDEX,
    source VARCHAR(50),
    action VARCHAR(50),
    message TEXT
);

-- historical_data: OHLC for backtest (NOT live signal cache)
CREATE TABLE historical_data (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL INDEX,
    timeframe VARCHAR(10) NOT NULL INDEX,
    time TIMESTAMP NOT NULL INDEX,
    open_price FLOAT,
    high_price FLOAT,
    low_price FLOAT,
    close_price FLOAT,
    tick_volume INTEGER,
    UNIQUE (symbol, timeframe, time)  -- enforces idempotent ingest
);

-- system_settings: key-value config (core_assets, auto_trade_enabled, etc.)
CREATE TABLE system_settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT
);

-- trade_states: track open + recently-closed trades for trailing
CREATE TABLE trade_states (
    id SERIAL PRIMARY KEY,
    ticket INTEGER UNIQUE INDEX,
    symbol VARCHAR(20) INDEX,
    status VARCHAR(20),         -- PENDING/ACTIVE/CLOSED
    order_type VARCHAR(20),
    entry_price FLOAT,
    sl FLOAT,
    tp FLOAT,
    volume FLOAT,
    trailing_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
```

## 6. Environment & Secrets

`backend/.env` (gitignored):

```
MT5_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
DATABASE_URL=postgresql://admin:password123@localhost:5432/hedgefund_cfd
MIMO_API_KEY=...
MIMO_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
MIMO_MODEL=mimo-v2.5-pro
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

`docker-compose.yml`: Postgres + ChromaDB containers. Volumes persist.

## 7. Performance Characteristics (measured 2026-05-24)

| Operation | Time |
|---|---|
| Single backtest, 6 mo, 1 symbol | ~270ms |
| Multi backtest, 6 mo, 11 symbols | ~3s |
| Optimize parallel, 96 combos × 11 symbols (1056 runs) | ~126s (9 workers) |
| Walk-forward overhead (top-20 OOS revalidation) | ~70s |
| Deep Backfill all 11 symbols × 3 TFs (5000 each) | ~40s |
| REST endpoint latency under load | 2-200ms (varies with CPU contention) |
| RAM footprint (main + 9 workers + buffers) | ~1.1 GB Python |

CPU usage during parallel optimize: avg **86%** (target was 80%; overshoot due to Postgres + scheduler activity).

## 8. Known Limitations

1. **Walk-forward is single-split** (train/test) — no rolling-window cross-validation. Phase 5.
2. **LLM is not in decision path** — backtest doesn't simulate LLM influence. By design (see CLAUDE.md).
3. **Per-symbol parameters not supported** — same params applied across whole universe. Per-class variation = Phase 5.
4. **CRITICAL — Live trailing gap.** `trade_manager.py` currently only does **1R → breakeven** SL migration.
   The full 4-stage state machine (BE → 1.5R partial close + lock 0.5R → 2R trail 1×ATR → 3R trail 0.5×ATR)
   is implemented ONLY inside `backtest_engine.run_backtest` (in-Python simulation).
   **Implication:** the walk-forward IS PF 1.44 / OOS PF 1.62 numbers ASSUME the full state machine.
   Live trading without that state machine will produce LOWER P/L than backtest (estimated -20% to -40%
   degradation from missing partial-profit capture and trailing momentum). MUST be closed before paper
   trade results can be compared to backtest projections fairly. Tracked as "Phase 4: live trailing parity".
5. **No CI / automated tests** — manual smoke testing only. Pytest suite = Phase 5.
6. **`_today_realized_pnl` filter bug** — currently sums all deals with `d.type in (0, 1)` rather than
   filtering to `d.entry == DEAL_ENTRY_OUT` (closing-only). May miscount Daily DD gate. 1-line fix
   deferred to Phase 4 alongside trailing parity.
