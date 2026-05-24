"""Execution Desk — the SINGLE entry point for placing trades on MT5.

All auto-trade and manual-trade flows MUST go through `execute_trade` here.
Direct callers of `mt5.order_send` are forbidden outside this module.

Safety gates enforced here:
  1. Symbol resolution (handle IUX broker aliases)
  2. Spread protection (per-symbol max_spread from ASSET_PROFILES)
  3. Swap cost warning (negative swap > 50 points triggers alert)
  4. Duplicate position check (no doubling up in same direction)
  5. Pending-limit placement (no market chasing)
"""

import logging
import MetaTrader5 as mt5
from app.core.database import log_action
from app.services.discord_notifier import send_discord_alert, notify_safety_event, notify_trade_opened
from app.services.mt5_connector import resolve_symbol
from app.core.asset_profiles import ASSET_PROFILES

log = logging.getLogger(__name__)

MAGIC_NUMBER = 999999
COMMENT = "AlgoTrade"


def has_open_position(symbol: str, signal_type: str) -> bool:
    """Check whether an open position already exists for this symbol in the same direction."""
    positions = mt5.positions_get(symbol=symbol)
    if not positions:
        return False
    want_type = mt5.ORDER_TYPE_BUY if "BUY" in signal_type else mt5.ORDER_TYPE_SELL
    return any(p.type == want_type for p in positions)


def has_pending_order(symbol: str, signal_type: str) -> bool:
    """Check whether a pending limit/stop order already exists for this symbol in the same direction."""
    orders = mt5.orders_get(symbol=symbol)
    if not orders:
        return False
    if "BUY" in signal_type:
        return any(o.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP) for o in orders)
    return any(o.type in (mt5.ORDER_TYPE_SELL_LIMIT, mt5.ORDER_TYPE_SELL_STOP) for o in orders)


def execute_trade(symbol: str, signal_data: dict) -> dict:
    """Place a pending limit order based on a quant_desk signal.

    Args:
        symbol: original (un-resolved) symbol the strategy decided on, e.g. "XAUUSD".
        signal_data: dict from quant_desk with keys: signal, entry, sl, tp, lot_size.

    Returns:
        {"success": bool, "ticket": int | None, "error": str | None, "reason": str | None}
    """
    signal = signal_data.get("signal", "")
    if not signal or not signal.startswith("ENTRY"):
        return {"success": False, "ticket": None, "error": "Not an entry signal", "reason": "no_entry"}

    lot = float(signal_data.get("lot_size") or 0)
    entry = float(signal_data.get("entry") or 0)
    sl = float(signal_data.get("sl") or 0)
    tp = float(signal_data.get("tp") or 0)
    if lot <= 0 or entry <= 0 or sl <= 0 or tp <= 0:
        return {"success": False, "ticket": None, "error": "Invalid trade parameters", "reason": "bad_params"}

    if has_open_position(symbol, signal) or has_pending_order(symbol, signal):
        msg = f"{symbol}: existing {signal} position or pending order — skipping"
        log.info(msg)
        return {"success": False, "ticket": None, "error": msg, "reason": "duplicate"}

    resolved = resolve_symbol(symbol)
    info = mt5.symbol_info(resolved)
    if info is None:
        return {"success": False, "ticket": None, "error": f"Symbol {resolved} not found", "reason": "symbol_missing"}

    profile = ASSET_PROFILES.get(symbol, {})

    # Gate 1: spread protection
    max_spread = profile.get("max_spread", 50)
    if info.spread > max_spread:
        detail = f"{symbol} spread={info.spread} > max={max_spread} — order aborted to prevent slippage"
        log.warning(detail)
        log_action("Execution Desk", "Spread Protection", detail)
        notify_safety_event("Spread Protection", detail)
        return {"success": False, "ticket": None, "error": detail, "reason": "spread"}

    # Gate 2: swap warning (non-blocking, just alerts)
    swap_cost = info.swap_long if "BUY" in signal else info.swap_short
    if swap_cost < -50:
        warn = f"{symbol} negative swap detected ({swap_cost}). Swing trade will incur high holding cost."
        log.warning(warn)
        log_action("Execution Desk", "Swap Warning", warn)
        notify_safety_event("High Swap Cost", warn)

    # Place PENDING LIMIT order (institutional style — better entries than market chasing)
    order_type = mt5.ORDER_TYPE_BUY_LIMIT if "BUY" in signal else mt5.ORDER_TYPE_SELL_LIMIT
    request = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": resolved,
        "volume": lot,
        "type": order_type,
        "price": entry,
        "sl": sl,
        "tp": tp,
        "magic": MAGIC_NUMBER,
        "comment": COMMENT,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_RETURN,
    }

    result = mt5.order_send(request)
    if result is None:
        err = f"{symbol}: order_send returned None (MT5 disconnected?)"
        log.error(err)
        log_action("Execution Desk", "Trade Failed", err)
        notify_safety_event("Execution Failed", err)
        return {"success": False, "ticket": None, "error": err, "reason": "mt5_disconnect"}

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        err = f"{symbol} order failed: retcode={result.retcode} comment={result.comment}"
        log.error(err)
        log_action("Execution Desk", "Trade Failed", err)
        notify_safety_event("Execution Failed", err)
        return {"success": False, "ticket": None, "error": err, "reason": "retcode_not_done"}

    success_msg = (
        f"{symbol} {signal}: ticket={result.order} lot={lot} entry={entry} SL={sl} TP={tp}"
    )
    log.info(success_msg)
    log_action("Execution Desk", "Trade Executed", success_msg)
    notify_trade_opened(
        ticket=int(result.order),
        symbol=symbol,
        side="BUY" if "BUY" in signal else "SELL",
        entry_price=entry,
        sl=sl,
        tp=tp,
        lot=lot
    )

    # Write initial TradeJournalEntry
    import json
    import datetime
    from app.core.database import SessionLocal, TradeJournalEntry
    db = SessionLocal()
    try:
        journal = TradeJournalEntry(
            ticket=result.order,
            symbol=symbol,
            side="BUY" if "BUY" in signal else "SELL",
            opened_at=datetime.datetime.utcnow(),
            entry_price=float(entry),
            exit_price=None,
            sl=float(sl),
            tp=float(tp),
            lot=float(lot),
            exit_reason=None,
            r_multiple=None,
            pnl=None,
            slippage_entry=None,
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
    except Exception as e:
        log.exception("execute_trade: failed to write TradeJournalEntry: %s", e)
    finally:
        db.close()

    return {"success": True, "ticket": int(result.order), "error": None, "reason": "ok"}


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
