# Phase 4 — Close Live-vs-Backtest Gap

Status: **DRAFT — DO NOT IMPLEMENT YET. AWAITING BOOTH REVIEW.**

Created: 2026-05-24 during autonomous overnight session.

## Why Phase 4 exists

Current `trade_manager.py` only does **breakeven** at 1.0R. The full state machine
(partial close at 1.5R, trail at 2R/3R) exists only in `backtest_engine._advance_trailing`.

This means:
- **Backtest is optimistic.** Run 1 OOS PF=1.62 assumes full trailing. Live execution
  with breakeven-only gives up partial-close locked profits + tighter trailing protection.
- **Live cannot validate backtest** until the gap closes. Paper trade results would
  diverge from backtest projection by 20-40% on R-multiple capture.

Phase 4 closes 3 known gaps. Estimated effort: ~3 hours.

---

## B-CRITICAL-1: Full 4-stage state machine in `trade_manager.py`

### Current code (`trade_manager.py`, 69 lines)

Only does:
- Reads TradeState by ticket
- Compares `price_distance` to `initial_sl_distance`
- If price_distance >= initial_sl_distance: move SL to entry (breakeven)

Missing:
- max_favorable tracking across ticks
- Partial close at 1.5R (close 50% volume + lock SL at +0.5R)
- Trail at 2R (max_favorable - 1*ATR)
- Tighter trail at 3R (max_favorable - 0.5*ATR)
- State persistence across restarts

Plus a **rule violation:** `_modify_sl()` calls `mt5.order_send` directly,
bypassing `execution_desk`. Phase 4 should also fix this.

### Schema migration — extend TradeState

Add 4 new columns to `trade_states` table:

```python
class TradeState(Base):
    __tablename__ = "trade_states"
    id = Column(Integer, primary_key=True, index=True)
    ticket = Column(Integer, unique=True, index=True)
    symbol = Column(String(20), index=True)
    status = Column(String(20))
    order_type = Column(String(20))
    entry_price = Column(Float)
    sl = Column(Float)
    tp = Column(Float)
    volume = Column(Float)
    trailing_active = Column(Boolean, default=False)
    # NEW columns for full state machine
    initial_sl_distance = Column(Float, default=0.0)   # price distance, not pips
    max_favorable = Column(Float, default=0.0)         # tracked across ticks
    trail_stage = Column(Integer, default=0)           # 0..4
    partial_closed = Column(Boolean, default=False)
    entry_atr = Column(Float, default=0.0)             # ATR at entry, for stage 3/4 trail
    initial_volume = Column(Float, default=0.0)        # for partial-close reference
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
```

`_migrate_schema_if_needed()` already handles drift via drop+recreate; new columns will
trigger a re-create automatically. **Note:** this DROPS existing trade_states rows. If
there are open positions, you need to manually re-seed them OR add a smarter migration.
Since this project is pre-live, drop is acceptable. Document the cutover.

### Required upgrade — also persist entry_atr at order placement time

`execute_trade` currently doesn't persist ATR. Quant_desk computes `entry_atr` but it's
not threaded into TradeState. Fix in execute_trade:

```python
# After mt5.order_send succeeds, persist state
def _persist_trade_state(ticket, symbol, signal_data, entry, sl, tp, lot):
    from app.core.database import SessionLocal, TradeState
    db = SessionLocal()
    try:
        ts = TradeState(
            ticket=ticket,
            symbol=symbol,
            status="PENDING_FILL",
            order_type=signal_data["signal"],
            entry_price=entry,
            sl=sl,
            tp=tp,
            volume=lot,
            initial_volume=lot,
            initial_sl_distance=abs(entry - sl),
            max_favorable=entry,  # start at entry; updates as price moves
            trail_stage=0,
            partial_closed=False,
            entry_atr=signal_data.get("entry_atr", 0.0),  # NEW: quant_desk must pass this
            trailing_active=False,
        )
        db.add(ts)
        db.commit()
    finally:
        db.close()
```

`quant_desk.compute_h1_signals` must include `entry_atr` in the returned signal dict.

### State machine implementation

Replace `trade_manager.py` entirely:

