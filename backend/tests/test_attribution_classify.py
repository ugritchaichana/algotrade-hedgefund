"""Edge-vs-Noise classifier — the key Phase 2 decision tool. Wrong classification
would mislead the deploy-vs-defer decision, so locking in expected behavior."""

import pytest


def test_partial_tp_is_edge():
    from app.main import _classify_attribution
    assert _classify_attribution("PARTIAL_TP", 1.5) == "edge"


def test_full_tp_is_edge():
    from app.main import _classify_attribution
    assert _classify_attribution("TP", 4.0) == "edge"


def test_initial_sl_is_noise():
    from app.main import _classify_attribution
    assert _classify_attribution("SL", -1.0) == "noise"


def test_stop_loss_at_low_r_is_noise():
    """Initial SL hit at r < 1.5 = noise."""
    from app.main import _classify_attribution
    assert _classify_attribution("Stop Loss", -1.0) == "noise"


def test_stop_loss_at_high_r_is_edge():
    """REGRESSION 2026-05-26: 'Stop Loss' from MT5 DEAL_REASON_SL on a TRAILED stop-out
    must be classified as edge (the trail did its job), not noise (which would happen
    if classifier looked only at the reason string)."""
    from app.main import _classify_attribution
    assert _classify_attribution("Stop Loss", 2.5) == "edge"
    assert _classify_attribution("Stop Loss", 1.5) == "edge"
    assert _classify_attribution("Stop Loss", 1.4) == "noise"  # just below threshold


def test_trail_sl_above_1_5R_is_edge():
    from app.main import _classify_attribution
    assert _classify_attribution("TRAIL_SL", 2.0) == "edge"


def test_trail_sl_below_1_5R_is_noise():
    from app.main import _classify_attribution
    assert _classify_attribution("TRAIL_SL", 1.0) == "noise"


def test_manual_trail_default_classified_via_r():
    """trade_manager._process_closed_trade defaults exit_reason to 'Manual/Trail' when
    MT5 DEAL_REASON doesn't match SL/TP/CLIENT. Treat as ambiguous SL — use r_multiple."""
    from app.main import _classify_attribution
    assert _classify_attribution("Manual/Trail", 2.0) == "edge"
    assert _classify_attribution("Manual/Trail", 0.5) == "noise"


def test_manual_close_is_mixed():
    """Manual user close = mixed (intervention, can't conclude edge/noise)."""
    from app.main import _classify_attribution
    assert _classify_attribution("Manual Close", 0.5) == "mixed"


def test_none_exit_reason_is_open():
    from app.main import _classify_attribution
    assert _classify_attribution(None, None) == "open"
