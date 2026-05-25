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
import datetime
import MetaTrader5 as mt5
from app.core.database import SessionLocal, TradeState, TradeJournalEntry, log_action
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

    # Capture entry slippage on first encounter (journal.slippage_entry is None until filled).
    # Slippage = signed pip difference between actual fill (pos.price_open) and requested entry.
    journal_entry = db.query(TradeJournalEntry).filter(
        TradeJournalEntry.ticket == pos.ticket,
        TradeJournalEntry.slippage_entry == None,  # noqa: E711
    ).first()
    if journal_entry is not None and journal_entry.entry_price is not None:
        info = mt5.symbol_info(pos.symbol)
        point = float(info.point) if info and info.point else 0.00001
        diff_price = float(pos.price_open) - float(journal_entry.entry_price)
        if not is_buy:
            diff_price = -diff_price  # SELL: positive slippage = filled higher = better
        slippage_pips = round(diff_price / point, 2) if point > 0 else 0.0
        journal_entry.slippage_entry = slippage_pips
        log.info("Captured entry slippage: ticket=%s symbol=%s slippage_pips=%.2f",
                 pos.ticket, pos.symbol, slippage_pips)

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
    old_stage = state.trail_stage
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

    # Broadcast state transition
    if new_stage != old_stage:
        try:
            from app.core.events import broadcast_event
            broadcast_event("TRADE_STATE_CHANGE", {
                "ticket": pos.ticket,
                "symbol": pos.symbol,
                "old_stage": old_stage,
                "new_stage": new_stage,
                "new_sl": state.sl,
                "r_multiple": round(r, 3),
            })
        except Exception:
            pass


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


def sync_closed_positions():
    """Scans for open TradeJournalEntry rows that no longer have an active MT5 position, and closes them."""
    db = SessionLocal()
    try:
        # Find all open trades in our DB
        open_trades = db.query(TradeJournalEntry).filter(TradeJournalEntry.closed_at == None).all()
        if not open_trades:
            return
            
        # Get all active tickets in MT5 right now
        active_positions = mt5.positions_get()
        active_tickets = {p.ticket for p in (active_positions or [])}
        
        for trade in open_trades:
            if trade.ticket not in active_tickets:
                # The trade is no longer active in MT5, it must be closed!
                _process_closed_trade(db, trade)
                
    except Exception as e:
        log.error("sync_closed_positions failed: %s", e)
    finally:
        db.close()


def _process_closed_trade(db, trade):
    from app.services.discord_notifier import notify_trade_closed
    from app.core.database import TradeState

    now = datetime.datetime.utcnow()
    from_date = now - datetime.timedelta(days=30)
    # NOTE: position= keyword filter in mt5.history_deals_get is unreliable across
    # MT5 builds — some return ALL deals in date range regardless. Always re-filter
    # in Python by position_id to guarantee we only see deals belonging to this trade.
    deals = mt5.history_deals_get(from_date, now, position=trade.ticket)

    if not deals:
        log.warning("sync_closed_positions: No deals found for closed ticket %s", trade.ticket)
        return

    out_deals = [
        d for d in deals
        if d.entry == mt5.DEAL_ENTRY_OUT
        and getattr(d, "position_id", None) == trade.ticket
    ]
    if not out_deals:
        log.warning("sync_closed_positions: No DEAL_ENTRY_OUT matching position_id=%s "
                    "(returned %d deals but none belonged to this ticket — MT5 position= filter ignored?)",
                    trade.ticket, len(deals))
        return
        
    total_pnl = sum(d.profit + d.commission + d.swap for d in out_deals)
    final_deal = sorted(out_deals, key=lambda x: x.time)[-1]
    
    exit_price = final_deal.price
    
    reason = "Manual/Trail"
    if final_deal.reason == mt5.DEAL_REASON_SL:
        reason = "Stop Loss"
    elif final_deal.reason == mt5.DEAL_REASON_TP:
        reason = "Take Profit"
    elif final_deal.reason == mt5.DEAL_REASON_CLIENT:
        reason = "Manual Close"
        
    r_multiple = 0.0
    state = db.query(TradeState).filter(TradeState.ticket == trade.ticket).first()
    if state and state.initial_sl_distance > 0:
        if trade.side == "BUY":
            r_multiple = (exit_price - trade.entry_price) / state.initial_sl_distance
        else:
            r_multiple = (trade.entry_price - exit_price) / state.initial_sl_distance
            
    _close_journal_entry(db, trade.ticket, exit_price, reason, r_multiple, total_pnl, 0.0)

    notify_trade_closed(
        ticket=trade.ticket,
        symbol=trade.symbol,
        side=trade.side,
        exit_price=exit_price,
        pnl=total_pnl,
        r_multiple=r_multiple,
        exit_reason=reason
    )
    try:
        from app.core.events import broadcast_event
        broadcast_event("TRADE_CLOSED", {
            "ticket": trade.ticket,
            "symbol": trade.symbol,
            "side": trade.side,
            "exit_price": float(exit_price),
            "pnl": round(float(total_pnl), 2),
            "r_multiple": round(float(r_multiple), 3),
            "exit_reason": reason,
        })
    except Exception:
        pass
    log.info("Synced closed position %s: PnL=%.2f R=%.2f", trade.ticket, total_pnl, r_multiple)