```python
"""Trade Manager — manages open positions via full 4-stage trailing state machine.

Called every H1 boundary (or more frequently if desired) by APScheduler.

Mirrors backtest_engine._advance_trailing exactly to keep live behavior in sync with
backtest projections.

State machine (BUY direction; SELL mirrors):
  stage 0: initial
  stage 1 (>= 1.0R): SL -> breakeven
  stage 2 (>= 1.5R): partial close 50% volume + SL -> +0.5R
  stage 3 (>= 2.0R): trailing SL = max_favorable - 1.0 * ATR
  stage 4 (>= 3.0R): tighter trail at max_favorable - 0.5 * ATR
"""

import logging
import MetaTrader5 as mt5
from app.core.database import SessionLocal, TradeState, log_action
from app.services.execution_desk import modify_position_sl, partial_close_position

log = logging.getLogger(__name__)


def manage_active_trades():
    """Called every H1 boundary by scheduler."""
    positions = mt5.positions_get()
    if positions is None or len(positions) == 0:
        return

    db = SessionLocal()
    try:
        for pos in positions:
            try:
                _manage_one(db, pos)
            except Exception as e:
                log.exception("manage_one failed for ticket %s: %s", pos.ticket, e)
    finally:
        db.close()


def _manage_one(db, pos) -> None:
    state = db.query(TradeState).filter(TradeState.ticket == pos.ticket).first()
    if not state:
        log.warning("No TradeState for ticket %s — orphaned position", pos.ticket)
        return

    is_buy = pos.type == mt5.ORDER_TYPE_BUY
    current = pos.price_current

    # 1) Update max_favorable
    if is_buy:
        new_max = max(state.max_favorable, current)
    else:
        new_max = min(state.max_favorable, current) if state.max_favorable > 0 else current
    if new_max != state.max_favorable:
        state.max_favorable = new_max

    # 2) Compute R multiple based on max_favorable (best progress so far)
    d = state.initial_sl_distance
    if d <= 0:
        return
    if is_buy:
        r = (state.max_favorable - state.entry_price) / d
    else:
        r = (state.entry_price - state.max_favorable) / d

    new_sl = state.sl  # default: no change
    new_stage = state.trail_stage

    # Stage 1 — breakeven at 1.0R
    if r >= 1.0 and state.trail_stage < 1:
        new_sl = state.entry_price
        new_stage = 1
        log_action("TradeManager", "Stage1_Breakeven", f"{pos.symbol} ticket={pos.ticket} R={r:.2f}")

    # Stage 2 — partial close 50% + lock SL at +0.5R
    if r >= 1.5 and state.trail_stage < 2 and not state.partial_closed:
        half_volume = round(state.initial_volume * 0.5, 2)
        if half_volume >= 0.01:  # MT5 min lot
            ok = partial_close_position(pos.ticket, pos.symbol, half_volume)
            if ok:
                state.partial_closed = True
                lock_distance = 0.5 * d
                lock_price = state.entry_price + lock_distance if is_buy else state.entry_price - lock_distance
                new_sl = max(state.sl, lock_price) if is_buy else min(state.sl, lock_price)
                new_stage = 2
                log_action("TradeManager", "Stage2_PartialClose", f"{pos.symbol} ticket={pos.ticket} closed {half_volume} lot, SL locked at +0.5R")

    # Stage 3 — trailing at max_favorable - 1*ATR
    if r >= 2.0 and state.trail_stage < 3 and state.entry_atr > 0:
        trail = state.max_favorable - state.entry_atr if is_buy else state.max_favorable + state.entry_atr
        new_sl = max(state.sl, trail) if is_buy else min(state.sl, trail)
        new_stage = 3

    # Stage 4 — tighter trail at 0.5*ATR
    if r >= 3.0 and state.trail_stage < 4 and state.entry_atr > 0:
        trail = state.max_favorable - 0.5 * state.entry_atr if is_buy else state.max_favorable + 0.5 * state.entry_atr
        new_sl = max(state.sl, trail) if is_buy else min(state.sl, trail)
        new_stage = 4

    # Continuous trail in stage 3+ (catches new highs even without stage transition)
    if state.trail_stage >= 3 and state.entry_atr > 0:
        atr_mult = 0.5 if state.trail_stage == 4 else 1.0
        trail = state.max_favorable - atr_mult * state.entry_atr if is_buy else state.max_favorable + atr_mult * state.entry_atr
        new_sl = max(new_sl, trail) if is_buy else min(new_sl, trail)

    # Commit changes
    if new_stage != state.trail_stage:
        state.trail_stage = new_stage
    if abs(new_sl - state.sl) > 1e-6:
        # Send SL modify via execution_desk (single-entry-point invariant)
        ok = modify_position_sl(pos.ticket, pos.symbol, new_sl, pos.tp)
        if ok:
            state.sl = new_sl
            log_action("TradeManager", "SL_Modified", f"{pos.symbol} ticket={pos.ticket} new_sl={new_sl:.5f} stage={new_stage}")

    state.trailing_active = state.trail_stage >= 1
    db.commit()
```

