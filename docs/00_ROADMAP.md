# AlgoTrade — Master Roadmap

Last updated: 2026-05-24
Status: Living doc. Reorder + edit phases as priorities change.

This is the authoritative roadmap from "validated backtest" -> "production real-money system."
Each phase has: goal, deliverables, exit criteria, effort estimate, risks, dependencies.

---

## Phase summary at-a-glance

| # | Phase | Effort | Status | Gate to next |
|---|---|---|---|---|
| 0 | Backtest Validation | DONE | done 2026-05-24 | Run 3 params verified deployable |
| 1 | Live Trading Parity | ~5 hrs | next | Live behavior == backtest 1:1 |
| 2 | Demo Forward Test ($10k) | 4 weeks passive | blocked by P1 | 4-metric pass criteria |
| 3 | Cent Account ($100 real) | 4 weeks passive | blocked by P2 | sustain edge under real execution |
| 4 | Operational Resilience | ~10 hrs | parallel to P2 | system survives crashes/network |
| 5 | Strategy Hardening | ~15 hrs | parallel to P2/P3 | risk gates fully wired |
| 6 | Real Money Scaling | 6+ months passive | blocked by P3 | each tier passes |
| 7 | DevOps + CI/CD | ~20 hrs | parallel to P3+ | git + tests + auto-restart |
| 8 | Advanced Features | open | optional | only if simple system stable first |
| 9 | Public Release | ~10 hrs | optional | only after 6+ months sustained profit |

Total minimum path to real money: **P1 + P2 + P3 = ~5 hrs + 8 weeks** before first $500.

---

## Phase 0 — Backtest Validation ✓ DONE

**Goal:** Establish whether the Triple Screen + Trailing strategy has a real, deployable edge.

**Deliverables (all done 2026-05-24):**
- 11 G1 symbols universe defined + tested
- Walk-forward backtest engine with parallel workers (9-core, 80% CPU)
- Run 1-8 completed:
  - Run 1: Walk-forward 96 combos → SL=0.5 PF 1.62 OOS (baseline)
  - Run 2: 2592-combo IS-only → found TP-decorative + edge-of-grid
  - Run 3: 576-combo WF extended → SL=0.25 PF 4.35 OOS (deploy candidate)
  - Run 4: 1296-combo WF deeper → SL=0.15 PF 13.38 OOS (overfit alarm)
  - Run 5: Monthly sensitivity x2 sets → both PASS
  - Run 6: Spread stress 4x cost → both PASS
  - Run 7: Per-asset-class x4 → all classes pick SL=0.25 (rejects Run 4)
  - Run 8: True hold-out pre-optimizer window → Run 3 transfers 95%, Run 4 overfits 53%

**Verdict:**
- **Deploy Run 3 params** (SL=0.25, sma 10/60, vma 15, RSI 40-55, TP 4)
- **Reject Run 4 params** (overfit confirmed by hold-out test)

**Exit criteria:** ✓ Met — chosen params have backtest PF 4.35 OOS, 95% hold-out transfer.

**See:** CLAUDE.md Tuning History, docs/01 §5, run3_result.json through run8_result.json.

---

## Phase 1 — Live Trading Parity

**Goal:** Make live trade behavior match backtest exactly. Currently `trade_manager.py` only does breakeven; backtest engine does full 4-stage state machine. This mismatch invalidates any live-vs-backtest comparison.

**Why this matters:** Without parity, Phase 2 demo trades can't be evaluated against backtest expectation. We'd be flying blind.

### Deliverables

**1.1 Full 4-stage trailing state machine in `trade_manager.py`** (~2 hrs)

Port `backtest_engine._advance_trailing` to live trade management:
- Track `max_favorable_price` per position (DB-persisted)
- 1.0R → SL to breakeven
- 1.5R → partial close 50% + lock SL at +0.5R
- 2.0R → SL trail at max_fav − 1×ATR
- 3.0R → SL trail at max_fav − 0.5×ATR (tighter)
- Continuous trail in stage 3+ (catches new highs)

