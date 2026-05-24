# Agent Handoff & Quickstart Guide
**Target Audience**: Future AI Agents (Claude / Cursor / etc.) entering this codebase.

## Welcome, Agent

This is **AlgoTrade HedgeFund v2.1** — a Triple Screen Multi-Timeframe trend-following auto-trader for MetaTrader 5. Pure technical strategy. LLM is informational only (does NOT gate trades).

**FIRST**: Read `NEXT_SESSION.md` (project root) — has current state + priority tasks + known bugs.
**THEN**: This file for codebase orientation.

**Authoritative rules:** `CLAUDE.md` at repo root. Read it before any code change.
**Master roadmap:** `docs/00_ROADMAP.md` — 9 phases from validation to public.
**Strategy spec:** `docs/01_BUSINESS_REQUIREMENTS.md`
**Architecture:** `docs/02_TECHNICAL_ARCHITECTURE.md`

**Current phase:** Phase 1 (Live Trailing Parity) — backend `trade_manager.py` only does
breakeven. Full state machine is in `backtest_engine._advance_trailing` only. Until parity
is achieved, live results can't be compared to backtest projection. See `docs/04_PHASE_4_IMPLEMENTATION.md` for ready-to-apply code.

## 1. Project Context (1-minute version)

- Backend `app/main.py` (FastAPI + APScheduler) is the live engine. No standalone `bot_runner.py`.
- Strategy = Triple Screen D1+H4+H1 alignment + RSI pullback + ATR-sized + trailing/partial-close.
- Universe = G1 only (11 volatile trending assets). Forex disabled.
- Optimize via grid search + walk-forward validation. ProcessPoolExecutor with 9 workers.
- All trades flow through `app/services/execution_desk.execute_trade()`. No exceptions.

## 2. Where Things Are

### Backend
- `app/main.py` — FastAPI entry, scheduler, safety gates, job registry
- `app/services/quant_desk.py` — Triple Screen signal logic
- `app/services/execution_desk.py` — SINGLE place for `mt5.order_send`
- `app/services/backtest_engine.py` — Strategy replay + parallel optimize + walk-forward
- `app/services/trade_manager.py` — Trailing + partial close on live positions
- `app/services/historical_ingest.py` — OHLC ingest (incremental + deep backfill)
- `app/core/database.py` — SQLAlchemy models (action_logs, historical_data, system_settings, trade_states)

### Frontend
- `src/App.tsx` — Router + Kill-Switch button in header
- `src/store/useMarketStore.ts` — Zustand state + WebSocket with backoff
- `src/components/CalendarPicker.tsx` — Smart calendar (disabled dates outside data window)
- `src/pages/BacktestOptimize.tsx` — Grid search UI with Walk-Forward + Apply Winners + Copy All

### Configs
- `backend/.env` — secrets (gitignored)
- `backend/.env.example` — template
- `docker-compose.yml` — Postgres + ChromaDB
- `start_all.bat` — Windows launcher

## 3. Important Quirks & Pitfalls

### 3.1 LLM is NOT in decision path
In `main.py:background_quant_analysis`, `result["reason_economic"]` etc. are populated from MiMo, but the `if signal.startswith("ENTRY")` branch does NOT check them. To wire LLM gating, modify `_safety_gates_pass()` directly — but note: backtest cannot replay historical LLM outputs reliably.

### 3.2 Backtest engine has its own trade lifecycle
`backtest_engine.run_backtest` simulates trailing + partial close in pure Python (no MT5 calls). Workers in ProcessPoolExecutor receive pre-fetched symbol metadata so they never touch MT5 IPC. This is CRITICAL — child processes cannot share MT5 connections cleanly.

### 3.3 Walk-Forward is mandatory before "Apply Winners"
The Optimize page returns ranked combos. Each combo has `is_aggregate` (in-sample) and `oos_aggregate` (out-of-sample) + `robustness_score` (OOS_PF / IS_PF). Only apply combos with `robustness_label = "Robust"` (score ≥ 0.85). Marginal (0.5-0.85) is risky. Overfit (<0.5) is forbidden.

### 3.4 Per-symbol concentration check
After optimize, look at the per-symbol breakdown of the winning combo. If top 2 symbols carry > 70% of P/L, strategy is fragile (works on lucky few, not robust). Re-evaluate.