### New helpers in `execution_desk.py`

```python
def modify_position_sl(ticket: int, symbol: str, new_sl: float, current_tp: float) -> bool:
    """Modify position SL via TRADE_ACTION_SLTP. Returns True on success."""
    resolved = resolve_symbol(symbol)
    if not resolved:
        log.error("modify_position_sl: cannot resolve symbol %s", symbol)
        return False
    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": ticket,
        "symbol": resolved,
        "sl": float(new_sl),
        "tp": float(current_tp),
    }
    result = mt5.order_send(request)
    if not result or result.retcode != mt5.TRADE_RETCODE_DONE:
        log.warning("modify_position_sl failed: ticket=%s retcode=%s comment=%s",
                    ticket, getattr(result, "retcode", None), getattr(result, "comment", None))
        return False
    return True


def partial_close_position(ticket: int, symbol: str, volume_to_close: float) -> bool:
    """Close `volume_to_close` lots of the position (opposite-side market order).

    Returns True on success. Uses TRADE_ACTION_DEAL with opposite side.
    """
    resolved = resolve_symbol(symbol)
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        return False
    p = pos[0]
    is_buy = p.type == mt5.ORDER_TYPE_BUY
    close_type = mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY
    tick = mt5.symbol_info_tick(resolved)
    if not tick:
        return False
    price = tick.bid if is_buy else tick.ask
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": resolved,
        "volume": float(volume_to_close),
        "type": close_type,
        "position": ticket,
        "price": price,
        "deviation": 20,  # 2 pips slippage tolerance
        "magic": MAGIC_NUMBER,
        "comment": "AlgoTrade Partial Close",
    }
    result = mt5.order_send(request)
    if not result or result.retcode != mt5.TRADE_RETCODE_DONE:
        log.warning("partial_close failed: ticket=%s retcode=%s comment=%s",
                    ticket, getattr(result, "retcode", None), getattr(result, "comment", None))
        return False
    log.info("Partial close: ticket=%s volume=%s", ticket, volume_to_close)
    return True
```

### Test plan for B-CRITICAL-1

1. Open demo account, set risk_percent = 0.5%
2. Wait for one ENTRY signal to fire on a volatile symbol (BTCUSD usually triggers)
3. Watch trade_states row in Postgres + MT5 position SL
4. As price moves favorably, verify:
   - At 1.0R: SL == entry_price (breakeven)
   - At 1.5R: half volume closes, SL == entry + 0.5*d (BUY case)
   - At 2.0R: SL trails behind max_favorable by 1*ATR
   - At 3.0R: SL tightens to 0.5*ATR behind max_favorable
5. Also verify on a losing trade — SL stays at initial, position closes at SL
6. Run side-by-side with backtest on same input data — divergence should be < 5%

---

## B-CRITICAL-2: Fix DD count bug in `_today_realized_pnl`

### Current bug

`backend/app/main.py` lines ~130-139 (approximate, may have shifted):

```python
def _today_realized_pnl() -> float:
    """Sum today's realized P/L from MT5 deal history."""
    today = datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(today, datetime.datetime.now(datetime.timezone.utc))
    if not deals:
        return 0.0
    return sum(d.profit + d.commission + d.swap for d in deals if d.type in (0, 1))
```

