# START HERE — New Session Bootstrap

**If you're a fresh agent: read `NEXT_SESSION.md` (project root) FIRST.** It has current state,
priority tasks, what NOT to touch, and known bugs. Spending 2 minutes there saves an hour
of confused tool calls.

Then read in this order:
1. This file (`CLAUDE.md`) — coding rules + Tuning History + invariants
2. `docs/00_ROADMAP.md` — master 9-phase roadmap, current phase
3. `docs/01_BUSINESS_REQUIREMENTS.md` — strategy spec + Run 1-8 backtest history
4. `~/.claude/projects/.../memory/current-state.md` — latest deployment state
5. Task-specific: `docs/04` (Phase 1 work), `docs/05` (CI/CD), `docs/07` (ops), `docs/08` (backend code ref)

# System & Context
You are working on the **AlgoTrade HedgeFund System v2.1**.
This is a local Algorithmic Trading Screener + Auto-Execution bot for MetaTrader 5 (MT5).
The live engine is `backend/app/main.py` (FastAPI + APScheduler). There is no standalone `bot_runner.py`.

**Project status (2026-05-24):** Phase 0 (backtest validation) done via 8 runs. Run 3 params chosen
as deployable. Phase 1 (live trailing parity) is NEXT — required before any real-money deployment.
See `docs/00_ROADMAP.md` for full plan.

# Realistic expectations
This is a **pure technical** trend-following system. Realistic targets:
- **5-15% per month sustained** = top decile of retail algo systems
- **15-30% per year** = world-class (Buffett-tier)
- **20%+ per month** = mathematically infeasible long-term — any code claiming this will blow up the account

The LLM (Xiaomi MiMo) layer is **informational only**. It does NOT gate trade decisions in the current
code. See `app/main.py:background_quant_analysis` — the auto-trade path checks safety gates
(ping, max-positions, daily-DD, kill switch) but does NOT block on `macro_badge` or LLM sentiment.
LLM is used for: morning briefing display, daily reflection, asset recommendation help, log critique.

# Coding Guidelines
- **Backend:** Python 3.12, FastAPI, SQLAlchemy + PostgreSQL, APScheduler, MetaTrader5 IPC, ProcessPoolExecutor for grid search.
- **Frontend:** React 19 + Vite + TypeScript + Zustand + Tailwind CSS + Lightweight-Charts.
- **Data:** PostgreSQL (ActionLog, HistoricalData with timeframe column, SystemSettings, TradeState). ChromaDB for daily reflection memory.

# Strategy — Triple Screen (D1 + H4 + H1) + Trailing
1. **D1 macro trend** — SMA(20/50). Bullish if close > SMA20 > SMA50; Bearish if close < SMA20 < SMA50; else Sideways.
2. **H4 medium-term confirmation** — SMA(20/50). MUST agree with D1. Else signal = WAITING.
3. **H1 entry trigger** — RSI(14) in entry zone + tick_volume > VMA(20) + ATR for sizing.
   - Pending LIMIT order at low (BUY) or high (SELL) of previous CLOSED H1 bar.
   - SL = entry ± SL_mult × ATR. TP = entry ± TP_mult × ATR.
4. **Trailing + Partial Close** state machine:
   - 1.0R → move SL to breakeven
   - 1.5R → partial close 50% + lock SL at +0.5R
   - 2.0R → trail SL at max_favorable − 1×ATR
   - 3.0R → trail SL at max_favorable − 0.5×ATR (tighter)

   ⚠ Currently the FULL state machine is implemented ONLY in `backtest_engine` (Python simulation).
   `trade_manager.py` on live positions does the 1R → breakeven step only. Closing this gap is
   Phase 4 work; until then live performance will be LOWER than backtest projections.

# Asset Universe Strategy
**Group G1 — Volatile Trending (recommended for live)**:
BTCUSD, ETHUSD, SOLUSD, LTCUSD, XAUUSD, XAGUSD, NAS100, US30, SPX500, USOIL, UKOIL

