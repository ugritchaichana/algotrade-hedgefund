# Business Requirements & Strategy
**System**: AlgoTrade HedgeFund v2.1

## 1. Project Vision
Build a fully autonomous trading system that connects to MetaTrader 5, scans G1 (volatile trending) assets, and places pending limit orders based on Triple Screen Multi-Timeframe trend-following logic. Backtest + Walk-Forward validation are mandatory before any param set is deployed live.

**LLM is an informational layer, not a decision-maker.** This is a pure technical algo system.

## 2. Realistic Expectations

| Annualized Return | Monthly Equivalent | Realistic For |
|---|---|---|
| 10% | 0.8% | S&P 500 passive |
| 15-25% | 1.2-2% | Skilled algo, Buffett-tier |
| 25-50% | 2-4% | Top hedge fund |
| 50-100% | 4-6% | World-class quant (Renaissance) |
| **791% (20%/mo)** | **20%** | **Mathematically infeasible long-term — will blow up** |

This system targets the **15-30% annualized** range. Anyone expecting 20%/month is misinformed about market reality.

## 3. Strategy — Triple Screen + Trailing

### 3.1 Three-Timeframe Alignment (mandatory)

1. **D1 macro trend** — SMA(20) and SMA(50) on Daily candles.
   - Bullish: `close > SMA20 > SMA50`
   - Bearish: `close < SMA20 < SMA50`
   - Sideways: anything else (no trade)

2. **H4 medium-term confirmation** — SMA(20/50) on 4-hour candles.
   - Must EQUAL the D1 trend label.
   - If D1 = Bullish and H4 = Bearish → WAITING (no trade).
   - If either = Sideways → WAITING.

3. **H1 entry trigger** — only if D1 and H4 BOTH agree (Bullish-Bullish OR Bearish-Bearish).
   - RSI(14) in entry zone [default: 40-55]
   - tick_volume > VMA(20) on H1
   - Place pending LIMIT order at:
     - BUY direction: low of previous CLOSED H1 bar
     - SELL direction: high of previous CLOSED H1 bar

### 3.2 Risk Management

- **Position size:** 1% of equity per trade (NOT balance — drawdown-aware).
- **Stop Loss:** entry ± **SL_mult × ATR(14)**. Validated default: 0.5×ATR (tight stops).
- **Take Profit:** entry ± **TP_mult × ATR(14)**. Validated default: 4×ATR.
- **Pending order TTL:** 24 H1 bars (1 day). Cancel if unfilled.

### 3.3 Trailing State Machine

Once entry fills, monitor `max_favorable_price`:

| Trigger | Action |
|---|---|
| R-multiple ≥ 1.0 | Move SL to breakeven |
| R-multiple ≥ 1.5 | Partial close 50% + lock SL at +0.5R |
| R-multiple ≥ 2.0 | Trail SL at max_favorable − 1×ATR |
| R-multiple ≥ 3.0 | Tighter trail at max_favorable − 0.5×ATR |

This captures momentum after entry while preserving capital on whipsaws.

## 4. Asset Universe

### G1 — Volatile Trending (recommended)

These respond well to Triple Screen trend-following:

| Asset | Class |
|---|---|
| BTCUSD, ETHUSD, SOLUSD, LTCUSD | Crypto |
| XAUUSD, XAGUSD | Precious metals |
| NAS100, US30, SPX500 | US equity indices |
| USOIL, UKOIL | Energy |

**11 symbols total**. Validated across 6.7 months with PF 1.44 (IS) / 1.62 (OOS) / Robustness 1.125.

### G2 — Currency Pairs (DISABLED)

Forex pairs (EUR/USD, GBP/USD, USDJPY, AUD/USD, etc.) consistently lose money on this strategy. Reason: forex tends to mean-revert within central-bank-managed ranges, not trend cleanly. Triple Screen doesn't fit. Re-enable only after building a separate mean-reversion strategy variant.

## 5. Validated Strategy Parameters