**Bug:** `d.type in (0, 1)` filters deal TYPE (DEAL_TYPE_BUY=0, DEAL_TYPE_SELL=1). Both ENTRY and EXIT
deals have type 0/1. So this filter double-counts: entry deal contributes 0 P/L (just spread/commission)
but is summed; exit deal contributes the realized P/L and is also summed.

In practice the entry-side commission is small and exit-side P/L dominates, so the number is **close**
but not correct. It doesn't trigger false-positive DD halts unless commissions are unusually high.

### Fix (1-line change)

```python
def _today_realized_pnl() -> float:
    today = datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(today, datetime.datetime.now(datetime.timezone.utc))
    if not deals:
        return 0.0
    # CORRECT: only sum CLOSING deals (entry == DEAL_ENTRY_OUT)
    return sum(d.profit + d.commission + d.swap for d in deals if d.entry == mt5.DEAL_ENTRY_OUT)
```

### Verify

1. Open + close one demo position
2. Note actual P/L in MT5 history
3. Call `/api/health` (if it surfaces realized_pnl) or trigger DD-check log
4. Number should match MT5 history exactly

---

## B-CRITICAL-3: Update `quant_desk.py` module docstring

### Current state

`quant_desk.py` lines ~13-29 (module docstring) claims:
- SL = 1.5 * ATR
- TP = 3.0 * ATR
- RSI 40-60

But the CODE uses validated Run 1 defaults:
- SL = 0.5 * ATR
- TP = 4.0 * ATR
- RSI 40-55

The docstring is misleading anyone who reads it without checking the code constants below.

### Fix

Read the existing docstring + update the values + add a "validated via Run 1 walk-forward 2026-05-24"
note. Optionally mention that future Run 3-8 may further refine these (per CLAUDE.md Tuning History).

Code change is a doc-only edit. Zero behavior change.

### After Run 3-8 settles

If Run 4 + 5 + 6 + 7 all confirm new params, update the docstring AGAIN with the new winners.

---

## Acceptance criteria for Phase 4

- [ ] `trade_states` table has new columns (initial_sl_distance, max_favorable, trail_stage, partial_closed, entry_atr, initial_volume)
- [ ] `execute_trade` persists initial state correctly (including entry_atr from quant_desk)
- [ ] `trade_manager.manage_active_trades` runs the full 4-stage state machine
- [ ] All MT5 calls flow through execution_desk (no direct order_send in trade_manager)
- [ ] DD bug fixed (deals filter uses DEAL_ENTRY_OUT)
- [ ] quant_desk docstring matches code constants
- [ ] Manual demo test: open one BUY, watch 4 stages execute correctly
- [ ] Side-by-side backtest vs live divergence < 5% on identical input window

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Migration drops existing trade_states | Phase 4 happens before live deployment — only demo positions exist. Document cutover. If real positions exist, write data-preserving migration. |
| Partial close fails (broker rejects half-volume) | Log warning, skip stage 2, continue with stage 1 breakeven only. Don't crash the manager. |
| SL modify fails (broker rejects new SL) | Log warning, retain old SL in DB. Don't crash. |
| max_favorable not updated between H1 boundaries | manage_active_trades only runs hourly. For very fast-moving symbols (crypto), consider running every 5-15 min. Initially keep hourly to match backtest. |
| TradeState lost on backend restart | Already persisted in Postgres. As long as Postgres is up, state is durable. |
| Multiple TradeState rows per ticket (race condition) | Schema enforces `ticket = unique=True, index=True`. Race-safe. |
| Entry_atr not present in signal_data | If 0, skip stage 3/4 trail (already handled). But log warning so we catch the upstream bug. |

---

## What needs Booth approval to proceed

1. Confirm migration via drop+recreate is OK (no open real positions yet)
2. Confirm helpers in execution_desk.py are acceptable additions (single-entry-point invariant preserved)
3. Confirm manage_active_trades on H1 boundary is acceptable (or change to higher frequency)
4. Confirm test plan on demo account is the validation gate

Once approved, total implementation ~3 hours. Then re-run backtest vs live side-by-side and
compare; if divergence < 5%, Phase 4 is done.
