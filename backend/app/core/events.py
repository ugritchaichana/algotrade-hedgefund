"""Real-time WebSocket event broadcaster.

Thread-safe helper for service modules to push events to all connected clients without
creating circular imports with `app.main`. Lifespan attaches the event loop + manager;
service code calls `broadcast_event(type, payload)` from sync OR async contexts.

Per-event-type throttle prevents scanner-bug floods (e.g., HEALTH_DELTA only fires when
status actually changes, OPTIMIZE_PROGRESS at most 2 fires/sec/job).
"""

import asyncio
import datetime
import logging
import time
from typing import Callable, Optional

log = logging.getLogger(__name__)

_loop: Optional[asyncio.AbstractEventLoop] = None
_manager = None
_shutdown_check: Callable[[], bool] = lambda: False

# Per-event-type last-broadcast timestamps for throttling
_last_broadcast: dict[str, float] = {}

# Throttle config: type -> min seconds between broadcasts
_THROTTLE_SECONDS: dict[str, float] = {
    "OPTIMIZE_PROGRESS": 0.5,    # 2 Hz max
    "INGEST_TICK": 30.0,         # at most every 30s per category
    "HEALTH_DELTA": 5.0,
}


def attach(loop: asyncio.AbstractEventLoop, manager, shutdown_check: Callable[[], bool]) -> None:
    """Wire up — called from main.lifespan after manager + loop are ready."""
    global _loop, _manager, _shutdown_check
    _loop = loop
    _manager = manager
    _shutdown_check = shutdown_check
    log.info("events.attach: ready (loop=%s)", id(loop))


def broadcast_event(event_type: str, payload: dict, throttle_key: str | None = None) -> None:
    """Thread-safe broadcast. Returns immediately; the actual send happens on the event loop.

    Drops silently if the loop isn't attached or backend is shutting down. Best-effort —
    never raises, never blocks. The event payload is JSON-serialized inside `manager.broadcast`.

    throttle_key: override the default per-event-type throttle. Useful for per-job or
    per-symbol throttling (e.g. throttle_key=f"signal:{sym}").
    """
    if _loop is None or _manager is None:
        return
    if _shutdown_check():
        return

    # Throttle check
    key = throttle_key or event_type
    min_interval = _THROTTLE_SECONDS.get(event_type)
    if min_interval is not None:
        now = time.time()
        last = _last_broadcast.get(key, 0.0)
        if now - last < min_interval:
            return
        _last_broadcast[key] = now

    message = {
        "type": event_type,
        "data": payload,
        "ts": datetime.datetime.utcnow().isoformat(),
    }
    try:
        asyncio.run_coroutine_threadsafe(_manager.broadcast(message), _loop)
    except Exception as e:
        log.warning("broadcast_event(%s) failed: %s", event_type, e)