Schema migration: extend TradeState with `initial_sl_distance`, `max_favorable`, `trail_stage`, `partial_closed`, `entry_atr`, `initial_volume`.

Pattern: see `docs/04_PHASE_4_IMPLEMENTATION.md` for ready-to-apply code.

**1.2 Wire SL modify + partial close through `execution_desk`** (~30 min)

New helpers:
- `modify_position_sl(ticket, symbol, new_sl, current_tp)` → `mt5.TRADE_ACTION_SLTP`
- `partial_close_position(ticket, symbol, volume)` → `mt5.TRADE_ACTION_DEAL` opposite side, half lot

Maintain "all MT5 calls flow through execution_desk" invariant.

**1.3 DD count bug fix in `_today_realized_pnl`** (~5 min)

`main.py:130-139` filter `d.type in (0, 1)` → `d.entry == mt5.DEAL_ENTRY_OUT`.

**1.4 Update `quant_desk` module docstring** (~10 min)

Replace stale SL 1.5 / TP 3.0 / RSI 40-60 with current SL 0.25 / TP 4.0 / RSI 40-55.

**1.5 Trade journal write hooks** (~30 min)

- `execution_desk.execute_trade` writes TradeJournalEntry row on successful order
- `trade_manager._manage_one` updates row on close + partial close
- Captures: signal context (D1/H4/H1 state), entry/exit prices, slippage, R-multiple, exit reason

**1.6 Equity snapshot scheduled job** (~20 min)

`scheduler.add_job(capture_snapshot, 'cron', hour='0,4,8,12,16,20', minute=2)` writes equity, balance, free_margin, daily_pnl every 4 hours.

**1.7 Manual demo verification** (~1 hr)

- Open demo account, set risk_percent 0.5%
- Force one ENTRY signal (or wait for natural signal)
- Watch trade lifecycle in `trade_journal` table:
  - Verify partial close fires at 1.5R
  - Verify SL moves to breakeven at 1.0R
  - Verify trail follows max_favorable in stage 3/4
- Compare side-by-side with backtest on same input window

### Exit criteria
- [ ] At least 1 demo position cycles through all 4 trailing stages successfully
- [ ] At least 1 demo position exits via partial close + trail (not initial SL or TP)
- [ ] Trade journal row matches MT5 history exactly for that trade
- [ ] Backtest engine vs live behavior diverge < 5% on identical fixture window

### Effort + Risks

**Total:** ~5 hours focused work.

| Risk | Mitigation |
|---|---|
| Schema migration drops trade_states with open positions | Drain positions (close manually) before migration. Document cutover. |
| Partial close fails (broker rejects half-volume) | Log + skip stage 2. Don't crash manager. |
| SL modify rate-limit by broker | Add 200ms throttle between modify calls. |
| max_favorable not updated between scheduler ticks | Currently hourly. Consider 15-min interval if crypto volatility demands. |

### Dependencies
- None — Phase 0 done.

---

## Phase 2 — Demo Forward Test ($10k)

**Goal:** Validate that live execution actually matches backtest projection under real market conditions (but on demo account, no money at risk).

### Setup (Day 1)
- Open IUX demo account, $10,000 USD
- core_assets = G1 (11 symbols)
- risk_percent = 0.5% (conservative for first live test)
- max_open_positions = 3
- daily_dd_limit = 5%
- auto_trade_enabled = true
- kill switch ready (UI button + ssh fallback)

### Runtime (4 weeks)
- Uninterrupted run
- No parameter changes
- No manual position closes
- Weekly metric snapshot (script-driven, write to weekly_metrics table)

### Metrics tracked (auto via trade journal + equity snapshot)
- Total trades, win rate, profit factor
- Per-symbol P/L breakdown
- Exit reason distribution (% partial / % trail / % initial SL / % TP)
- Avg slippage at entry/exit vs assumed 1 pip
- Avg R-multiple at exit
- Max drawdown observed
- Daily P/L history

### Exit criteria (all 4 must pass)

