"""Backtest spread-aware cost test — per-candle spread (when available) should
override flat spread_pips for realistic backtest simulation."""

import pytest


def test_cost_with_flat_spread_when_no_actual():
    from app.services.backtest_engine import _cost
    meta = {"tick_size": 0.00001, "tick_value": 1.0, "pip_size": 0.0001, "point": 0.00001}
    # No actual_spread_points -> flat spread_pips=2 + slippage_pips=1 = 3 pips
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta)
    assert cost == pytest.approx(30.0, abs=0.01)


def test_cost_with_actual_spread_overrides_flat():
    from app.services.backtest_engine import _cost
    meta = {"tick_size": 0.00001, "tick_value": 1.0, "pip_size": 0.0001, "point": 0.00001}
    # actual_spread = 20 points = 2 pips. slippage model = 0.3 * 2 = 0.6 pips.
    # Total cost = (2 + 0.6) * pip_value(=10) * lot(=1) = 26
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta,
                 actual_spread_points=20.0)
    assert cost == pytest.approx(26.0, abs=0.1)


def test_cost_high_spread_scenario():
    """News-event spike — spread 10x normal. Cost should reflect that."""
    from app.services.backtest_engine import _cost
    meta = {"tick_size": 0.00001, "tick_value": 1.0, "pip_size": 0.0001, "point": 0.00001}
    # actual_spread = 200 points = 20 pips. slippage = 6 pips. total = 26 pips * $10 = $260
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta,
                 actual_spread_points=200.0)
    assert cost == pytest.approx(260.0, abs=1.0)


def test_cost_zero_actual_spread_falls_back_to_flat():
    """REGRESSION: broker historical M1 with spread=0 must NOT yield cost=0.
    Bug 2026-05-26: zero-spread treated as valid → cost = 0 → optimizer PF exploded
    to 600+. Fix: treat 0 as missing, fallback to flat spread_pips."""
    from app.services.backtest_engine import _cost
    meta = {"tick_size": 0.00001, "tick_value": 1.0, "pip_size": 0.0001, "point": 0.00001}
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta,
                 actual_spread_points=0)
    # Must equal flat: (2+1) pips * $10 * 1 lot = $30
    assert cost == pytest.approx(30.0, abs=0.01)


def test_cost_negative_actual_spread_falls_back_to_flat():
    """Defense in depth: corrupted negative spread also falls back."""
    from app.services.backtest_engine import _cost
    meta = {"tick_size": 0.00001, "tick_value": 1.0, "pip_size": 0.0001, "point": 0.00001}
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta,
                 actual_spread_points=-5)
    assert cost == pytest.approx(30.0, abs=0.01)


def test_cost_missing_point_meta_fallback_to_flat():
    """Without meta['point'], can't convert points->pips. Should fall back to flat."""
    from app.services.backtest_engine import _cost
    meta_no_point = {"tick_size": 0.00001, "tick_value": 1.0, "pip_size": 0.0001}
    # point key missing — falls back to flat
    cost = _cost(spread_pips=2.0, slippage_pips=1.0, lot=1.0, meta=meta_no_point,
                 actual_spread_points=50.0)
    assert cost == pytest.approx(30.0, abs=0.01)  # flat 3 pips * 10 = 30
