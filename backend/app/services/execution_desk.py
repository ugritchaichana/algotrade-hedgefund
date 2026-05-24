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
from app.services.discord_notifier import send_discord_alert, notify_safety_event
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
    send_discord_alert(
        f"Trade executed: **{symbol}** {signal} | Lot {lot} | Entry {entry} | SL {sl} | TP {tp} | Ticket {result.order}"
    )

    return {"success": True, "ticket": int(result.order), "error": None, "reason": "ok"}
