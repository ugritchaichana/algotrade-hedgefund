"""Cost-model regression test. Catches the 10x pip-vs-point bug that hit early backtests.

A 5-digit FX symbol (pip_size 0.0001, tick_size 0.00001, tick_value 1) with 2 pip
spread + 1 pip slippage on 1 lot should cost ~$3 round trip — NOT $30.
"""

import pytest


def test_cost_5digit_fx_one_lot():
    from app.services.backtest_engine import _cost
    meta = {
        "tick_size": 0.00001,   # 5-digit FX
        "tick_value": 1.0,       # $1 per 0.00001 move on 1 lot
        "pip_size": 0.0001,      # 1 pip = 10 points
    }
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta)
    # 3 pips × $10/pip/lot × 1 lot = $30. (5-digit FX: pip_value = pip_size × point_value
    # = 0.0001 × 100000 = $10/pip/lot on a standard 100k contract size.)
    assert cost == pytest.approx(30.0, abs=0.01)


def test_cost_xau_one_lot():
    from app.services.backtest_engine import _cost
    meta = {
        "tick_size": 0.01,
        "tick_value": 1.0,
        "pip_size": 0.10,
    }
    # 3 pips × 0.10 × (1/0.01) × 1 = 30
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta)
    assert cost == pytest.approx(30.0, abs=0.01)


def test_cost_zero_lot_returns_zero():
    from app.services.backtest_engine import _cost
    meta = {"tick_size": 0.00001, "tick_value": 1.0, "pip_size": 0.0001}
    assert _cost(2.0, 1.0, 0.0, meta) == 0.0
