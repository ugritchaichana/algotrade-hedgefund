"""execute_trade idempotency guard regression test.

Two back-to-back execute_trade calls with the same (symbol, signal, entry) must result
in the second being blocked with reason='idempotent_duplicate' (the second call should
NEVER reach mt5.order_send).
"""

import pytest


def test_idempotency_blocks_duplicate_send(monkeypatch):
    from app.services import execution_desk as ex

    # Clear the cache so this test is independent of test order
    ex._recent_sends.clear()

    # Patch helpers to skip the broker round-trip
    monkeypatch.setattr(ex, "has_open_position", lambda *a, **kw: False)
    monkeypatch.setattr(ex, "has_pending_order", lambda *a, **kw: False)
    monkeypatch.setattr(ex, "resolve_symbol", lambda s: s)

    # Spy on mt5.order_send to count actual sends
    sent: list = []

    import MetaTrader5 as mt5_stub

    class FakeSymbolInfo:
        spread = 5
        swap_long = -1.0
        swap_short = -1.0
        swap_rollover3days = 5
        digits = 5
        trade_mode = 4  # FULL
        trade_stops_level = 0
        volume_step = 0.01
        volume_min = 0.01
        volume_max = 100.0
        margin_initial = 0.0
        point = 0.00001

    class FakeResult:
        retcode = mt5_stub.TRADE_RETCODE_DONE
        order = 99001
        comment = "ok"

    monkeypatch.setattr(mt5_stub, "symbol_info", lambda s: FakeSymbolInfo())
    monkeypatch.setattr(mt5_stub, "order_send", lambda req: sent.append(req) or FakeResult())

    # Patch the TradeJournalEntry write to no-op so we don't need a real DB
    class FakeDB:
        def add(self, *a, **kw): pass
        def commit(self): pass
        def rollback(self): pass
        def close(self): pass
    monkeypatch.setattr("app.core.database.SessionLocal", lambda: FakeDB())
    # Patch the Discord notifier so it doesn't try to hit a webhook
    monkeypatch.setattr(ex, "notify_trade_opened", lambda **kw: True)

    signal_data = {
        "signal": "ENTRY_BUY_LIMIT",
        "entry": 100.5,
        "sl": 100.0,
        "tp": 104.0,
        "lot_size": 0.10,
    }

    first = ex.execute_trade("XAUUSD", signal_data)
    second = ex.execute_trade("XAUUSD", signal_data)

    assert first["success"] is True, f"first call should have placed order: {first}"
    assert second["success"] is False
    assert second["reason"] == "idempotent_duplicate"
    assert len(sent) == 1, "mt5.order_send must only be invoked once for duplicate requests"
