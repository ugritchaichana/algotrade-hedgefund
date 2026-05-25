"""Retry queue worker — drains transient-failure trade attempts.

Failed trades from `execute_trade` (spread spike, MT5 disconnect, broker requote, market
closed) are enqueued by caller in `pending_actions` table. This worker runs every 1 min
(piggyback on the M1 ingest cadence) and retries each pending action when conditions
might have recovered.

Classification of failure reasons (matches execution_desk return values):
  TRANSIENT (retry): spread, ping_too_high, mt5_disconnected,
                     retcode_market_closed, retcode_requote, retcode_no_quotes
  STALE (don't retry — signal too old now): max_positions_reached, daily_dd_limit,
                                            max_daily_trades, kill_switch_off,
                                            idempotent_duplicate
  TERMINAL (never retry): bad_params, symbol_missing, duplicate, trade_mode_disabled,
                          stops_level_violation, margin_insufficient
"""

import json
import logging
import datetime
import MetaTrader5 as mt5

from app.core.database import SessionLocal, PendingAction, log_action

log = logging.getLogger(__name__)

TRANSIENT_REASONS = {
    "spread",
    "ping_too_high",
    "mt5_disconnected",
    "retcode_market_closed",
    "retcode_requote",
    "retcode_no_quotes",
    "retcode_not_done",  # generic retcode failure — try again
    "mt5_disconnect",
}

# Reasons where retrying makes sense only if condition was instantaneous (broker glitch)
# but not if pre-condition stays — don't enqueue at all per stale_classification.
STALE_REASONS = {
    "max_positions_reached",
    "daily_dd_limit",
    "max_daily_trades",
    "kill_switch_off",
    "idempotent_duplicate",
}

TERMINAL_REASONS = {
    "bad_params",
    "symbol_missing",
    "duplicate",  # already have position in same direction
    "trade_mode_disabled",
    "stops_level_violation",
    "margin_insufficient",
}


def classify_reason(reason: str | None) -> str:
    """Return 'transient', 'stale', 'terminal', or 'unknown'."""
    if reason is None:
        return "unknown"
    if reason in TRANSIENT_REASONS:
        return "transient"
    if reason in STALE_REASONS:
        return "stale"
    if reason in TERMINAL_REASONS:
        return "terminal"
    return "unknown"


def enqueue_retry(symbol: str, signal_data: dict, reason: str, error: str,
                  expires_in_hours: int = 4) -> bool:
    """Caller (background_quant_analysis on trade failure) invokes this.

    Returns True if enqueued. Returns False if reason is stale/terminal/unknown — no enqueue.
    """
    klass = classify_reason(reason)
    if klass != "transient":
        log.debug("enqueue_retry skipped: reason=%s class=%s", reason, klass)
        return False

    db = SessionLocal()
    try:
        expires_at = datetime.datetime.utcnow() + datetime.timedelta(hours=expires_in_hours)
        action = PendingAction(
            type="trade_entry",
            symbol=symbol,
            signal_data_json=json.dumps(signal_data, default=str),
            attempts=0,
            max_attempts=12,
            last_reason=reason,
            last_error=str(error)[:500],
            status="pending",
            expires_at=expires_at,
        )
        db.add(action)
        db.commit()
        log_action("Retry Worker", "Enqueued", f"{symbol} reason={reason}")
        log.info("Enqueued retry: symbol=%s reason=%s expires_at=%s", symbol, reason, expires_at)
        return True
    except Exception as e:
        log.exception("enqueue_retry failed: %s", e)
        db.rollback()
        return False
    finally:
        db.close()


def drain_pending_actions(is_shutting_down_fn=None) -> dict:
    """Scheduled job — runs every 1 min. Processes pending_actions:
    - Expire records past expires_at -> status='expired'
    - Try each pending: call execute_trade with original signal_data
    - On success -> status='succeeded', resolved_ticket set
    - On failure -> increment attempts; if max_attempts -> status='expired'
    """
    if is_shutting_down_fn and is_shutting_down_fn():
        return {"skipped": "shutting_down"}

    from app.services.execution_desk import execute_trade  # late import (circular)

    db = SessionLocal()
    stats = {"processed": 0, "succeeded": 0, "failed": 0, "expired": 0}
    try:
        now = datetime.datetime.utcnow()

        # Expire stale records
        stale = (db.query(PendingAction)
                 .filter(PendingAction.status == "pending",
                         PendingAction.expires_at < now)
                 .all())
        for s in stale:
            s.status = "expired"
        if stale:
            db.commit()
            stats["expired"] = len(stale)

        # Process pending
        pending = (db.query(PendingAction)
                   .filter(PendingAction.status == "pending",
                           PendingAction.expires_at >= now)
                   .order_by(PendingAction.created_at.asc())
                   .all())
        for p in pending:
            stats["processed"] += 1
            try:
                signal_data = json.loads(p.signal_data_json)
            except Exception:
                p.status = "expired"
                p.last_error = "signal_data_json corrupted"
                continue

            result = execute_trade(p.symbol, signal_data)
            p.attempts += 1
            p.last_attempt_at = now

            if result.get("success"):
                p.status = "succeeded"
                p.resolved_ticket = result.get("ticket")
                p.last_reason = "ok"
                stats["succeeded"] += 1
                log_action("Retry Worker", "Retry Succeeded",
                           f"{p.symbol} ticket={p.resolved_ticket} attempt={p.attempts}")
            else:
                reason = result.get("reason", "unknown")
                p.last_reason = reason
                p.last_error = (result.get("error") or "")[:500]
                klass = classify_reason(reason)
                # If now reclassified as terminal/stale OR exceeded attempts, give up
                if klass in ("terminal", "stale") or p.attempts >= p.max_attempts:
                    p.status = "expired"
                    stats["expired"] += 1
                else:
                    stats["failed"] += 1

        db.commit()
    except Exception as e:
        log.exception("drain_pending_actions failed: %s", e)
        db.rollback()
    finally:
        db.close()

    return stats
