"""Discord notifier per-category throttle test.

Goal: protect against scanner bugs flooding the webhook. Same-category posts within
THROTTLE_SECONDS must be dropped; different categories must NOT block each other.
"""

import time
import pytest


def test_throttle_blocks_same_category(monkeypatch):
    from app.services import discord_notifier as dn

    # Reset state
    dn._last_send_per_category.clear()
    posted: list = []

    monkeypatch.setattr(dn, "_post_with_retry", lambda payload, **kw: posted.append(payload) or True)
    # Force webhook URL to non-empty so the early return doesn't bite
    monkeypatch.setattr(dn, "DISCORD_WEBHOOK_URL", "https://example.test/dummy")

    ok1 = dn.send_discord_alert("first", category="signal:XAUUSD")
    ok2 = dn.send_discord_alert("second within 10s", category="signal:XAUUSD")

    assert ok1 is True
    assert ok2 is False
    assert len(posted) == 1


def test_throttle_does_not_cross_categories(monkeypatch):
    from app.services import discord_notifier as dn

    dn._last_send_per_category.clear()
    posted: list = []
    monkeypatch.setattr(dn, "_post_with_retry", lambda payload, **kw: posted.append(payload) or True)
    monkeypatch.setattr(dn, "DISCORD_WEBHOOK_URL", "https://example.test/dummy")

    a = dn.send_discord_alert("alpha", category="signal:XAUUSD")
    b = dn.send_discord_alert("bravo", category="opened:XAUUSD")
    c = dn.send_discord_alert("charlie", category="safety:Spread")

    assert a and b and c
    assert len(posted) == 3