### 5.1 Current CODE defaults (Run 1 — walk-forward verified, 2026-05-24)

```
sl_atr_mult:    0.5      (tight stop — counter to typical 1.5-2.0)
tp_atr_mult:    4.0      (wide target, but trailing usually exits before TP)
rsi_entry_low:  40
rsi_entry_high: 55       (narrower than 40-60 default)
sma_fast_period: 20
sma_slow_period: 50
vma_period:     20
atr_period:     14
rsi_period:     14
```

**Performance (6.7-month walk-forward):**

| Metric | In-Sample (Oct 2025 - Mar 2026) | Out-of-Sample (Mar 2026 - May 2026) |
|---|---|---|
| Trades | ~317 | ~160 |
| Win Rate | 59.3% | 57.6% |
| Profit Factor | 1.44 | **1.62** |
| Total P/L | +$6,108 | +$3,968 |
| Max DD | 11.84% | 13.03% |
| **Robustness** | (baseline) | **1.125 = ROBUST** |

Per-symbol concentration: Top 2 = 49.3% of P/L (well-diversified, < 70% threshold).

### 5.2 Latest in-sample finding (Run 2 — NOT yet walk-forward validated)

A 2592-combo sweep on a shorter window (Feb 21 - May 22 2026, 3 months) found a different
in-sample optimum with notably higher IS PF:

```
sl_atr_mult:    0.5
tp_atr_mult:    3.0      (3, 4, 5, 6 all gave identical results — see finding §5.3)
rsi_entry_low:  45       (narrower than Run 1's 40)
rsi_entry_high: 60       (wider than Run 1's 55)
sma_fast_period: 15      (faster than Run 1's 20)
sma_slow_period: 50
vma_period:     20
```

| Metric | In-Sample (Feb 21 - May 22 2026) | Out-of-Sample |
|---|---|---|
| Trades | 244 | (not yet measured) |
| Win Rate | 62.7% | — |
| Profit Factor | 2.24 | — |
| Total P/L | +$7,557 (+6.87%) | — |
| Max DD | 11.89% | — |

**Status:** Run 2 IS results exceed Run 1 but cannot be trusted without walk-forward validation.
Hidden risk: 3-month window may be benevolent — `Run 1`'s 6.7-month + WF result is currently
the only one with credibility for live deployment.

### 5.3 Architectural finding from Run 2 — TP is decorative

Top-4 ranks in Run 2 had identical stats but different TP values (3, 4, 5, 6). Conclusion:
**no trade ever reaches `TP_mult × ATR`** in the current strategy because trailing and
partial-close exits fire first (PARTIAL_TP at 1.5R, then TRAIL_SL after stage 2-4).

Implications:
- `tp_atr_mult` parameter is effectively unused — could be removed from sweep to save 4x compute.
- Decision to keep or remove `tp_atr_mult` should be made before Run 3 to avoid wasted optimization time.
- Live trades that reach TP price *would* close at TP, but in practice trailing always exits first.

### 5.4 Edge-of-grid signals from Run 2 — next sweep targets

Two parameters dominated every top-20 combo, suggesting true optimum may be outside the swept range:
- **SL = 0.5** in every top-20 row → next sweep should include [0.25, 0.4, 0.5, 0.75].
- **sma_fast = 15** in every top-20 row → next sweep should include [10, 12, 15, 20].

This is "edge-of-grid" detection — when an optimizer's winning value is at the boundary of what
was swept, the true optimum may lie outside the grid.

### 5.5 Run 3 result (2026-05-24, walk-forward validated, EDGE-OF-GRID alarm)

Window: 2025-11-01 to 2026-05-22 (6.7 months), 576 combos × 11 G1 symbols, walk_forward=True
Duration: 13.9 min at 9 workers

**Best Robust combo (rank 2 by OOS PF):**
```
sl_atr_mult:     0.25     (was 0.5 in Run 1)
tp_atr_mult:     4        (unchanged, decorative)
rsi_entry_low:   40       (unchanged)
rsi_entry_high:  55       (unchanged)
sma_fast_period: 10       (faster than Run 1's 20)
sma_slow_period: 60       (slower than Run 1's 50)
vma_period:      15       (was 20 in Run 1)
```

