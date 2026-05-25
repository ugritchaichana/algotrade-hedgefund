"""Retry worker classifier — wrong classification = either retry storms (terminal->retry)
or missed signals (transient->stale). Lock in expected categorization."""

import pytest


def test_spread_is_transient():
    from app.services.retry_worker import classify_reason
    assert classify_reason("spread") == "transient"


def test_ping_too_high_is_transient():
    from app.services.retry_worker import classify_reason
    assert classify_reason("ping_too_high") == "transient"


def test_mt5_disconnected_is_transient():
    from app.services.retry_worker import classify_reason
    assert classify_reason("mt5_disconnected") == "transient"


def test_market_closed_is_transient():
    from app.services.retry_worker import classify_reason
    assert classify_reason("retcode_market_closed") == "transient"


def test_max_positions_is_stale():
    from app.services.retry_worker import classify_reason
    assert classify_reason("max_positions_reached") == "stale"


def test_daily_dd_is_stale():
    from app.services.retry_worker import classify_reason
    assert classify_reason("daily_dd_limit") == "stale"


def test_idempotent_duplicate_is_stale():
    from app.services.retry_worker import classify_reason
    assert classify_reason("idempotent_duplicate") == "stale"


def test_bad_params_is_terminal():
    from app.services.retry_worker import classify_reason
    assert classify_reason("bad_params") == "terminal"


def test_margin_insufficient_is_terminal():
    from app.services.retry_worker import classify_reason
    assert classify_reason("margin_insufficient") == "terminal"


def test_trade_mode_disabled_is_terminal():
    from app.services.retry_worker import classify_reason
    assert classify_reason("trade_mode_disabled") == "terminal"


def test_unknown_reason_is_unknown():
    from app.services.retry_worker import classify_reason
    assert classify_reason("foo_bar_made_up") == "unknown"


def test_none_is_unknown():
    from app.services.retry_worker import classify_reason
    assert classify_reason(None) == "unknown"