| Metric | Pass threshold | Why |
|---|---|---|
| Live PF | ≥ 0.7 × backtest PF (= 3.0 if Run 3 deployed) | Real edge survives |
| Win rate | ≥ 0.85 × backtest WR (= ~55% if Run 3) | Signal quality matches |
| Max DD | ≤ 1.5 × backtest max DD (= ~25%) | Risk control works |
| Trade count | ≥ 0.6 × projected (~50-80 trades/4wk) | Not idle |

Bonus check (not gate): no order rejections > 5% of attempts.

### Effort
- Setup: ~2 hours (account + initial config)
- Monitoring: passive, ~30 min/week (review weekly metrics)
- Total active time: ~4 hours over 4 weeks

### Risks

| Risk | Mitigation |
|---|---|
| Demo broker has idealized spread vs real | Run 6 spread stress already tests this. Demo is upper bound on edge. |
| Phase 1 bugs surface (state machine edge case) | Pause + diagnose. Don't push through. |
| Market regime shift mid-test | Acceptable. The point of forward test is to test in ANY regime. |
| Booth manually intervenes (closes a position) | DON'T. Each intervention invalidates the test. |

### Dependencies
- Phase 1 done (live trailing parity)

---

## Phase 3 — Cent Account Real Money ($100)

**Goal:** Validate that real-broker execution (different from demo) doesn't degrade edge below threshold. Real money triggers real psychology + real spread behavior.

### Setup (Day 1 after P2 passes)
- IUX cent account, $100 USD = 10,000 cents
- core_assets = G1 (11 symbols, verify all available on cent)
- risk_percent = 0.5% (same as P2)
- max_open_positions = 2 (reduced — capital is small)
- daily_dd_limit = 5%
- Verify min lot allows risk 0.5% on $100 (calculator: $0.50 risk per trade / point value)

### Runtime (4 weeks)
- Same protocol as P2
- Different broker server = different spread + slippage behavior
- Real money psychology: NO emotional interventions

### Metrics
- Same as P2 plus:
  - Slippage delta: cent broker vs demo (expect cent worse)
  - Spread delta: cent broker vs demo
  - Order rejection rate (expect higher on cent than demo)

### Exit criteria (all 4 must pass)
Same as P2 thresholds (live PF / WR / DD / trade count).

Plus:
- Live slippage average ≤ 2× the 1-pip backtest assumption
- Order rejection rate < 5%
- No critical bugs (orders without SL, double-fills, etc.)

### Effort
- Setup: ~2 hours (account opening + funding + first trade verification)
- Monitoring: ~30 min/week
- Total: ~4 hours over 4 weeks

### Risks

| Risk | Mitigation |
|---|---|
| Cent broker doesn't have all G1 symbols | Drop unavailable, document in pre-flight |
| Min lot on cent excludes risk 0.5% | Increase risk to 1% if needed (caps loss at $1/trade still) |
| Cent broker spread 3-5x demo | Acceptable IF PF still > 1.5. Below that = no edge in cent reality |
| Real money triggers manual intervention | Discuss with self before test: rules are NO closes, NO pauses |

### Dependencies
- Phase 2 passed
- Cent broker selected + verified (IUX confirmed)

---

## Phase 4 — Operational Resilience

**Goal:** System survives crashes, restarts, network blips, OS reboots. Currently a single PC reboot = trading dead until manual restart.

### 4.1 NSSM Windows service auto-restart (~2 hrs)
- Install NSSM (Windows service wrapper)
- Wrap uvicorn as `AlgoTradeBackend` service
- Wrap vite/static-server as `AlgoTradeFrontend` service (or pre-build + nginx)
- Configure: auto-restart on crash (5s delay), log rotation, start at boot

### 4.2 Watchdog process (~1 hr)
- Separate small Python script `scripts/watchdog.py` as another NSSM service
- Every 60s: hit `/api/health/deep`
- After 3 consecutive failures: Discord alert
- After 10 consecutive failures: `nssm restart AlgoTradeBackend`
- Log all events to `watchdog.log`