### 3.5 Triple Screen requires alignment
D1 and H4 trends MUST agree (both Bullish or both Bearish). Either Sideways → no trade. This is INTENTIONAL — no exception.

### 3.6 Equity, not balance, for sizing
`quant_desk.calculate_lot_size(symbol, equity, ...)`. Never revert to balance — drawdown-aware sizing protects the account.

### 3.7 G2 (Forex) is intentionally disabled
6-month backtest showed forex pairs lose consistently with Triple Screen (mean-reverting nature). DON'T re-enable them unless implementing a separate mean-reversion strategy variant.

### 3.8 Date format conventions
- API endpoints accept ISO strings: `"2026-01-01"` or `"2026-01-01T00:00:00"`.
- Frontend CalendarPicker outputs `"YYYY-MM-DD"` (no time).
- Postgres `historical_data.time` is naive datetime in MT5 broker timezone.

### 3.9 Postgres ON CONFLICT DO NOTHING
`historical_ingest.py` uses PostgreSQL-specific upsert. Schema MUST have `UNIQUE (symbol, timeframe, time)`. Don't switch to SQLite — the dialect-specific INSERT will fail.

### 3.10 Backend restart loses in-memory state
`_last_quant_data`, `_jobs` (optimize results), `_cached_settings` are all in-process. On restart:
- Quant data: warmup task runs at startup
- Jobs: lost permanently (no persistence — Phase 5 if needed)
- Settings: re-read from DB on first request

### 3.11 CRITICAL — Live vs Backtest gap (trailing)
`backtest_engine.run_backtest` simulates a full 4-stage trailing state machine
(1R → breakeven → 1.5R partial close + lock 0.5R → 2R trail 1×ATR → 3R trail 0.5×ATR).
`trade_manager.manage_active_trades` only does the FIRST step (1R → breakeven). The rest is missing.
This means **walk-forward "Robust" results overstate live performance.** Don't compare
backtest IS PF 1.44 / OOS PF 1.62 against early paper-trade P/L until live trailing parity ships
(Phase 4 work). See `docs/02 Known Limitations #4`.

### 3.12 Daily DD bug in `_today_realized_pnl`
`main.py:130-139` sums `d.profit` for all `d.type in (0, 1)` deals — INCLUDES opening deals
where profit==0 (harmless) but the right filter is `d.entry == mt5.DEAL_ENTRY_OUT` (closing only).
Currently this bug doesn't block any trade incorrectly (closing-deal profits dominate),
but the count is technically wrong. 1-line fix scheduled for Phase 4.

## 4. Tuning Workflow

When you (the agent) are asked to "improve the strategy" or "find better params":

```
1. Verify Deep Backfill is current: GET /api/historical/status
2. Apply G1 universe (or current core_assets)
3. POST /api/backtest/optimize with walk_forward: true
4. Poll GET /api/jobs/{id}
5. Filter results: Robust + PF > 1.2 + DD < 15%
6. Check concentration: top 2 symbols < 70%
7. Suggest applying winners — but always confirm with user
8. Never auto-apply without explicit user approval
```

## 5. Common Mistakes to Avoid