**Group G2 — Currency Pairs (disabled for now)**:
All *USD, *JPY, *EUR forex pairs. Empirically lose on this Triple Screen strategy (mean-reverting,
not trending). Re-enable only after building a separate mean-reversion strategy variant.

Default `core_assets` setting should be G1 only. Verify via `GET /api/config/assets`.

# Core Rules — NEVER VIOLATE
1. **No hardcoded paths or secrets.** Use `.env`. `MT5_PATH`, `DATABASE_URL`, `MIMO_API_KEY`, `DISCORD_WEBHOOK_URL`.
2. **No hardcoded core_assets.** Fetched from `system_settings.core_assets`.
3. **All trades flow through `app/services/execution_desk.execute_trade()`** — spread + swap + duplicate checks enforced there.
4. **Latency Protection in `app/main.py:_safety_gates_pass()`** — `ping_ms < 1000` checked before every auto-trade.
5. **Volume Filter on H1.** `quant_desk.py` requires `current H1 tick_volume > H1 VMA(20)` before ENTRY.
6. **Triple Screen alignment is mandatory.** D1 and H4 must agree before H1 entry trigger is evaluated.
7. **Kill switch wired.** `auto_trade_enabled` setting gates auto-execution. UI red button posts to `/api/kill-switch`.
8. **Equity, not balance, for lot sizing.** `quant_desk.calculate_lot_size` uses `equity`.
9. **Daily DD limit + max-open-positions** — auto-trade halts when limits hit.
10. **Walk-Forward Validation before deploy.** Any param set must pass OOS test (Robustness ≥ 0.85)
    before being applied via "Apply Winners" button. Optimize page → enable Walk-Forward checkbox.

# Backtest Infrastructure
- OHLC ingested into Postgres `historical_data` table (timeframe column distinguishes D1 / H4 / H1 / M1).
- **Ingest cadence** (set in `main.py` lifespan):
  - D1 daily 00:30 UTC+7
  - H4 every 4h at HH:15
  - H1 hourly at HH:02
  - **M1 every 1 minute (interval job, `id="ingest_m1"`) — added 2026-05-26**
- **Deep backfill caps** (`historical_ingest.INITIAL_BACKFILL`): D1/H4/H1 = 5000 each; M1 = 300000 (~7 months, broker-bounded).
- **Deep backfill endpoint:** `POST /api/historical/deep-backfill` (per-timeframe cap above).
- **Multi-symbol backtest:** `POST /api/backtest` with `symbols: list[str]`.
- **Optimize:** `POST /api/backtest/optimize` — returns `job_id`; poll `GET /api/jobs/{id}`.
  - Parallel via ProcessPoolExecutor (9 workers = 80% of 12 logical cores).
  - `walk_forward: true` splits date range into train/test; returns per-rank `oos_aggregate` + `robustness_score`.
- **Apply Winners:** UI button on each rank row — overwrites `core_assets` with profitable symbols.

# Xiaomi MiMo (LLM) — Informational Use Only
- `mimo-v2.5` — fast NLP (per-class macro briefing, asset recommendation).
- `mimo-v2.5-pro` — deep reasoning (daily reflection, log critique).
- Macro Desk batches by asset class (Forex / Indices / Commodities / Crypto).
- Output goes to `result["reason_economic"]` etc. — **shown in UI, ignored by trade logic.**
- If you want LLM to gate trades, see `app/main.py:_safety_gates_pass` — add the check there,
  but be aware: backtest cannot replay historical LLM outputs reliably.

# Common Commands
- Start full stack: `start_all.bat` (boots uvicorn :8000 + Vite :5173)
- Run DB: `docker-compose up -d` (Postgres :5432 + ChromaDB :8001)
- Daily reflection on-demand: `cd backend && python -m app.services.reflection_desk`
- Deep backfill (UI button on Backtest > Data Status, or): `POST /api/historical/deep-backfill`