### 4.3 Postgres backup (~30 min)
- Windows Task Scheduler at 03:00 daily
- `pg_dump -U postgres -d hedgefund_cfd -F c -f "D:\backups\hedgefund_cfd_$(date).dump"`
- Retention: 14 days local + optional cloud (S3/Backblaze) for off-site

### 4.4 Discord alerting expansion (~2 hrs)
Current: only trade signal notifications.

Add:
- Process start/stop (system boot, manual restart, crash)
- MT5 disconnect > 60s
- Kill switch fired
- Daily DD limit hit
- Trade opened
- Trade closed (with exit_reason, R, P/L)
- Weekly summary (every Sun 18:00: trades, PF, WR, DD)
- Watchdog alerts (3 / 10 health failures)

Each alert: appropriate color + actionable text.

### 4.5 Structured logging (~1 hr)
- Switch from `logging.info` to `loguru` with JSON sink
- Output: `logs/algotrade-2026-05-24.jsonl` rotating daily
- Each line: timestamp, level, logger, message, context_dict
- Enables `grep` + `jq` debugging

### 4.6 Health check endpoint hardening (~30 min)
Currently `/api/health/deep` returns OK/fail per system. Extend:
- Add `last_scheduler_run` per job (not just next_run)
- Add `pending_orders_count`
- Add `mt5_terminal_uptime_hours`
- Add `app_memory_mb` (psutil)
- Add `disk_free_gb` on data drive

### Exit criteria
- [ ] PC reboot test: power cycle → both services up within 60s, MT5 reconnects, scheduler runs
- [ ] Crash test: `Stop-Process -Id <uvicorn>` → service auto-restarts within 10s
- [ ] Network blip test: disconnect WiFi 60s → reconnect → MT5 reconnects, no orphan positions
- [ ] Backup verified: restore yesterday's dump on a test DB → row count matches
- [ ] Discord alert test: trigger each alert manually → all fire correctly

