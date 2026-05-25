# Phase Next — Roadmap Delta after 2026-05-26 push

Drafted: 2026-05-26 after the major Phase D/F/G push.
Updated: 2026-05-26 (later same session) after bug-fix wave + 2 UI overhauls.

This doc captures (a) what just landed, (b) what still needs decisions, (c) the path
forward Phase-by-Phase. It supplements `docs/00_ROADMAP.md` (the 9-phase canonical doc).

---

## Third batch — Bug-fix wave + UI redesigns (2026-05-26 evening)

Came AFTER Phase D/F/G committed (`2cbfc8b`). Triggered by user screenshots + runtime
log showing "Optimize submission failed". 10 bugs + 2 UI overhauls.

### Bugs fixed (10)

| ID | Symptom | Root cause | Fix |
|---|---|---|---|
| FIX1 | Trade Journal NAS100 exit_price = 52.58 (impossible — that's LTCUSD's last price) | `mt5.history_deals_get(..., position=ticket)` keyword filter unreliable on some MT5 builds → returns all deals → `out_deals[-1]` is global most-recent | Re-filter in Python: `getattr(d, "position_id", None) == trade.ticket` |
| FIX2 | Optimize reported OOS PF 634 (impossibly high) | `_cost` accepted `actual_spread_points=0` as valid → cost=0 → PF = gross/0 = infinite | Treat `<=0` as missing → fallback to flat `spread_pips` parameter |
| FIX3 | EURUSD "no data at all" warning despite Data Status showing 5000 H1 | `/api/historical/date-range` only checked "has any row" — didn't compare against requested backtest window | Added `start_date`+`end_date` params; partial coverage now reports "data ends YYYY-MM-DD (before requested YYYY-MM-DD)" |
| FIX4 | Execution Desk "Recent Closed Deals" empty despite journal having 3 closed trades | Page read from `accountStatus.recent_history` (MT5 native field, often unreliable) | Switched to `GET /api/journal?days=7` + auto-refresh on `TRADE_CLOSED` WS event |
| FIX5 | Data Status table missing M1 column + M1 ingest returned 0 candles | (a) frontend `timeframes` array missing 'M1', (b) broker rejected `count=300000` request silently | (a) Added M1 to table, (b) `deep_backfill_timeframe` fallback chain 300k → 100k → 50k → 20k → 5k. BTCUSD M1 = 50000 candles confirmed |
| FIX6 | `api_test_probe_value` from API test polluting Settings UI + Activity Feed | Test didn't clean up | New `DELETE /api/settings/{key}` endpoint + test teardown in `finally:` block |
| FIX7 | Edge/Noise classifier counted trail-out stops as noise | `_classify_attribution` only matched literal `"TRAIL_SL"`/`"Trail SL"` strings, but `trade_manager` sets exit_reason to MT5 DEAL_REASON → "Stop Loss" for any SL hit (initial OR trailed) | Classifier now uses `r_multiple >= 1.5` to distinguish trail-out from initial-SL on any SL-family reason |
| **FIX8 CRITICAL** | (Silent — caught only via runtime log: `RuntimeWarning: coroutine 'broadcast_tick_data' was never awaited`) | `_tracked` decorator wrapped async functions with sync wrapper → coroutine returned, never awaited → WS TICK_DATA broadcasts dead since commit `2cbfc8b` | Detect async via `asyncio.iscoroutinefunction` → return async wrapper that awaits |
| FIX9 | Optimize page lost state on browser tab close/refresh + no way to view past results | Component state only — no persistence | localStorage persist `algotrade_active_optimize_job` + on-mount restore (from localStorage AND backend `/api/jobs?status=running`) + WS subscribe to `optimizeProgress` slice + History panel with last 20 jobs |
| FIX10 | "Optimize submission failed" — generic error on every default Run click | (a) Default `tp_atr_mult.enabled=true` but backend validator rejects (added in `2cbfc8b` T3#14), (b) frontend didn't parse FastAPI 422 `detail[].msg` | (a) Default disabled + label updated, (b) auto-move enabled `tp_atr_mult` to `fixed`, (c) error display parses `detail[].msg` |

### UI overhauls (2)

**UI #1 — Quant Screener expand row (first attempt):**
Replaced the narrow 25% Trade Details column with 4-card grid: Triple Screen Alignment
chips (D1/H4/H1 with trend icons + ALIGNED badge), RSI gauge with zone markers
(0-30 oversold, 40-55 entry, 70-100 overbought) + needle at current value, Volume vs
VMA with ratio bar, Execution Plan (Entry/SL/TP boxes + R/R + Lot + Risk%), Reasoning
(Technical + Macro). Live Price card with bid/ask/OPEN-CLOSED/spread/last-tick-age.

**UI #2 — Quant Screener TradingView layout (superseded #1):**
Discarded expand-row pattern. Two-pane layout:
- LEFT (large): Symbol header (bid/ask/OPEN/CLOSED/signal) + Live Chart + Detail cards below
- RIGHT (320px sticky): Watchlist sidebar — search input + filter dropdown + scrollable list
  with sparkline, signal badge, RSI mini, POS indicator

**Timeframe selector** above chart: M5 / M15 / H1 / H4 / D / W (6 TFs).

`ChartWidget` extended:
- accepts `timeframe` prop (default H1)
- accepts `height` prop (default fills parent via `autoSize`)
- backend `mt5_history` endpoint adds `W1` + `MN1` to `tf_map`
- `cancelled` flag in fetch effect prevents stale-data race

**Persistence**: selected symbol + timeframe stored in localStorage:
- `algotrade_selected_symbol`
- `algotrade_chart_timeframe`

Reload page → restored.

### Tests added/extended

| Suite | Cases | Type |
|---|---|---|
| `test_attribution_classify.py` | 8 → 10 | FIX7 — stop-loss-at-high-r is edge + manual-trail-default-classified-via-r |
| `test_spread_aware_cost.py` | 4 → 6 | FIX2 — zero + negative spread fallback |
| `test_api_endpoints.py` | NEW 28 + 5 heavy | Live API smoke (auth, health, settings, journal, attribution, equity, jobs, MT5 proxy, historical) + heavy (kill-switch, backtest_run, optimize_queue, deep-backfill, reflection) |
| Backend pytest total | **67** + 5 heavy | up from 35 |
| `frontend/tests/e2e/*` | 16 spec files (NEW) | auth, theme, command_palette, activity_feed, kill_switch, dashboard, navigation, quant_screener (8 cases for TradingView layout), execution_desk, equity_curve, trade_journal, system_health, backtest_data, backtest_run, backtest_optimize, settings |
| Frontend E2E total | **85** | with auth fixture (`pre-inject PIN + theme via localStorage`) |
| Frontend Vite build | 288kb gzipped | OK |

### Files in third batch

```
M backend/app/main.py
   — /api/historical/date-range adds start_date+end_date partial-coverage check (FIX3)
   — DELETE /api/settings/{key} endpoint (FIX6)
   — _classify_attribution uses r_multiple for SL-family reasons (FIX7)
   — _tracked decorator async-aware via asyncio.iscoroutinefunction (FIX8)
   — POST /api/historical/deep-backfill accepts {symbols, timeframes} body (FIX5)
   — mt5_history tf_map adds W1 + MN1 (UI #2)
M backend/app/services/backtest_engine.py
   — _cost treats actual_spread_points<=0 as missing fallback (FIX2)
M backend/app/services/historical_ingest.py
   — deep_backfill_timeframe fallback chain when broker returns empty (FIX5)
M backend/app/services/trade_manager.py
   — _process_closed_trade re-filters by position_id in Python (FIX1)
M backend/pytest.ini
   — heavy marker registered, default addopts excludes heavy
A backend/tests/test_api_endpoints.py
   — 28 covered endpoints + 5 heavy
M backend/tests/test_attribution_classify.py  (FIX7 + 2 regression)
M backend/tests/test_spread_aware_cost.py     (FIX2 + 2 regression)
M frontend/package.json
   — test:e2e uses @playwright/test cli directly (avoid CT collision)
M frontend/src/components/ChartWidget.tsx
   — accepts timeframe + height + count props, cancelled flag in fetch
M frontend/src/pages/BacktestDataStatus.tsx       (M1 column — FIX5)
M frontend/src/pages/BacktestOptimize.tsx
   — localStorage active job persistence (FIX9)
   — on-mount restore from localStorage AND backend (FIX9)
   — WS optimizeProgress subscription + OPTIMIZE_DONE handler (FIX9)
   — History panel with last 20 jobs (FIX9)
   — DEFAULT_SWEEPS.tp_atr_mult.enabled = false (FIX10)
   — auto-move enabled tp_atr_mult to fixed (FIX10)
   — parse FastAPI 422 detail[].msg in error display (FIX10)
M frontend/src/pages/BacktestRun.tsx               (pass window to API — FIX3)
M frontend/src/pages/ExecutionDesk.tsx             (trade_journal source + WS refresh — FIX4)
M frontend/src/pages/QuantScreener.tsx
   — TradingView 2-pane layout (chart LEFT + watchlist RIGHT)
   — timeframe selector M5/M15/H1/H4/D/W
   — localStorage persist selected symbol + TF
   — detail cards below chart (Triple Screen + RSI + Volume + Execution + Reasoning)
A frontend/tests/e2e/fixtures/auth.ts              (auth fixture for E2E)
A frontend/tests/e2e/{15 spec files}                (NEW spec suite)
M frontend/tests/e2e/{5 existing spec files}        (refactored to use auth fixture)
```

---

## Phase D/F/G push (2026-05-26, committed `2cbfc8b`)

Same as previously documented in this file — kept below for context.

## What landed in code 2026-05-26 (post-Tier-1-3 hardening + Phase D + F + G partial)

### Backend (11 items)

| ID | Description | Files |
|---|---|---|
| B1 | spread + real_volume columns in `historical_data`. Per-candle spread now flows through `backtest_engine._cost` for realistic friction modeling | `database.py`, `historical_ingest.py`, `backtest_engine.py` |
| B2 | Performance Attribution endpoint `GET /api/journal/attribution` (edge vs noise classifier) | `main.py` |
| B3 | `signal_state` + `optimize_jobs` + `pending_actions` tables — in-memory state migrated to DB. Restart-resilient. Closing browser tab no longer loses optimize progress | `database.py`, `main.py` |
| B4 | `core/events.py` + lifespan attach. WS broadcast now parallel (`asyncio.gather`). Per-event-type throttling | `events.py`, `ws.py`, `main.py` |
| B5 | Broadcast points wired: TRADE_OPENED, TRADE_CLOSED, TRADE_STATE_CHANGE, EQUITY_SNAPSHOT, OPTIMIZE_PROGRESS, OPTIMIZE_DONE, SAFETY_EVENT, SETTING_CHANGED, INGEST_TICK, HEALTH_DELTA | `execution_desk.py`, `trade_manager.py`, `equity_recorder.py`, `discord_notifier.py`, `historical_ingest.py`, `main.py` |
| B6 | `trade_stops_level` enforcement + `volume_min/step` clamp + `trade_mode != FULL` skip + `margin_initial` pre-check | `execution_desk.py` |
| B7 | `swap_rollover3days` correct triple-swap day from broker info | `execution_desk.py` |
| B8 | Retry queue: `pending_actions` table + `retry_worker.py` service + scheduled job every 1min. Failed transient trades retry when conditions recover (market open, spread normalize, MT5 reconnect) | `retry_worker.py`, `database.py`, `main.py` |
| B9 | Pre-trade slippage forecast gate — uses M1 historical spread per hour-of-day, skips if forecast > 3x baseline | `main.py` |
| B10 | Auto-optimize monthly cron — runs 1st of month at 02:00 UTC+7. Walk-forward grid on Run-3 neighborhood. Decision tree (NO_ACTION / ALERT / AUTO_APPLY) gated by `auto_apply_on_drift` setting (default false) | `auto_optimize.py`, `main.py` |
| B11 | Full-autonomous self-heal on startup: interrupted optimize jobs marked, signal_state reloaded, expired pending_actions cleared, ancient (>7d) purged. New `/api/system/watchdog` endpoint for external monitoring | `main.py` |

### Frontend (5 items)

| ID | Description | Files |
|---|---|---|
| F1 | Dark / Light mode via CSS variables + `data-theme` attribute. Persisted in localStorage. Header toggle button | `tailwind.config.js`, `index.css`, `lib/theme.ts`, `main.tsx`, `App.tsx` |
| F2 | Cmd+K command palette via `cmdk`. Navigate to any page, toggle kill switch, toggle theme, trigger auto-optimize, reload — all keyboard-driven | `components/CommandPalette.tsx`, `App.tsx` |
| F3 | Activity Feed widget (bottom-right drawer with unread badge). Consumes WS events: TRADE_OPENED, TRADE_CLOSED, TRADE_STATE_CHANGE, SAFETY_EVENT, EQUITY_SNAPSHOT, OPTIMIZE_DONE, INGEST_TICK, HEALTH_DELTA, SETTING_CHANGED. Store extended with `recentEvents`, `positionStates`, `optimizeProgress`, `recentSafetyEvents`, `equitySeries`, `healthDeltas` slices | `components/ActivityFeed.tsx`, `store/useMarketStore.ts` |
| F4 | Trade Journal v2 — added R-multiple distribution histogram + Edge vs Noise attribution cards (uses `/api/journal/attribution`). Color-coded buckets so Phase 2 demo data is immediately interpretable | `pages/TradeJournal.tsx` |
| F5 | Equity Curve v2 — added Recharts ComposedChart with drawdown shading (red area, peak-to-trough) + daily P/L bars (green/red). Themed via CSS vars | `pages/EquityCurve.tsx` |

### Tests (3 new files, 35 total tests)

- `test_attribution_classify.py` — edge/noise classifier lock-in (8 cases)
- `test_retry_classifier.py` — transient/stale/terminal classification (12 cases)
- `test_spread_aware_cost.py` — backtest cost model with per-candle spread (4 cases)
- All earlier tests still pass (11 cases for indicators/state machine/idempotency/throttle/cost)

### New API endpoints

- `GET /api/journal/attribution?days=N` — edge vs noise breakdown + R-distribution + per-symbol/per-reason
- `GET /api/system/watchdog` — 200 OK if all critical loops healthy; 503 with `failures: []` otherwise
- `POST /api/optimize/auto-refresh` — manual trigger for auto-optimize cron (test pipeline without waiting for 1st-of-month)

### New scheduler jobs (10 total now)

| id | cadence | purpose |
|---|---|---|
| tick_broadcast | 2s | WS TICK_DATA |
| ingest_m1 | 1min | M1 OHLC + INGEST_TICK broadcast |
| retry_worker | 1min | drain pending_actions |
| sync_closed_positions | 5min | reconcile MT5 native closures |
| quant_scan | hourly @ HH:00:05 | Triple Screen + auto-trade |
| ingest_h1 | hourly @ HH:02 | H1 OHLC |
| equity_snapshot | every 4h @ HH:02 | equity_snapshots row + EQUITY_SNAPSHOT broadcast |
| ingest_h4 | every 4h @ HH:15 | H4 OHLC |
| ingest_d1 | daily @ 00:30 UTC+7 | D1 OHLC |
| **auto_optimize_monthly** | 1st of month @ 02:00 UTC+7 | walk-forward grid + suggest/apply |

---

## What still needs decisions

### 1. LLM trade-decision integration — option A / B / C / D
User asked but didn't pick. See `current-state.md` discussion. Recommendation: **option D**
(informational expansion — morning briefing depth, weekly performance interpretation, anomaly
flagging) — preserves backtest validation invariant.

### 2. MACD + EMA + Structure SL — strategy changes
All 3 invalidate Run 3 deploy candidate. Each requires Run 10+ walk-forward + holdout
re-validation. Recommendation: **wait until Phase 2 demo data exposes specific weakness,
then apply ONE strategy change at a time, not all three**.

### 3. `auto_apply_on_drift` setting
Default `false`. Booth must explicitly set `true` after Phase 2 baseline collected. Without
real-money baseline, auto-apply could push overfit params into production.

---

## Critical path forward (priority order)

### P1. Manual smoke test of new UI features (~30min)
1. Open frontend in browser. Verify Cmd+K palette opens, theme toggle flips
2. Open Trade Journal — verify Edge/Noise cards render + R-distribution histogram appears
3. Open Equity Curve — verify drawdown area + daily P/L bars render
4. Trigger a test signal manually OR wait for hourly scan — verify Activity Feed receives
   TRADE_OPENED/STATE_CHANGE/CLOSED events
5. Test `POST /api/optimize/auto-refresh` — verify OPTIMIZE_DONE arrives via WS

### P2. Phase 2 Demo Forward Test on IUX ($10k, 4 weeks)
**Now ready** — every tool needed to measure + decide is in place:
- Performance attribution → tells you if edge is real or noisy
- Equity curve v2 → see DD pattern visually
- Trade Journal v2 → audit every trade with R/exit_reason/signal_context
- Activity Feed → realtime monitoring without polling
- Persistent state → restart doesn't lose progress
- Retry queue → no false negatives from transient broker issues
- Slippage forecast gate → skip news-volatility periods

**Setup:** IUX demo $10k, `risk_percent=0.5`, `max_open_positions=3`, `max_daily_dd=5%`,
G1 universe (11 symbols), `auto_trade_enabled=true`.

**Exit criteria (all 4 must pass):**
- Live PF ≥ 0.7 × backtest PF (~3.0)
- Live WR ≥ 0.85 × backtest WR (~55%)
- Live max DD ≤ 1.5 × backtest max DD (~25%)
- Trade count ≥ 0.6 × projected (50-80 trades/4wk)

### P3. Decision branch (week 5 after demo)

**If demo passes:** → Phase 3 cent account ($100 real). Tools to add then:
- Alembic versioned migrations (T3#13 deferred) — REQUIRED before real money since
  schema drop kills journal history
- Empirical slippage feedback (T3#15 deferred) — feed Phase 2 slippage data back into
  backtest cost model
- Shadow paper at 2nd broker — A/B test live execution friction

**If demo FAILS:** Use attribution data to diagnose ONE specific issue, fix targeted, retest.
Anti-pattern: pile MACD/EMA/structure-SL all at once without empirical evidence of which helps.

### P4. Strategy hardening (Phase 5 of canonical roadmap)
Pull from roadmap based on Phase 2 findings:
- 5.1 Correlation-aware sizing (if Phase 2 shows correlated DD spikes on crypto cluster)
- 5.2 News blackout filter (if slippage forecast gate insufficient)
- 5.3 Consecutive loss circuit breaker (if Phase 2 shows N losses cluster)
- 5.6 Per-asset-class params (if per-class Phase 2 PF varies widely)
- 5.7 Empirical slippage recalibration

### P5. Frontend Phase G remaining (G.2-G.7, ~30 ชม.)
Defer until after Phase 2 — current G.1 + journal/equity v2 is sufficient for Phase 2
monitoring. Bring in:
- G.2: Backtest comparison view (when comparing Run 10 vs Run 3)
- G.3: Skeleton states + optimistic UI polish
- G.4: Search bar + PWA + IndexedDB cache
- G.5: Customizable dashboard widgets

---

## Architecture state diagram

```
                    ┌──────────────────────────────────────────────┐
                    │              FRONTEND (React 19)              │
                    │                                                │
                    │  Dark/Light theme + Cmd+K palette              │
                    │  Activity Feed (bottom-right, WS-driven)       │
                    │  Pages → Zustand store + TanStack-style state  │
                    │  Trade Journal v2 + Equity v2 + ...            │
                    └────────────────┬─────────┬─────────────────────┘
                                     │         │
                                  REST│         │WebSocket (PIN-gated)
                                     │         │
        ┌────────────────────────────▼─────────▼──────────────────────┐
        │                         BACKEND (FastAPI)                    │
        │                                                              │
        │  Lifespan attach → events.py broadcaster                     │
        │  PIN auth + rate limit + ws handshake                        │
        │  Safety gates 1-6: kill, ping/reconnect, max-positions,      │
        │     DD, max daily trades, slippage forecast                  │
        │  Idempotency cache + graceful shutdown flag                  │
        │                                                              │
        │  Schedulers (10):                                            │
        │    tick_broadcast, ingest_m1, retry_worker,                  │
        │    sync_closed, quant_scan, ingest_h1/h4/d1,                 │
        │    equity_snapshot, auto_optimize_monthly                    │
        │                                                              │
        │  Services:                                                   │
        │    execution_desk (single MT5 entry — 6 gates)               │
        │    trade_manager (4-stage trail + slippage capture)          │
        │    backtest_engine (per-candle spread aware)                 │
        │    auto_optimize (monthly walk-forward + decision tree)      │
        │    retry_worker (transient failure drain)                    │
        │    equity_recorder, discord_notifier (5-emitter throttled)   │
        └─────────────┬────────────────────────────────────────────────┘
                      │
                      ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                       POSTGRES (DB)                          │
        │                                                              │
        │  historical_data (+ spread, real_volume columns NEW)         │
        │  trade_states     (4-stage state machine)                    │
        │  trade_journal    (per-trade + signal_context + slippage)    │
        │  equity_snapshots (4h cadence + WS push on insert)           │
        │  action_logs      (system event audit trail)                 │
        │  system_settings  (KV runtime config)                        │
        │                                                              │
        │  signal_state     NEW — per-symbol last scan + notified      │
        │  optimize_jobs    NEW — persistent + history                 │
        │  pending_actions  NEW — retry queue                          │
        └──────────────────────────────────────────────────────────────┘
```

---

## Open items / debt

- ExecutionDesk.tsx TS7006 (deal: any) — pre-existing, low impact, fix during G.3 polish
- Vite bundle >500kb warning — code-split via `manualChunks` in vite.config.ts, defer
- `_uvicorn_loop` still module-level — could move into events.py with the attach call, defer
- No frontend tests yet (Phase G.5 includes vitest setup)
- Discord interactive slash commands not implemented — Phase G future when remote ops needed
- Alembic — see deferred-items.md, planned before Phase 3
- Empirical slippage recalibration — see deferred-items.md, planned end of Phase 2

---

## Quick reference

| What I want to do | Where to go |
|---|---|
| Check live state | `/api/health/deep` (full) or `/api/system/watchdog` (one-shot) |
| Trigger auto-optimize now | `POST /api/optimize/auto-refresh` |
| Review trade attribution | UI Trade Journal page OR `GET /api/journal/attribution?days=30` |
| See activity stream | Activity Feed (bottom-right drawer) OR `recentEvents` in store |
| Toggle dark/light | Cmd+K → "Toggle Theme" OR header sun/moon button |
| Stop trading | Cmd+K → "STOP Auto-Trade" OR header red button |
| Replay PIN dialog | `localStorage.removeItem('algo_pin')` + reload |
| View pending retry queue | Query `pending_actions` table directly (no UI yet — G.future) |
| View optimize history | `GET /api/jobs?limit=20` OR query `optimize_jobs` table |