**Performance:**
| Metric | IS (4.5 mo) | OOS (2.3 mo) |
|---|---|---|
| Profit Factor | 4.32 | **4.35** |
| Return | +34.10% | +12.52% (~5.4%/month projected) |
| Win Rate | 69.04% | 65.09% |
| Trades | 533 | 212 |
| Max DD | 14.54% | 16.42% |
| Robustness | — | **1.007 (OOS slightly better than IS)** |

**Per-symbol concentration (IS, ordered by P/L):**
- US30 $7,737 / SPX500 $7,642 / NAS100 $6,455 — indices = 57% of P/L
- USOIL $4,230 / XAUUSD $2,788 / BTCUSD $2,780 / SOLUSD $2,352 / XAGUSD $2,091
- ETHUSD $1,523 / UKOIL $1,212 / LTCUSD -$204
- Top-2 = 40% (acceptable, under 70% fragility threshold)

### 5.6 EDGE-OF-GRID ALARM in Run 3 — must verify before deploy

All top-20 combos sit at the LOW edge of the swept range:
- `sl_atr_mult`: 100% of top-20 use 0.25 (lowest swept value)
- `vma_period`: 90% of top-20 use 15 (lowest swept value)
- `sma_fast_period`: 45% use 10 (lowest swept value), 80% use ≤ 12
- `sma_slow_period`: 50% use 40 (lowest swept value)
- `rsi_entry_low`: 70% use 40 (lowest swept value)
- `rsi_entry_high`: 65% use 55 (lowest swept value)

This pattern means EITHER:
- (a) True optimum is BELOW current grid (e.g. SL < 0.25, sma_fast < 10) — Run 4 must test
- (b) The 2025-11-01..2026-05-22 window has a specific noise pattern that VERY tight params
      exploit, and live performance will degrade significantly

### 5.7 Why Run 3 cannot replace code defaults alone

1. **Trade frequency jumped 12x.** Run 1: ~10 trades/month. Run 3: ~95 trades/month. The
   strategy effectively transitions from swing-trading to day-trading. Execution friction
   (spread, slippage, broker requote) cost scales linearly with trade count.

2. **SL=0.25xATR is tight.** On NAS100, ATR(H1) ~60-100 points -> SL ~15-25 points. Typical
   broker spread is 1-3 points (4-12% of SL). Slippage on stop-out may add another 1-3 points.
   Real execution cost may eat 10-25% of expected R-multiple per trade.

3. **Backtest doesn't model:**
   - Partial fills (broker can fill 30% of a 0.1 lot order at requested price, rest at worse)
   - Requote events (broker rejects, client re-submits at worse price)
   - Wide-spread events (spread widens during news / illiquid hours)
   - Slippage variance (assumed constant 1 pip in backtest; actual varies 0-5 pips)

4. **All params at grid edge** — strong overfit signal even though walk-forward says Robust.

### 5.8 Run 4 result (2026-05-24, walk-forward validated) - OVERFITTING SIGNATURE CONFIRMED

Window: 2025-11-01 to 2026-05-22 (6.7 months), 1296 combos × 11 G1 symbols, walk_forward=True
Duration: 28.1 min at 9 workers

**Best Robust combo (rank 10 by OOS PF):**
```
sl_atr_mult:     0.15     (LOWER than Run 3's 0.25 -> still edge of new grid)
tp_atr_mult:     4
rsi_entry_low:   40
rsi_entry_high:  60
sma_fast_period: 5        (LOWER than Run 3's 10 -> still edge of new grid)
sma_slow_period: 50
vma_period:      10       (LOWER than Run 3's 15 -> still edge of new grid)
```

**Performance:** IS PF 11.20, OOS PF 13.38, Robustness 1.195 (Robust label).
$10k starting -> $87,546 P/L over 4.5 months IS = 875% return (clearly unrealistic for live).