### Effort
- Total: ~10 hours focused work
- Can parallelize with Phase 2 demo run (most of this doesn't affect live trades)

### Risks

| Risk | Mitigation |
|---|---|
| NSSM service restart loop (if startup fails fast) | Configure restart delay 5s + max 3 restarts in 60s before pausing |
| Postgres backup fills disk | Retention policy 14 days. Monitor disk_free_gb. |
| Discord rate limit (too many alerts) | Group similar events. Throttle: max 1 alert / 10 sec / category. |

### Dependencies
- Phase 1 done (so we're alerting on real trade activity)
- IUX demo account active (for end-to-end alerts test)

---

## Phase 5 — Strategy Hardening

**Goal:** Make risk management bulletproof. Currently we have basic kill switch + max positions + DD limit. Real production needs more layers.

### 5.1 Correlation-aware position sizing (~3 hrs)
- BTCUSD + ETHUSD + SOLUSD correlation typically 0.7-0.9
- Opening 3 crypto longs = 3x crypto exposure, NOT 3 diversified trades
- Implementation: rolling 30-day correlation matrix, scale lot size DOWN when adding correlated positions
- Schema: add `correlation_matrix` table (symbol_a, symbol_b, corr, computed_at)

### 5.2 News blackout filter (~3 hrs)
- Major events (NFP, FOMC, CPI, ECB, BOJ rate decision) cause 30-60 min of chaos
- Solution: economic calendar API (Investing.com free tier, FXStreet free)
- Logic: pause new ENTRIES ±60 min of HIGH-impact events
- Schema: `economic_events` table (time, country, impact_level, event_name)
- Daily cron fetches next 7 days events at 00:00 UTC

### 5.3 Circuit breaker — consecutive losses (~1 hr)
- Track consecutive losing trades across all symbols
- ≥5 consecutive losses → auto pause auto_trade_enabled for 24 hours
- Discord alert when fired
- Resets manually (kill switch UI button) or auto after 24h

### 5.4 Weekend swap handling (~1 hr)
- Track per-symbol swap rate (positive/negative, daily) from MT5
- Exclude trades that enter Fri 18:00+ UTC with NEGATIVE swap
  - (Negative swap > some threshold, since 1-day = ~3-day swap on Fri due to weekend)
- Allow if swap is positive (income, not cost)
- Schema: add `swap_long`, `swap_short`, `swap_3day_friday` to symbol_meta

### 5.5 Max daily trade count cap (~30 min)
- Cap 8 trades/day across all symbols (configurable)
- Hard-fail safety net for scanner bug that floods orders
- Reset at 00:00 UTC daily

### 5.6 Per-asset-class param branches (~5 hrs, optional)
From Run 7 we know each class has slightly different optimum:
- crypto: SL=0.25, sma 20/40, vma=15, RSI 45-55
- indices: SL=0.25, sma 10/50, vma=15, RSI 40-55 (Marginal — caution)
- metals: SL=0.25, sma 15/40, vma=20, RSI 40-60
- oil: SL=0.25, sma 10/50, vma=20, RSI 40-55

Implementation: per-symbol param override map. Defaults stay as Run 3 universal, overrides applied per asset class.

Run separate walk-forward validation per class periodically (Sprint S5).

### 5.7 Slippage + commission empirical recalibration (~2 hrs)
- Track real slippage per trade (entry / exit) in trade_journal
- Weekly cron: compute median slippage per symbol over last 30 days
- Update `backtest_engine._cost` assumption from empirical data
- Recompute backtest projection with refreshed costs

### Exit criteria
- [ ] Correlation matrix populated for all G1 pairs
- [ ] News blackout filter pauses trades during a confirmed FOMC announcement
- [ ] Circuit breaker test: simulate 5 losses → auto-pause fires
- [ ] Weekend swap rule tested: Friday afternoon BUY on negative-swap symbol → skipped
- [ ] Max daily count enforced: 9th trade rejected with clear log

### Effort
- Core (5.1, 5.2, 5.3, 5.5): ~7 hours
- Optional (5.4, 5.6, 5.7): ~8 hours
- Can parallelize with Phase 2/3

### Risks

| Risk | Mitigation |
|---|---|
| News API rate limit / outage | Cache 7 days ahead. If fetch fails, use last-known calendar. |
| Correlation matrix gets stale | Recompute daily 00:00 UTC. Alert if stale > 48h. |
| Circuit breaker false positive (5 normal losses in row) | Acceptable — pause for 24h, manual resume after review |

### Dependencies
- Phase 1 done (trade journal populated)
- Demo account active (for live correlation data)

---

## Phase 6 — Real Money Scaling

**Goal:** Scale from cent test to real capital, gradually, with proof at each tier.

### Tier progression

| Tier | Equity | risk% | max positions | Min duration | Pass criteria |
|---|---|---|---|---|---|
| **A** Cent | $100 | 0.5% | 2 | 4 weeks | P2/P3 criteria |
| **B** Micro real | $500-1000 | 0.5% | 2 | 8 weeks | sustained PF ≥ 1.5 |
| **C** Standard real | $2000-5000 | 0.75% | 3 | 12 weeks | PF ≥ 1.5 + DD ≤ 1.3x backtest |
| **D** Scale up | $5000-20000 | 1.0% | 3 | 6 months | sustained 3-month rolling profit |
| **E** Capital | $20000+ | 1.0% (max) | 4 | ongoing | per-quarter performance review |

### Per-tier protocol
1. Open account at chosen tier
2. Run uninterrupted for min duration
3. Compute live metrics at end of period
4. Compare to backtest projection (with degradation factor ~0.7-0.8)
5. If PASS → next tier (after 1 week pause to think)
6. If MARGINAL → extend another period before moving up
7. If FAIL → step back to previous tier OR pause + diagnose

### Cross-tier considerations
- Different brokers may have different spread/slippage profiles. Test the BROKER first, not just the strategy.
- Tax implications grow with capital. Track gross + net P/L separately.
- Psychology: $10k loss feels different from $100 loss. Pre-commit to rules.

### Exit criteria (per tier)
- Same 4-metric pass thresholds as Phase 2/3
- Plus: live PF ≥ 0.7 × backtest PF SUSTAINED across the full duration

### Effort
- Active per tier: ~4 hours over min duration
- Total path to Tier D: ~30 weeks (~7 months)

### Risks

| Risk | Mitigation |
|---|---|
| Market regime change kills strategy mid-tier | Plan: pause, run rolling WF on recent data, decide stay/exit |
| Broker freezes account (suspicious activity) | Have backup broker ready. Don't put all eggs in one. |
| Strategy decays over time | Quarterly re-validation (rerun walk-forward on latest data) |
| Booth psychological burnout | Build in mandatory week-off every 8 weeks |

### Dependencies
- Phase 3 (cent) passed
- Phase 4 (resilience) ideally done before Tier B
- Phase 5 (risk gates) ideally done before Tier C

---

## Phase 7 — DevOps + CI/CD

**Goal:** Reduce "Booth needs to be at PC" tax. Build automated checks + recovery so the system runs itself.

### 7.1 Git + GitHub private repo (~1 hr)
- `git init` in project root
- `.gitignore` for venv/, node_modules/, .env, *.dump, run*_result.json
- Push to private GitHub repo `algotrade-hedgefund`
- Branch protection: main requires PR (even if solo)

### 7.2 GitHub Actions CI (~3 hrs)
Per `docs/05_CICD_BLUEPRINT.md`:
- Backend: ruff lint + mypy + pytest on PR
- Frontend: eslint + tsc + vite build on PR
- Required for merge to main

### 7.3 Unit + integration tests (~10 hrs)
Priority test suite (per docs/05 §2.1):
- `quant_desk.compute_indicators` (math correctness)
- `backtest_engine._cost` (was a 10x bug — high value)
- `backtest_engine._advance_trailing` (state machine)
- `execution_desk` (mocked MT5, placement + duplicate check)
- `main._safety_gates_pass` (kill switch path)
- Integration: `run_backtest_multi` on fixture → snapshot compare

### 7.4 Scheduled jobs in CI (~3 hrs)
- Nightly data health check (Postgres rows + last ingest)
- Weekly walk-forward optimize (cron via GitHub Actions, polls Booth's API)
- Daily smoke test (hit /api/health/deep, alert on fail)

### 7.5 Code review process (~optional)
If solo: PR self-review checklist (paste into PR description).
If team grows: 1 reviewer required.

### Exit criteria
- [ ] CI runs on every PR, fails on lint/type/test errors
- [ ] At least 30 unit tests covering critical paths
- [ ] Nightly data health check fires Discord alert on any anomaly
- [ ] Weekly optimize report uploaded to GitHub artifacts every Sunday

### Effort
- Total: ~20 hours
- Can parallelize with Phase 4/5

### Risks

| Risk | Mitigation |
|---|---|
| GitHub Actions free tier limit (2000 min/mo) | Optimize: cache pip + npm. ~50 min/PR ~= 40 PRs/mo. Adequate. |
| Test fixtures drift from production behavior | Refresh snapshots quarterly |
| Pre-commit hooks slow down commits | Use lightweight checks only (ruff fast mode + tsc --noEmit) |

### Dependencies
- None — parallel to other phases

---

## Phase 8 — Advanced Features

**Goal:** Beyond the simple Triple Screen strategy. Only attempt these AFTER simple system has proven sustainable profit for 6+ months.

### 8.1 Mean-reversion strategy variant (~20 hrs)
- For forex pairs (G2) — empirically lose on Triple Screen
- Bollinger Band touches + RSI divergence + lower TF confirmation
- Separate backtest engine entry point
- Per-strategy capital allocation (e.g. 70% Triple Screen, 30% Mean Reversion)

### 8.2 Regime detection (~10 hrs)
- Detect Trending / Ranging / Volatile / Quiet regimes
- Use ATR percentile + 20-day price range / 20-day ATR ratio
- Pause strategies that don't fit current regime
- Switch capital allocation based on regime

### 8.3 Rolling walk-forward (~5 hrs)
- Instead of single 67/33 split: 3-5 sliding windows
- Each window: train + test + rolling forward by 1 month
- More statistical weight on robustness
- Auto-flag params that pass single-WF but fail rolling-WF

### 8.4 LLM-gated trades (~15 hrs, controversial)
Per CLAUDE.md: LLM is informational only. To gate trades, would need:
- Modify `_safety_gates_pass` to read MiMo macro_badge
- BUT: backtest can't replay historical LLM outputs reliably
- Live-vs-backtest gap reopens

Recommended: only attempt if base strategy is profitable AND LLM gate can be A/B tested live (1 week with, 1 week without).

### 8.5 Cloud VPS migration (~10 hrs)
Trigger conditions:
- Booth's PC needs to be off (travel, repair)
- Capital growth justifies $30/month VPS cost
- Tier C+ capital

Setup:
- AWS EC2 Windows Spot or Vultr Windows
- Install MT5, log in to broker
- RDP from anywhere for occasional checks
- Tailscale to keep network simple
- Backup strategy adapts (cross-region copy)

### Exit criteria
Optional, no hard gate. Pick features that align with current need.

### Effort
- Each item 5-20 hrs. Total Phase 8 could be 60+ hrs.

### Dependencies
- Phase 6 Tier C or higher (system is making real money sustainably)

---

## Phase 9 — Public Release (optional)

**Goal:** Open-source the repo if/when Booth wants portfolio piece or collaboration. NOT a goal in itself.

Per `docs/06_PUBLIC_REPO_CHECKLIST.md`:

### Pre-flight gate
- [ ] Secret scan (trufflehog + detect-secrets) returns 0 matches
- [ ] No personal paths/emails in any file
- [ ] No broker account numbers
- [ ] No Discord webhook URLs
- [ ] LICENSE file added (MIT or Apache 2.0)
- [ ] README rewritten for external audience
- [ ] DISCLAIMER prominent (NOT financial advice)
- [ ] .env.example complete

### Decision factors
- ✓ Code is genuinely sustained-profitable (6+ months track record)
- ✓ Booth has time + interest for community
- ✗ Don't open while still actively iterating (stranger eyes during dev = distraction)
- ✗ Don't open if it kills competitive edge

### Effort
- Initial cleanup + audit: ~6 hrs
- Ongoing maintenance (issues + PRs): ~30 min/week

### Dependencies
- Phase 6 Tier D (long-term sustained profit) recommended

---

## Cross-cutting concerns

### Documentation updates per phase
Each phase ends with:
- Update CLAUDE.md (anything new in coding rules / Tuning History)
- Update docs/01 (business requirements if scope changed)
- Update memory `current-state.md`
- Generate session report if backtest involved
- Move completed items from this roadmap to "done"

### Booth's time commitment
- Phase 1-3: ~30 hrs active work over 10 weeks (mostly P1 setup + weekly reviews)
- Phase 4-7: ~50 hrs spread over 6 months (mostly optional, prioritize by need)
- Phase 8-9: open-ended, only when other phases are done

### What NOT to do (anti-roadmap)
- Don't skip P1 to start P2 — backtest comparison invalid without parity
- Don't increase risk_percent above 1% even after Tier C — geometric DD risk
- Don't optimize during live trade (any param change = reset test clock)
- Don't add forex G2 without separate strategy (P8.1)
- Don't go to next tier without explicit pass — emotional momentum is the killer
- Don't add LLM gating before strategy is profitable on technical alone
- Don't open public repo during active dev (P9)

---

## Tracking + revisions

This roadmap is a living document. Update on:
- Phase completion → mark done, summarize lessons
- Phase failure → analyze, revise plan, set new exit criteria
- Market regime shift → reassess timeline (faster scaling vs hold)
- New idea/feature → add as Phase X.Y, don't replace existing
- Booth's bandwidth change → reorder priorities

Review cadence: weekly during P1-P3 (active dev), monthly thereafter.

Last review: 2026-05-24 (post-Run-1-to-8 backtest validation, initial roadmap creation)