- ❌ Modifying `quant_desk.py` to bypass D1+H4 alignment ("but it might catch more trades!")
- ❌ Increasing default `risk_percent` above 2% in code
- ❌ Re-enabling forex pairs in `G1_ASSETS` (or via Settings UI) without separate strategy
- ❌ Removing safety gates ("user can re-enable them later")
- ❌ Calling `mt5.order_send` outside `execution_desk.py`
- ❌ Optimizing without walk-forward → presenting in-sample numbers as if real
- ❌ Setting `parallel: false` for grid > 10 combos (slow, blocks event loop indirectly)
- ❌ Using `balance` instead of `equity` for lot sizing
- ❌ Treating LLM `macro_badge` as ground truth for trade decisions (it's informational)

## 6. Validated Current State (2026-05-24)

### Code defaults — walk-forward verified (Run 1)
**Strategy:** Triple Screen on G1 with SL=0.5×ATR, TP=4×ATR, RSI 40-55, SMA 20/50, VMA 20
**Walk-forward validation:** IS PF 1.44 → OOS PF 1.62 → Robustness 1.125 (= Robust, OOS BETTER than train)
**Window:** Oct 2025 - May 2026 (6.7 months, 96-combo sweep)
**Universe applied to live:** G1 (11 symbols) via Settings
**Test environment:** Working — Backend :8000, Frontend :5173, Postgres + ChromaDB, MT5 trade_allowed=true

### Latest in-sample finding (Run 2) — NOT validated, NOT in code yet
A 2592-combo sweep on 3-month window (Feb-May 2026) found a higher IS PF (2.24) with different params:
- SL=0.5, TP=any of {3,4,5,6}, RSI 45-60, sma_fast **15**, sma_slow 50, vma 20
- IS: 244 trades, 62.7% win rate, +6.87%, 11.89% max DD
- **Not walk-forward validated. Do not deploy. Treated as hypothesis for Run 3.**

### Architectural finding from Run 2 — TP is decorative
Ranks 1-4 had identical stats with TP values 3, 4, 5, 6. No trade ever reaches TP price —
trailing + partial-close always exit first. Future sweeps should fix TP at one value.

### Edge-of-grid signals from Run 2
- SL=0.5 dominated → test [0.25, 0.4] next
- sma_fast=15 dominated → test [10, 12] next

See `docs/01 §5` for the full strategy parameter history and `CLAUDE.md` "Tuning History"
for the running log of optimization runs.

## 7. Next-Phase Work (when asked)

In rough priority order:

1. **Phase 4 — live trailing parity + DD bug fix + quant_desk docstring** — close the live-vs-backtest gap so paper trade reflects backtest. See CLAUDE.md "Known Code Gaps".
2. **Run 3 optimization** — extended sweep covering edge-of-grid candidates (SL 0.25-0.75, sma_fast 10-20) + walk-forward. Resolves §6 hypothesis from Run 2. See `docs/01 §5.5` for exact sweep spec.
3. **Fix `buildReportForRank` in `frontend/src/pages/BacktestOptimize.tsx`** to include OOS PF + Robustness Label + Robustness Score in the Markdown report. Currently the report only shows IS aggregate even when walk-forward is on. ~10 min frontend edit.
4. **News-event blackout filter** — read economic calendar, pause new entries 90min before high-impact events. LLM + backtest-friendly (use historical calendar data).
5. **Per-asset-class strategy variants** — separate Triple Screen for crypto vs metals vs indices. May find better per-class params.
6. **Mean-reversion strategy for G2 (forex)** — RSI extreme fade. Re-enable currency pairs with proper strategy.
7. **Rolling walk-forward** — current is single-split. Add expanding/rolling window cross-validation.
8. **Pytest suite** — currently no automated tests.
9. **CI/CD** — GitHub Actions when project becomes a git repo.

## 8. How to Test Your Changes

```bash
# Start full stack
start_all.bat

# Verify backend
curl http://127.0.0.1:8000/api/health

# Verify Triple Screen still produces signals
curl http://127.0.0.1:8000/api/analysis/technical/XAUUSD

# Run a small backtest
curl -X POST http://127.0.0.1:8000/api/backtest \
  -H "Content-Type: application/json" \
  -d '{"symbols":["BTCUSD"],"start_date":"2026-03-01","end_date":"2026-05-01"}'

# Verify Optimize endpoint
curl -X POST http://127.0.0.1:8000/api/backtest/optimize \
  -H "Content-Type: application/json" \
  -d '{"symbols":["BTCUSD","XAUUSD"],"start_date":"2026-03-01","end_date":"2026-05-01",
       "sweeps":{"sl_atr_mult":[0.5,1.0]}, "walk_forward":true}'

# Front-end smoke test: open localhost:5173, click through each page
```

## 9. Communication with the User

The user (Booth):
- Prefers **direct, honest, non-deferential** answers. Don't soften findings.
- Won't 20%/month is unrealistic; system targets 15-30% annualized.
- Wants LLM as informational layer, not decision-maker (per session 2026-05-24).
- Has Ryzen 5 5600X (12 logical cores) + 16 GB RAM. CPU up to 80%, RAM use freely.
- Uses MT5 with IUX broker (CFD trading).

Good luck, Agent. The walk-forward gate is your friend — use it.
