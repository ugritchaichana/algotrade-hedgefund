"""Equity recorder — captures MT5 account snapshot to Postgres on schedule."""

import datetime
import logging
import MetaTrader5 as mt5
from app.core.database import SessionLocal, EquitySnapshot

log = logging.getLogger(__name__)


def capture_snapshot() -> bool:
    """Single-shot equity capture. Called by scheduler."""
    info = mt5.account_info()
    if info is None:
        log.warning("equity_recorder: mt5.account_info() returned None — skipping")
        return False

    # Today's realized PnL from closed deals since 00:00 UTC
    today = datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(today, datetime.datetime.now(datetime.timezone.utc))
    daily_pnl = 0.0
    if deals:
        daily_pnl = sum(d.profit + d.commission + d.swap for d in deals if d.entry == mt5.DEAL_ENTRY_OUT)

    positions = mt5.positions_get() or []
    floating = sum(p.profit for p in positions)

    db = SessionLocal()
    try:
        snap = EquitySnapshot(
            equity=info.equity,
            balance=info.balance,
            free_margin=info.margin_free,
            margin_level=info.margin_level,
            open_positions=len(positions),
            daily_pnl=round(daily_pnl, 2),
            floating_pnl=round(floating, 2),
        )
        db.add(snap)
        db.commit()
        log.info("equity_snapshot: equity=%.2f balance=%.2f open=%d daily_pnl=%.2f",
                 info.equity, info.balance, len(positions), daily_pnl)
        return True
    except Exception as e:
        log.exception("equity_snapshot failed: %s", e)
        return False
    finally:
        db.close()
