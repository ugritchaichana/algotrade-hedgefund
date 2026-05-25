"""Trade manager 4-stage trailing state machine regression test.

Drives `trade_manager._manage_one` with a synthetic position + TradeState and asserts
the SL/stage progression matches the backtest contract:
  r >= 1.0 -> breakeven
  r >= 1.5 -> partial close + SL locked at +0.5R
  r >= 2.0 -> trail 1xATR behind max_favorable
"""

from types import SimpleNamespace
import pytest


class _FakeQuery:
    def __init__(self, db, model):
        self._db = db
        self._model = model
        self._filters = []

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        for row in self._db._store.get(self._model, []):
            return row
        return None

    def all(self):
        return list(self._db._store.get(self._model, []))


class FakeDB:
    """Minimal SQLAlchemy session stand-in. Just enough for _manage_one + slippage capture."""

    def __init__(self):
        self._store: dict = {}
        self.committed = False

    def add(self, row):
        self._store.setdefault(type(row), []).append(row)

    def query(self, model):
        return _FakeQuery(self, model)

    def commit(self):
        self.committed = True

    def rollback(self):
        pass

    def close(self):
        pass


def _make_state(entry=100.0, sl=99.0, atr=0.5, lot=0.10, is_buy=True):
    from app.core.database import TradeState
    return TradeState(
        ticket=12345,
        symbol="XAUUSD",
        status="OPEN",
        order_type="ENTRY_BUY_LIMIT" if is_buy else "ENTRY_SELL_LIMIT",
        entry_price=entry,
        sl=sl,
        tp=entry + 4.0 if is_buy else entry - 4.0,
        volume=lot,
        initial_volume=lot,
        initial_sl_distance=abs(entry - sl),
        max_favorable=entry,
        trail_stage=0,
        partial_closed=False,
        entry_atr=atr,
        trailing_active=False,
    )


def _make_pos(ticket=12345, symbol="XAUUSD", entry=100.0, current=100.5, sl=99.0, tp=104.0, is_buy=True):
    return SimpleNamespace(
        ticket=ticket,
        symbol=symbol,
        type=0 if is_buy else 1,  # ORDER_TYPE_BUY=0, ORDER_TYPE_SELL=1 (matches conftest stub)
        price_open=entry,
        price_current=current,
        sl=sl,
        tp=tp,
        volume=0.10,
    )


def test_stage1_breakeven_at_1R(monkeypatch):
    """When max_favorable reaches +1R, SL must move to entry (breakeven)."""
    from app.services import trade_manager as tm

    state = _make_state(entry=100.0, sl=99.0)  # 1R = 1.0 price
    db = FakeDB()
    db.add(state)

    pos = _make_pos(current=101.0)  # +1.0 -> exactly 1R

    sl_calls = []
    monkeypatch.setattr(tm, "modify_position_sl", lambda t, s, sl, tp: sl_calls.append(sl) or True)
    monkeypatch.setattr(tm, "partial_close_position", lambda t, s, v: True)

    tm._manage_one(db, pos)

    assert state.trail_stage == 1
    assert state.sl == pytest.approx(100.0)  # SL moved to entry
    assert sl_calls and sl_calls[0] == pytest.approx(100.0)


def test_stage2_partial_close_at_1_5R(monkeypatch):
    """At 1.5R: partial close 50% + SL locked at +0.5R."""
    from app.services import trade_manager as tm

    state = _make_state(entry=100.0, sl=99.0)
    db = FakeDB()
    db.add(state)

    pos = _make_pos(current=101.5)  # +1.5R

    monkeypatch.setattr(tm, "modify_position_sl", lambda *a, **kw: True)
    partial_calls = []
    monkeypatch.setattr(tm, "partial_close_position",
                        lambda t, s, v: partial_calls.append((t, s, v)) or True)

    tm._manage_one(db, pos)

    assert state.partial_closed is True
    assert partial_calls and partial_calls[0][2] == pytest.approx(0.05)  # 50% of 0.10
    # +0.5R from entry=100 means SL must be >= 100 + 0.5 * 1.0 = 100.5
    assert state.sl >= 100.5 - 1e-6
    assert state.trail_stage == 2


def test_sell_side_mirror_stage1(monkeypatch):
    """SELL direction: at -1R (price below entry by initial_sl_distance), SL -> entry."""
    from app.services import trade_manager as tm

    state = _make_state(entry=100.0, sl=101.0, is_buy=False)
    db = FakeDB()
    db.add(state)

    pos = _make_pos(entry=100.0, current=99.0, sl=101.0, tp=96.0, is_buy=False)

    sl_calls = []
    monkeypatch.setattr(tm, "modify_position_sl", lambda t, s, sl, tp: sl_calls.append(sl) or True)
    monkeypatch.setattr(tm, "partial_close_position", lambda *a, **kw: True)

    tm._manage_one(db, pos)

    assert state.trail_stage == 1
    assert state.sl == pytest.approx(100.0)
