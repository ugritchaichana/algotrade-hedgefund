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


def test_stop_loss_thai_label_is_noise():
    from app.main import _classify_attribution
    assert _classify_attribution("Stop Loss", -1.0) == "noise"


def test_trail_sl_above_1_5R_is_edge():
    from app.main import _classify_attribution
    assert _classify_attribution("TRAIL_SL", 2.0) == "edge"


def test_trail_sl_below_1_5R_is_noise():
    from app.main import _classify_attribution
    assert _classify_attribution("TRAIL_SL", 1.0) == "noise"


def test_manual_close_is_noise():
    from app.main import _classify_attribution
    assert _classify_attribution("Manual Close", 0.5) == "noise"


def test_none_exit_reason_is_open():
    from app.main import _classify_attribution
    assert _classify_attribution(None, None) == "open"