# Workflow for Strategy Tuning
1. Apply G1 universe via Settings → Reset, or via "Apply Winners" after an Optimize run.
2. Run Optimize on Backtest > Optimize:
   - Symbols: G1 (11 symbols)
   - Date range: last 6 months (smart calendar auto-fills)
   - Sweeps: SL [0.5, 0.75, 1.0, 1.5], TP [3, 4, 5, 6], RSI_low [40, 45, 50], RSI_high [55, 60]
   - Enable **Walk-Forward Validate** (checkbox)
3. Wait ~2-5 min. Review results table.
4. Pick the highest-rank combo with **Robustness label = "Robust" (OOS PF / IS PF ≥ 0.85)**.
5. Click 🎯 Apply button → confirm.
6. Paper-trade 4 weeks before real capital.

# Known Code Gaps (must respect — see docs/02 §8 and docs/03 §3.11-3.12)

- `trade_manager.py` does breakeven only; full trailing state machine lives in backtest_engine.
  Live ≠ backtest until Phase 4 closes this gap.
- `_today_realized_pnl` in `main.py` uses `d.type in (0, 1)` filter instead of
  `d.entry == DEAL_ENTRY_OUT`. Daily DD gate count is technically wrong but does not
  incorrectly block trades in practice. 1-line fix queued for Phase 4.
- `quant_desk.py` module docstring (lines ~13-29) still cites pre-walk-forward defaults
  (SL 1.5×ATR / TP 3.0×ATR / RSI 40-60). The CODE uses the validated values
  (SL 0.5 / TP 4.0 / RSI 40-55). Docstring update queued for Phase 4.

# Tuning History — Optimization Findings Log

## Run 1 (2026-05-24, walk-forward validated) — current CODE defaults
Window: Oct 2025 - May 2026 (6.7 months), 96 combos × 11 symbols, walk_forward=True

