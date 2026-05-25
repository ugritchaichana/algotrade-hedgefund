"""Shared pytest fixtures.

Mocks `MetaTrader5` so tests can run on any host (no MT5 terminal required).
Mocks the Postgres `SessionLocal` so tests don't need a real DB.
"""

import sys
import types
import pytest


@pytest.fixture(autouse=True, scope="session")
def stub_metatrader5():
    """Inject a minimal MetaTrader5 stub before any app import.

    Real MT5 is Windows-only and requires a running terminal. Tests target pure
    logic — math, state machines, gate boolean ladder — which doesn't need the IPC.
    """
    if "MetaTrader5" in sys.modules:
        return
    stub = types.ModuleType("MetaTrader5")

    # Order / deal entry constants used by the codebase
    stub.ORDER_TYPE_BUY = 0
    stub.ORDER_TYPE_SELL = 1
    stub.ORDER_TYPE_BUY_LIMIT = 2
    stub.ORDER_TYPE_SELL_LIMIT = 3
    stub.ORDER_TYPE_BUY_STOP = 4
    stub.ORDER_TYPE_SELL_STOP = 5
    stub.TRADE_ACTION_PENDING = 5
    stub.TRADE_ACTION_DEAL = 1
    stub.TRADE_ACTION_SLTP = 7
    stub.TRADE_RETCODE_DONE = 10009
    stub.DEAL_ENTRY_OUT = 1
    stub.DEAL_ENTRY_IN = 0
    stub.DEAL_REASON_SL = 4
    stub.DEAL_REASON_TP = 5
    stub.DEAL_REASON_CLIENT = 3
    stub.ORDER_TIME_GTC = 0
    stub.ORDER_FILLING_RETURN = 0
    stub.TIMEFRAME_M1 = 1
    stub.TIMEFRAME_M5 = 5
    stub.TIMEFRAME_M15 = 15
    stub.TIMEFRAME_M30 = 30
    stub.TIMEFRAME_H1 = 16385
    stub.TIMEFRAME_H4 = 16388
    stub.TIMEFRAME_D1 = 16408

    # Default function stubs — tests can monkeypatch as needed
    stub.initialize = lambda *a, **kw: True
    stub.shutdown = lambda: None
    stub.terminal_info = lambda: object()
    stub.symbol_info = lambda s: None
    stub.symbol_info_tick = lambda s: None
    stub.positions_get = lambda *a, **kw: []
    stub.orders_get = lambda *a, **kw: []
    stub.history_deals_get = lambda *a, **kw: []
    stub.account_info = lambda: None
    stub.order_send = lambda req: None
    stub.copy_rates_from_pos = lambda *a, **kw: None
    stub.copy_rates_range = lambda *a, **kw: None
    stub.last_error = lambda: (0, "no error")

    sys.modules["MetaTrader5"] = stub
