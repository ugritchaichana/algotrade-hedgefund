import os
import json
import datetime
import logging
from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Float,
    DateTime,
    Text,
    Boolean,
    UniqueConstraint,
    inspect,
)
from sqlalchemy.orm import declarative_base, sessionmaker
from dotenv import load_dotenv

from app.core.asset_profiles import G1_ASSETS

load_dotenv()
log = logging.getLogger(__name__)

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://admin:password123@localhost:5432/hedgefund_cfd",
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


class ActionLog(Base):
    __tablename__ = "action_logs"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    source = Column(String(50))
    action = Column(String(50))
    message = Column(Text)


class HistoricalData(Base):
    __tablename__ = "historical_data"
    id = Column(Integer, primary_key=True, index=True)
    symbol = Column(String(20), index=True, nullable=False)
    timeframe = Column(String(10), index=True, nullable=False)
    time = Column(DateTime, index=True, nullable=False)
    open_price = Column(Float)
    high_price = Column(Float)
    low_price = Column(Float)
    close_price = Column(Float)
    tick_volume = Column(Integer)
    __table_args__ = (
        UniqueConstraint("symbol", "timeframe", "time", name="uq_hist_symtftime"),
    )


class SystemSettings(Base):
    __tablename__ = "system_settings"
    key = Column(String(50), primary_key=True, index=True)
    value = Column(Text)


class TradeState(Base):
    __tablename__ = "trade_states"
    id = Column(Integer, primary_key=True, index=True)
    ticket = Column(Integer, unique=True, index=True)
    symbol = Column(String(20), index=True)
    status = Column(String(20))
    order_type = Column(String(20))
    entry_price = Column(Float)
    sl = Column(Float)
    tp = Column(Float)
    volume = Column(Float)
    trailing_active = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(
        DateTime,
        default=datetime.datetime.utcnow,
        onupdate=datetime.datetime.utcnow,
    )


class EquitySnapshot(Base):
    """Account equity snapshot - written by scheduled job for equity curve plotting."""
    __tablename__ = "equity_snapshots"
    id = Column(Integer, primary_key=True, index=True)
    recorded_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    equity = Column(Float, nullable=False)
    balance = Column(Float, nullable=False)
    free_margin = Column(Float, nullable=False)
    margin_level = Column(Float, default=0.0)
    open_positions = Column(Integer, default=0)
    daily_pnl = Column(Float, default=0.0)
    floating_pnl = Column(Float, default=0.0)


class TradeJournalEntry(Base):
    """Durable per-trade record. Populated by execution_desk + trade_manager."""
    __tablename__ = "trade_journal"
    id = Column(Integer, primary_key=True, index=True)
    ticket = Column(Integer, unique=True, index=True)
    symbol = Column(String(20), index=True)
    side = Column(String(8))
    opened_at = Column(DateTime, index=True, default=datetime.datetime.utcnow)
    closed_at = Column(DateTime, nullable=True, index=True)
    entry_price = Column(Float)
    exit_price = Column(Float, nullable=True)
    sl = Column(Float)
    tp = Column(Float)
    lot = Column(Float)
    exit_reason = Column(String(30), nullable=True)
    r_multiple = Column(Float, nullable=True)
    pnl = Column(Float, nullable=True)
    slippage_entry = Column(Float, nullable=True)
    slippage_exit = Column(Float, nullable=True)
    signal_context_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


def _migrate_schema_if_needed():
    """Detect schema drift on critical tables; drop + recreate when columns mismatch.

    Safe to call repeatedly — only drops when the live schema disagrees with the model.
    No-ops once the schema is aligned.
    """
    inspector = inspect(engine)
    drops = []

    if inspector.has_table("historical_data"):
        live_cols = {c["name"] for c in inspector.get_columns("historical_data")}
        expected = {
            "id",
            "symbol",
            "timeframe",
            "time",
            "open_price",
            "high_price",
            "low_price",
            "close_price",
            "tick_volume",
        }
        if not expected.issubset(live_cols):
            log.warning("historical_data schema drift detected — dropping for recreate")
            drops.append(HistoricalData.__table__)

    if inspector.has_table("trade_states"):
        cols = {c["name"]: c for c in inspector.get_columns("trade_states")}
        if "trailing_active" in cols:
            # SQLAlchemy reports types via .type — accept Boolean OR any String<->Bool migration we just did
            type_str = str(cols["trailing_active"]["type"]).upper()
            if "VARCHAR" in type_str or "STRING" in type_str:
                log.warning("trade_states.trailing_active is String — dropping for Bool recreate")
                drops.append(TradeState.__table__)

    if drops:
        for tbl in drops:
            tbl.drop(bind=engine, checkfirst=True)


def init_db():
    """Run migrations + create any missing tables + seed defaults. Call once on startup."""
    _migrate_schema_if_needed()
    Base.metadata.create_all(bind=engine)
    _seed_default_settings()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def log_action(source: str, action: str, message: str) -> None:
    db = SessionLocal()
    try:
        db.add(ActionLog(source=source, action=action, message=message))
        db.commit()
    except Exception as e:
        log.error("log_action failed: %s", e)
        db.rollback()
    finally:
        db.close()


def _seed_default_settings() -> None:
    """Seed initial settings ONLY if they don't already exist. Never overwrite user customization."""
    db = SessionLocal()
    try:
        defaults = {
            "core_assets": json.dumps(G1_ASSETS),
            "auto_trade_enabled": "true",
            "risk_tolerance": "Balanced",  # Conservative / Balanced / Aggressive
            "discord_webhook": "",
            "max_open_positions": "5",
            "max_daily_drawdown_pct": "3.0",
        }
        existing = {row.key for row in db.query(SystemSettings).all()}
        for key, value in defaults.items():
            if key not in existing:
                db.add(SystemSettings(key=key, value=value))
        db.commit()
    except Exception as e:
        log.error("_seed_default_settings failed: %s", e)
        db.rollback()
    finally:
        db.close()


def reset_core_assets_to_defaults() -> None:
    """Explicit user-initiated reset. Called only from POST /api/settings/reset."""
    db = SessionLocal()
    try:
        row = db.query(SystemSettings).filter(SystemSettings.key == "core_assets").first()
        if row:
            row.value = json.dumps(G1_ASSETS)
        else:
            db.add(SystemSettings(key="core_assets", value=json.dumps(G1_ASSETS)))
        db.commit()
    finally:
        db.close()