Best Robust combo (rank #5, Robustness 1.125):
  SL=0.5×ATR, TP=4×ATR, RSI 40-55, SMA 20/50, VMA 20

Performance:
  IS:  PF 1.44, +5.55%, 59.3% win rate, 11.84% max DD over 4.5 months train
  OOS: PF 1.62, +3.60%, 57.6% win rate, 13.03% max DD over 2.3 months test
  Robustness: 1.125 (OOS BETTER than IS — strong generalization signal)

**These are the values currently hard-coded as defaults in `quant_desk.py` and `backtest_engine.DEFAULTS`.**

## Run 2 (2026-05-24, in-sample only — NOT YET validated) — finding only
Window: Feb 21 - May 22 2026 (3 months), 2592 combos × 11 symbols, walk_forward=False

Best IS combo (rank #1):
  SL=0.5×ATR, TP=3×ATR, RSI 45-60, SMA 15/50, VMA 20

Performance (in-sample only):
  PF 2.24, +6.87%, 62.7% win rate, 11.89% max DD over 3 months

Architectural finding — **TP is decorative.** Ranks 1-4 share identical stats (PF 2.24, 244 trades,
$7557 P/L) but with TP={3,4,5,6}. Means no trade ever reaches TP — all exits are via
PARTIAL_TP (1.5R), TRAIL_SL, or initial SL. Recommendation: fix TP at one value (e.g. 4) in
future sweeps to save 4x compute.

Edge-of-grid signals:
- SL=0.5 dominates every top-20 combo. If 0.5 was the lower bound of the swept range, true
  optimum may be below 0.5. Next sweep should include [0.25, 0.4, 0.5, 0.75].
- sma_fast=15 dominates every top-20 combo. If 15 was the lower bound, test [10, 12, 15, 20].

**Status:** Run 2 results are NOT walk-forward validated. Do NOT replace code defaults until a
WF-validated run with extended grid (Run 3) confirms or refines these params.

## Run 3 (2026-05-24, walk-forward validated) — extended grid, HEADLINE PF but EDGE-OF-GRID alarm
Window: Nov 1 2025 - May 22 2026 (6.7 months), 576 combos × 11 symbols, walk_forward=True
Duration: 13.9 min at 9 workers

Best Robust combo (rank #2 by OOS PF, Robustness 1.007):
  SL=0.25×ATR, TP=4×ATR, RSI 40-55, SMA 10/60, VMA 15

Performance:
  IS:  PF 4.32, +34.10%, 69.04% win rate, 14.54% max DD, 533 trades over 4.5 months
  OOS: PF 4.35, +12.52%, 65.09% win rate, 16.42% max DD, 212 trades over 2.3 months
  Robustness: 1.007 (OOS slightly better than IS - holds up)

Per-symbol concentration (IS): Indices 57% (US30+SPX500+NAS100), Oil 14%, Crypto 16%, Metals 13%.
LTCUSD slight loss -$204. Top-2 carry 40% of P/L (under 70% fragility threshold).

**EDGE-OF-GRID ALARM — all top 20 combos sit at LOW edge of swept range:**
- sl_atr_mult: 100% of top-20 use 0.25 (lowest in grid). True optimum may be below 0.25.
- vma_period: 90% of top-20 use 15 (lowest in grid).
- sma_fast: most concentrate at 10 (lowest in grid).
- sma_slow: 50% at 40 (lowest in grid).

**Concerns - DO NOT replace code defaults from Run 3 alone:**
1. Trade frequency jumped 12x (Run 1 ~10 trades/month -> Run 3 ~95 trades/month). Strategy
   transitions from swing to day-trading. Execution friction (spread, slippage, requote)
   amplifies linearly with trade count.
2. SL=0.25xATR is TIGHT - typical 15-30 pips on NAS100. Real broker spread 1-3 pips eats
   10-20% of expected move per trade. Backtest may overstate edge.
3. All params at grid edge - suggests overfit to this specific 2025-11-01..2026-05-22 window,
   or true optimum below current bounds. Need Run 4 (extended grid) + Run 5 (monthly
   sensitivity) + Run 6 (spread stress) to disambiguate.

**Status:** Walk-forward VALIDATED, Robust label, OOS PF 4.35 >> Run 1 OOS PF 1.62. But before
deploying, must verify via Run 4-6 below. Code defaults still SL=0.5/TP=4/RSI 40-55 from Run 1.

## Run 4 (2026-05-24, walk-forward validated) - EXTENDED GRID, OVERFITTING ALARM
Window: Nov 1 2025 - May 22 2026 (6.7 months), 1296 combos x 11 symbols, walk_forward=True
Duration: 28.1 min at 9 workers

Best Robust combo (rank #10 by OOS PF, Robustness 1.195):
  SL=0.15xATR, TP=4xATR, RSI 40-60, SMA 5/50, VMA 10

Performance:
  IS:  PF 11.20, +87.55%, 75.8% win rate, max DD ~10%, 538 trades over 4.5 months
  OOS: PF 13.38, +20%+ projected, 75% win rate, 212 OOS trades
  Robustness: 1.195 (OOS BETTER than IS - strong on this window)

EDGE-OF-GRID PATTERN PERSISTS - sweep keeps finding tighter, faster params:
  Run 1: SL=0.5, sma_fast=20, vma=20 -> OOS PF 1.62
  Run 3: SL=0.25, sma_fast=10, vma=15 -> OOS PF 4.35 (at grid edge)
  Run 4: SL=0.15, sma_fast=5, vma=10 -> OOS PF 13.38 (still at grid edge)

This pattern is the SIGNATURE OF OPTIMIZATION OVERFITTING. Each grid extension finds tighter
params with higher backtest PF. Backtest doesn't model real execution friction:
  - SL=0.15xATR = ~5-10 pips on NAS100
  - Spread = 1-3 pips on NAS100 = 10-30% of SL
  - Slippage at stop-out = 1-3 more pips
  - Backtest assumes constant spread + linear slippage; reality has variance + requote events

Tracking issue: the optimization is finding a strategy that backtests well by exploiting the
SPECIFIC noise pattern of the 2025-11-01..2026-05-22 window. The faster the SMA + tighter
the SL, the more the strategy can fit that noise.

**STATUS:** Run 4 walk-forward VALIDATED but DO NOT DEPLOY. PF 13 is overfit signature, not
deployable edge. Run 5 (monthly sensitivity) + Run 6 (spread stress) on BOTH Run 3 and Run 4
params will determine which (if either) survives realistic conditions.

Decision rule:
  - If Run 6 spread-2x PF stays above 2.5 for either set -> that set is deployable
  - If Run 6 spread-2x drops below 1.5 for both -> both overfit, keep Run 1 defaults
  - If Run 5 monthly PF varies wildly (any month < 1.0) -> not robust across regimes

## Run 5 (2026-05-24) - monthly sensitivity test

Tested Run 3 rank 2 + Run 4 rank 10 params on each month Nov 2025 - Apr 2026 separately:

| Set        | avg PF | range PF    | months > 1.5 | months < 1.0 | Verdict |
|---         |---     |---          |---           |---           |---     |
| Run3_rank2 | 4.54   | 1.53 - 6.27 | 6/6          | 0            | PASS   |
| Run4_rank10| 10.70  | 5.39 - 16.46| 6/6          | 0            | PASS   |

Both PASS — no month with PF < 1.0. But monthly PF varies 3x for both, indicating high
regime sensitivity. Lowest PF in Nov 2025 for both (early window edge effect).

## Run 7 (2026-05-24) - per-asset-class optimization

When optimizer searches each asset class SEPARATELY (instead of all symbols at once), ALL
4 classes converge to SL=0.25 (Run 3 winner), NOT 0.15 (Run 4 winner):

| Class       | SL   | sma fast | sma slow | vma | RSI    | IS PF | OOS PF | Robust | Label    |
|---          |---   |---       |---       |---  |---     |---    |---     |---     |---       |
| crypto (4)  | 0.25 | 20       | 40       | 15  | 45-55  | 3.02  | 6.37   | 2.109  | Robust   |
| indices (3) | 0.25 | 10       | 50       | 15  | 40-55  | 10.65 | 5.43   | 0.510  | Marginal |
| metals (2)  | 0.25 | 15       | 40       | 20  | 40-60  | 4.39  | 4.16   | 0.948  | Robust   |
| oil (2)     | 0.25 | 10       | 50       | 20  | 40-55  | 2.99  | 3.59   | 1.201  | Robust   |

**Conclusion: Run 4 params (SL=0.15, sma=5, vma=10) NOT picked by any class in isolation.**
The all-symbol Run 4 sweep was inflated by cross-class interactions. Per-class is more honest.

Indices' Marginal label (Robustness 0.51) flags it as the OVERFIT-PRONE class. IS PF 10.65
vs OOS 5.43 = OOS half of IS = classic signature.

Future enhancement (Phase 5+): per-class strategy variants. Could outperform universal Run 3
by 20-40% in IS but would need separate walk-forward validation per class.

## Run 8 (2026-05-24) - TRUE HOLD-OUT TEST (DECISIVE)

Tested Run 3 + Run 4 params on a window the optimizer NEVER saw: 2025-08-01 to 2025-10-31
(3 months BEFORE Run 1-4's training window). 7 non-crypto symbols (crypto H1 data starts
late Oct 2025).

| Set         | Train OOS PF | Holdout PF | Ratio | Verdict   |
|---          |---           |---         |---    |---        |
| Run3_rank2  | 4.35         | 4.14       | 0.952 | PASS      |
| Run4_rank10 | 13.38        | 7.15       | 0.534 | MARGINAL  |

**THIS IS THE DECISIVE EVIDENCE:**
- Run 3 holdout PF 4.14 ≈ train PF 4.35 (95% transfer) -> EDGE IS REAL
- Run 4 holdout PF 7.15 vs train PF 13.38 (53% transfer) -> ~50% degradation = OVERFIT

Run 4 still profitable on holdout (PF 7) but lost half its backtest edge. With further OOS
windows, expect further drift. Run 3 stays stable.

## FINAL RECOMMENDATION FROM RUN 1-8 ANALYSIS

| Test          | Run 3 (SL=0.25, sma 10/60, vma 15) | Run 4 (SL=0.15, sma 5/50, vma 10) |
|---            |---                                  |---                                 |
| Walk-forward  | OOS PF 4.35, Robust 1.007           | OOS PF 13.38, Robust 1.195         |
| Monthly sens  | PF range 1.5-6.3 across 6 months    | PF range 5.4-16.5 across 6 months  |
| Spread 2x     | PF 3.55 (PASS)                       | PF 9.59 (PASS but suspicious)      |
| Per-class     | Picked by 0/4 classes verbatim       | Picked by 0/4 classes              |
| Hold-out      | Ratio 0.95 (PASS)                    | Ratio 0.53 (MARGINAL)              |

**VERDICT:** Replace Run 1 code defaults with Run 3 rank 2 params.

Updated CODE defaults to apply (NEEDS BOOTH APPROVAL):
```
sl_atr_mult: 0.25     (was 0.5)
tp_atr_mult: 4        (unchanged)
rsi_entry_low: 40     (unchanged)
rsi_entry_high: 55    (unchanged)
sma_fast_period: 10   (was 20)
sma_slow_period: 60   (was 50)
vma_period: 15        (was 20)
```

Projected live performance (with realistic execution degradation -30%):
- Run 1 backtest 1.6 PF -> live ~1.1-1.3 PF -> minimal edge
- Run 3 backtest 4.0 PF -> live ~2.5-3.0 PF -> good edge
- ~3-5% per month sustained at risk_percent 0.5%, max DD ~10-13%

DO NOT use Run 4 params. Hold-out test conclusively shows they don't transfer.

## Run 6 (2026-05-24) - spread stress test

Tested both param sets across cost multipliers (baseline 2.0 pips / +50% / 2x / 3x):

| Set         | Baseline PF | 2x cost PF | Degradation | Verdict |
|---          |---          |---         |---          |---     |
| Run3_rank2  | 4.37        | 3.55       | 18.8%       | PASS   |
| Run4_rank10 | 12.58       | 9.59       | 23.8%       | PASS   |

Both survive 2x cost. Run 4 absurdly high PF persists even at stress.

**Interpretation:** Run 6 does NOT FAIL Run 4 - but absence of fail is not proof of work.
Backtest spread + slippage model may UNDERESTIMATE real execution friction (news events,
requotes, weekend gaps not modeled). PF 9+ at 2x cost is suspicious -- treat with skepticism.

**Decision so far:**
- Run 3 params (PF 4.35 OOS, PF 3.55 at 2x cost) = conservative deployable candidate
- Run 4 params (PF 13.38 OOS, PF 9.59 at 2x cost) = aggressive, suspicious, defer

Next: Run 7 (per-asset-class) - if all classes converge to similar params, Run 4 is more
likely real. If classes diverge significantly, params are window-specific.

# Tuning Backlog

- **Run 4 (DONE 2026-05-24):** Extended grid below Run 3 edges.
  SL [0.15, 0.20, 0.25, 0.30], TP fixed at 4, RSI_low [35, 40, 45], RSI_high [50, 55, 60],
  sma_fast [5, 7, 10, 12], sma_slow [30, 40, 50], vma [10, 12, 15]. = 1296 combos, walk-forward.
  Goal: Find true optimum below Run 3 edges, or confirm Run 3 edges ARE the optimum.

- **Run 5 (planned):** Monthly sensitivity test of Run 3 rank 2 (best Robust) params on each
  month separately Nov-2025 to Apr-2026. Goal: detect if PF 4.35 is consistent or driven by 1-2
  lucky months. If 1+ month has PF < 1.5, params are fragile to regime.

- **Run 6 (planned):** Spread stress test - re-run Run 3 rank 2 with cost assumption x2. If PF
  drops below 1.5, params are spread-sensitive (concerning at SL=0.25). If PF stays > 2.5,
  robust to execution friction.

- **Run 7 (planned):** Per-asset-class optimization. Split G1 into crypto / indices / metals /
  oil and find best params per class. Crypto (high volatility) may favor different params than
  indices (lower volatility).

- **Run 8 (planned):** Rolling walk-forward - 3 sub-windows with rolling train/test, instead
  of single 67/33 split. More robust statistical evidence of param stability.

Strictly follow these rules when generating or modifying code for this repo.