**EDGE-OF-GRID PERSISTS:**
| Run | SL | sma_fast | vma | OOS PF |
|---|---|---|---|---|
| Run 1 | 0.5 | 20 | 20 | 1.62 |
| Run 3 | 0.25 (edge) | 10 (edge) | 15 (edge) | 4.35 |
| Run 4 | 0.15 (edge) | 5 (edge) | 10 (edge) | 13.38 |

This is the SIGNATURE OF OPTIMIZATION OVERFITTING. Each grid extension finds tighter +
faster params with higher backtest PF because the backtest model exploits the SPECIFIC noise
pattern of this 6.7-month window. Backtest doesn't model:
- Spread variance during news / illiquid hours
- Slippage on stop-out (especially with very tight SLs)
- Requote events on tight orders
- Partial fills

At SL=0.15xATR, the SL distance on NAS100 ≈ 5-10 pips. Typical broker spread = 1-3 pips
= 10-30% of SL. Live execution will eat 20-50% of expected R per trade.

### 5.9 Run 4 verdict — DO NOT DEPLOY without Run 5/6 validation

PF 13 OOS is the result of:
1. Walk-forward "validation" splits the SAME 6.7-month window. Both train + test have the
   same noise pattern, so a strategy fitted to noise can "validate" on test if noise is
   correlated across train/test. This is a known limitation of single-split walk-forward.
2. Backtest engine doesn't simulate execution friction realistically. Tight SLs benefit
   massively in backtest because the engine assumes perfect fills.

**Required next steps before any deployment:**
- Run 5 (monthly sensitivity): test Run 3 + Run 4 params across 6 separate monthly windows.
  If PF varies wildly month-to-month (e.g. PF 0.5 in one month, 8 in another), the strategy
  is regime-specific, not a stable edge.
- Run 6 (spread stress): re-run Run 3 + Run 4 with spread + slippage doubled. If Run 4's PF
  drops from 13 to 3 (still PASS), use Run 4. If drops to 1 (FAIL), keep Run 1.
- Run 7 (per-asset-class): test if crypto vs indices want different params. If yes, branch.

- **Run 5 (planned):** Monthly sensitivity test - run Run 3 rank 2 params on each month
  separately (Nov-2025, Dec-2025, ..., Apr-2026). Goal: detect regime-specific lucky months.
  Pass: PF > 1.5 in 5/6 months. Fail: any month with PF < 1.0.

- **Run 6 (planned):** Spread stress test - re-run Run 3 rank 2 with cost (spread + slippage)
  assumption x2. Goal: estimate how much edge survives realistic execution.

**Decision rule:**
- All 3 (Run 4 confirms params, Run 5 month-consistent, Run 6 PF > 2.5 at 2x cost) pass
  -> REPLACE code defaults with Run 3 / Run 4 winner
- Any 1 fails -> KEEP Run 1 defaults, do not deploy Run 3 params
- All 3 fail -> Strategy needs structural change (not just param tuning)

## 6. Tuning + Deployment Workflow

```
1. Deep Backfill (5000 candles per TF)
2. Apply G1 universe via Settings or "Apply Winners" button
3. Optimize WITH Walk-Forward enabled
4. Filter: Robustness ≥ 0.85, PF > 1.2, DD < 15%
5. Verify concentration check (top 2 < 70%)
6. Apply Winners to live core_assets
7. Paper trade 4 weeks minimum
8. Real capital — small size first, scale gradually
```

**Re-tuning cadence:** Every quarter or when 30-day rolling PF drops below 1.0.

## 7. Out of Scope (for this version)

- High-frequency / scalping
- LLM-driven decision gating (see CLAUDE.md "LLM Role" section)
- Options / derivatives
- Multi-account / capital allocation across accounts
- News-event blackout filter (planned Phase 4)
- Per-asset-class parameter variation (planned Phase 5)
- Walk-forward optimization with rolling windows (planned Phase 5)
