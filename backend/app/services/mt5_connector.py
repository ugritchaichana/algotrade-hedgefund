"""MT5 IPC wrapper — terminal init, market data, account info, position/order reads.

Execution is intentionally NOT here. All `mt5.order_send` calls must go through
`app.services.execution_desk.execute_trade` so spread + swap + duplicate checks
are enforced uniformly.
"""

import os
import time
import datetime
import logging
import MetaTrader5 as mt5
import pandas as pd
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

MT5_PATH = os.getenv("MT5_PATH") or None  # None => let MT5 auto-detect a running terminal


def init_mt5() -> bool:
    ok = mt5.initialize(path=MT5_PATH) if MT5_PATH else mt5.initialize()
    if not ok:
        log.error("MT5 initialize() failed: %s", mt5.last_error())
        return False
    log.info("MT5 connection established (path=%s)", MT5_PATH or "auto-detect")
    return True


def shutdown_mt5() -> None:
    mt5.shutdown()


def resolve_symbol(symbol: str) -> str:
    """Resolve a logical symbol to its broker-specific name. Handles IUX-style aliases."""
    aliases = {
        "NAS100": ["USTEC.", "US100.", "USTEC", "US100"],
        "SPX500": ["US500.", "US500", "SPX500.", "S&P500.", "S&P500"],
        "US30": ["US30.", "DJ30.", "WS30.", "DJ30"],
        "GER40": ["GER40.", "DE40.", "DAX40.", "DE40", "DAX40"],
        "JPN225": ["JP225.", "JPN225.", "JP225"],
        "XRPUSD": ["XRPUSD.", "Ripple"],
    }

    if mt5.symbol_info(symbol) is not None:
        return symbol
    if mt5.symbol_info(symbol + ".") is not None:
        return symbol + "."
    for alias in aliases.get(symbol, []):
        if mt5.symbol_info(alias) is not None:
            return alias
    return symbol


def get_realtime_prices(symbols: list[str]) -> dict:
    prices = {}
    for sym in symbols:
        resolved = resolve_symbol(sym)
        tick = mt5.symbol_info_tick(resolved)
        if tick:
            prices[sym] = {
                "bid": tick.bid,
                "ask": tick.ask,
                "time": tick.time,
                "is_open": (time.time() - tick.time) < 300,
            }
        else:
            prices[sym] = {"error": f"No tick for {sym}"}
    return prices


def get_all_symbols() -> list[dict]:
    symbols = mt5.symbols_get()
    if not symbols:
        return []
    return [
        {
            "name": s.name,
            "description": s.description,
            "path": s.path,
            "spread": s.spread,
            "digits": s.digits,
        }
        for s in symbols
    ]


def get_active_orders() -> list[dict]:
    """Return BOTH filled positions AND pending limit/stop orders so the UI shows the complete trade book."""
    out = []

    positions = mt5.positions_get() or []
    for p in positions:
        out.append({
            "ticket": p.ticket,
            "symbol": p.symbol,
            "type": "BUY" if p.type == 0 else "SELL",
            "status": "OPEN",
            "volume": p.volume,
            "price_open": p.price_open,
            "price_current": p.price_current,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
        })

    pending = mt5.orders_get() or []
    for o in pending:
        type_label = {
            mt5.ORDER_TYPE_BUY_LIMIT: "BUY_LIMIT",
            mt5.ORDER_TYPE_SELL_LIMIT: "SELL_LIMIT",
            mt5.ORDER_TYPE_BUY_STOP: "BUY_STOP",
            mt5.ORDER_TYPE_SELL_STOP: "SELL_STOP",
        }.get(o.type, str(o.type))
        out.append({
            "ticket": o.ticket,
            "symbol": o.symbol,
            "type": type_label,
            "status": "PENDING",
            "volume": o.volume_initial,
            "price_open": o.price_open,
            "price_current": o.price_current,
            "sl": o.sl,
            "tp": o.tp,
            "profit": 0.0,
        })

    return out


def get_historical_data(symbol: str, timeframe: int, num_candles: int) -> pd.DataFrame:
    resolved = resolve_symbol(symbol)
    rates = mt5.copy_rates_from_pos(resolved, timeframe, 0, num_candles)
    if rates is None:
        return pd.DataFrame()
    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s")
    return df


# Chart OHLC cache (prevents MT5 spam on UI expand/collapse)
_chart_cache: dict[str, dict] = {}
_CHART_TTL = 120


def get_chart_data(symbol: str, timeframe: int, num_candles: int) -> list[dict]:
    tf_names = {
        mt5.TIMEFRAME_M1: "M1", mt5.TIMEFRAME_M5: "M5",
        mt5.TIMEFRAME_M15: "M15", mt5.TIMEFRAME_M30: "M30",
        mt5.TIMEFRAME_H1: "H1", mt5.TIMEFRAME_H4: "H4",
        mt5.TIMEFRAME_D1: "D1",
    }
    key = f"{symbol}_{tf_names.get(timeframe, 'UNK')}_{num_candles}"
    now = time.time()
    cached = _chart_cache.get(key)
    if cached and (now - cached["time"]) < _CHART_TTL:
        return cached["data"]

    resolved = resolve_symbol(symbol)
    rates = mt5.copy_rates_from_pos(resolved, timeframe, 0, num_candles)
    if rates is None:
        return []
    data = [
        {"time": int(r["time"]), "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"]}
        for r in rates
    ]
    _chart_cache[key] = {"data": data, "time": now}
    return data


def get_account_info() -> dict | None:
    """Return account info with both balance + equity + margin_free for safe sizing."""
    info = mt5.account_info()
    if info is None:
        return None
    return {
        "balance": info.balance,
        "equity": info.equity,
        "margin": info.margin,
        "margin_free": info.margin_free,
        "margin_level": info.margin_level,
        "profit": info.profit,
        "currency": info.currency,
        "leverage": info.leverage,
    }


def check_terminal_health() -> dict:
    """Return MT5 terminal health snapshot — used for ping + algo-trading gate before each cron fire."""
    term = mt5.terminal_info()
    if term is None:
        return {"connected": False, "ping_ms": 0.0, "trade_allowed": False}
    return {
        "connected": term.connected,
        "ping_ms": term.ping_last / 1000.0,
        "trade_allowed": term.trade_allowed,
    }


def get_account_status_full() -> dict:
    account = mt5.account_info()
    if account is None:
        return {"error": "Failed to get account info", "account": None, "exposure": {}, "recent_history": []}

    positions = mt5.positions_get() or []
    exposure: dict[str, float] = {}
    for p in positions:
        vol = p.volume if p.type == 0 else -p.volume
        exposure[p.symbol] = exposure.get(p.symbol, 0) + vol

    to_date = datetime.datetime.now()
    from_date = to_date - datetime.timedelta(days=7)
    deals = mt5.history_deals_get(from_date, to_date) or []
    history = []
    for d in deals:
        if d.type in (0, 1):
            history.append({
                "ticket": d.ticket,
                "symbol": d.symbol,
                "volume": d.volume,
                "price": d.price,
                "profit": d.profit,
                "type": "BUY" if d.type == 0 else "SELL",
                "time": d.time,
            })

    return {
        "account": {
            "balance": account.balance,
            "equity": account.equity,
            "margin": account.margin,
            "margin_free": account.margin_free,
            "margin_level": account.margin_level,
            "profit": account.profit,
        },
        "exposure": exposure,
        "recent_history": history[-50:],
    }
