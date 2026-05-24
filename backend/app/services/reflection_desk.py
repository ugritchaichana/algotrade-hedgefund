"""Daily AI Reflection Desk.

Fetches today's closed MT5 trades + today's action logs, sends them to Xiaomi MiMo
for a self-critique, persists the result in ChromaDB long-term memory, and notifies
Discord. Designed to run end-of-day (after market close) but can be invoked any time.

Invocation:
  - Via API:  POST /api/reflection/run-daily   (wired in main.py)
  - Via CLI:  python -m app.services.reflection_desk
"""

import os
import json
import logging
import datetime
import requests
import MetaTrader5 as mt5
from dotenv import load_dotenv

from app.core.database import SessionLocal, ActionLog
from app.services.ai_memory import store_memory
from app.services.discord_notifier import send_discord_alert
from app.services.mt5_connector import init_mt5

load_dotenv()
log = logging.getLogger(__name__)


def _get_todays_closed_trades() -> list[dict]:
    now = datetime.datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    deals = mt5.history_deals_get(midnight, now)
    if deals is None:
        return []

    trades = []
    for d in deals:
        if d.entry == mt5.DEAL_ENTRY_OUT:  # only closing deals
            trades.append({
                "symbol": d.symbol,
                "profit": d.profit,
                "volume": d.volume,
                "type": "BUY" if d.type == mt5.DEAL_TYPE_SELL else "SELL",  # closing a buy is a sell deal
                "time": datetime.datetime.fromtimestamp(d.time).strftime("%Y-%m-%d %H:%M:%S"),
            })
    return trades


def _get_todays_logs() -> str:
    db = SessionLocal()
    try:
        now = datetime.datetime.now()
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        rows = db.query(ActionLog).filter(ActionLog.timestamp >= midnight).all()
        return "\n".join(
            f"[{r.timestamp}] {r.source}/{r.action}: {r.message}" for r in rows
        )
    finally:
        db.close()


def run_daily_reflection() -> dict:
    """Return dict with keys: ok, reflection, profit, doc_id, error.

    Caller MUST handle the case where MT5 was not initialized at import time
    (e.g. CLI use) — we attempt re-init on demand.
    """
    if not mt5.terminal_info():
        if not init_mt5():
            return {"ok": False, "error": "MT5 init failed", "reflection": None, "profit": 0.0}

    trades = _get_todays_closed_trades()
    logs_text = _get_todays_logs()
    total_profit = sum(t["profit"] for t in trades) if trades else 0.0

    api_key = os.getenv("MIMO_API_KEY")
    base_url = os.getenv("MIMO_BASE_URL", "https://token-plan-sgp.xiaomimimo.com/v1")
    model = os.getenv("MIMO_MODEL", "mimo-v2.5-pro")

    if not api_key:
        return {"ok": False, "error": "MIMO_API_KEY not set", "reflection": None, "profit": total_profit}

    prompt = f"""You are a Senior Quantitative Trading Developer reviewing today's autonomous trading performance.

Closed trades today:
{json.dumps(trades, indent=2)}

Total P/L: ${total_profit:.2f}

Action logs (system decisions):
{logs_text or '(none)'}

Your task:
1. Summarize what went well.
2. Identify what went wrong (SLs too tight? traded into news? false breakouts?).
3. Provide strict algorithmic adjustments to improve long-term survival
   (e.g. "Increase ATR multiplier from 1.5 to 2.0", "Skip trades 1h before NFP").
   Be brutally honest — focus on long-term survival, not short-term wins.
"""

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a professional Hedge Fund AI critic."},
            {"role": "user", "content": prompt},
        ],
    }

    try:
        r = requests.post(f"{base_url}/chat/completions", headers=headers, json=payload, timeout=120)
        r.raise_for_status()
        data = r.json()
        reflection_text = data["choices"][0]["message"]["content"]
    except Exception as e:
        log.error("MiMo call failed: %s", e)
        return {"ok": False, "error": str(e), "reflection": None, "profit": total_profit}

    doc_id = store_memory(
        reflection_text,
        metadata={
            "date": str(datetime.date.today()),
            "profit": float(total_profit),
            "trade_count": len(trades),
        },
    )

    send_discord_alert(
        f"**Daily AI Reflection complete**\nP/L: **${total_profit:.2f}** across **{len(trades)}** trades. Critique saved to long-term memory."
    )

    return {
        "ok": True,
        "reflection": reflection_text,
        "profit": total_profit,
        "doc_id": doc_id,
        "trade_count": len(trades),
        "error": None,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    result = run_daily_reflection()
    print(json.dumps(result, indent=2, ensure_ascii=False))
    mt5.shutdown()
