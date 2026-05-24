import os
import time
import logging
import requests
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")

# Discord limits per https://discord.com/developers/docs/resources/channel
_MAX_DESCRIPTION = 4000  # leave headroom under 4096
_MAX_FIELD_VALUE = 1000  # leave headroom under 1024
_MAX_CONTENT = 1900       # leave headroom under 2000


def _truncate(text: str, limit: int) -> str:
    if text is None:
        return ""
    s = str(text)
    if len(s) <= limit:
        return s
    return s[: limit - 3] + "..."


def _post_with_retry(payload: dict, attempts: int = 3, base_delay: float = 1.0) -> bool:
    if not DISCORD_WEBHOOK_URL:
        log.warning("DISCORD_WEBHOOK_URL not set; skipping notification")
        return False
    for i in range(attempts):
        try:
            r = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=5)
            if r.status_code in (200, 204):
                return True
            # Rate limited — honor retry_after if Discord provided it
            if r.status_code == 429:
                try:
                    retry_after = float(r.json().get("retry_after", base_delay * (2 ** i)))
                except Exception:
                    retry_after = base_delay * (2 ** i)
                log.warning("Discord rate-limited, sleeping %.2fs", retry_after)
                time.sleep(min(retry_after, 10.0))
                continue
            log.warning("Discord post non-success %s: %s", r.status_code, r.text[:200])
        except requests.RequestException as e:
            log.warning("Discord post attempt %d failed: %s", i + 1, e)
        time.sleep(base_delay * (2 ** i))
    return False


def send_discord_alert(message: str, embed: dict | None = None) -> bool:
    data = {
        "content": _truncate(message, _MAX_CONTENT),
        "username": "HedgeFund AI",
        "avatar_url": "https://cdn-icons-png.flaticon.com/512/12185/12185202.png",
    }
    if embed:
        # Sanitize embed fields against Discord limits
        if "description" in embed:
            embed["description"] = _truncate(embed["description"], _MAX_DESCRIPTION)
        if "fields" in embed:
            for f in embed["fields"]:
                if "value" in f:
                    f["value"] = _truncate(f["value"], _MAX_FIELD_VALUE)
        data["embeds"] = [embed]
    return _post_with_retry(data)


def notify_trade_signal(symbol: str, signal_data: dict) -> bool:
    signal = signal_data.get("signal", "")
    if signal == "WAITING":
        return False

    color = (
        0x00FF00 if "BUY" in signal
        else 0xFF0000 if "SELL" in signal
        else 0xFFFF00
    )

    embed = {
        "title": f"TRADE SIGNAL: {symbol}",
        "description": signal_data.get("action", ""),
        "color": color,
        "fields": [
            {"name": "Signal", "value": str(signal), "inline": True},
            {"name": "Regime", "value": str(signal_data.get("regime", "")), "inline": True},
            {"name": "Confidence", "value": f"{signal_data.get('confidence', 0)}%", "inline": True},
            {"name": "Entry", "value": str(signal_data.get("entry", "N/A")), "inline": True},
            {"name": "Stop Loss", "value": str(signal_data.get("sl", "N/A")), "inline": True},
            {"name": "Take Profit", "value": str(signal_data.get("tp", "N/A")), "inline": True},
            {"name": "Lot Size", "value": str(signal_data.get("lot_size", "N/A")), "inline": True},
            {"name": "RSI", "value": str(signal_data.get("rsi", "")), "inline": True},
            {"name": "ATR", "value": str(signal_data.get("atr", "")), "inline": True},
        ],
        "footer": {"text": "AlgoTrade HedgeFund System"},
    }
    return send_discord_alert(f"**{symbol}** setup detected", embed=embed)


def notify_safety_event(title: str, detail: str) -> bool:
    """Use for spread protection, kill switch trips, DD limit hits, ping warnings, etc."""
    embed = {
        "title": f"SAFETY: {title}",
        "description": detail,
        "color": 0xFF8800,
        "footer": {"text": "AlgoTrade HedgeFund System"},
    }
    return send_discord_alert(f"Safety event: **{title}**", embed=embed)
