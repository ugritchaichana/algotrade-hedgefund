"""Macro Desk — ForexFactory economic calendar + Xiaomi MiMo briefing.

Improved over v1: instead of briefing only the first 4 assets in core_assets,
we group all configured assets by asset class (Forex / Indices / Commodities / Crypto)
and run one MiMo call per class. The per-asset impacts dict is merged across all
classes, so every configured asset gets a macro context.

Cost: ~2.5-3x tokens vs v1 (4 calls instead of 1), but covers 28 assets instead of 4.
Cached behind the same news-hash invalidation so re-calls are rare.
"""

import os
import time
import json
import hashlib
import logging
import datetime
import requests

from app.core.database import SessionLocal, SystemSettings
from app.core.asset_profiles import ASSET_PROFILES

log = logging.getLogger(__name__)

# Caches
_cached_briefing: dict | None = None
_last_news_hash: str | None = None

_news_cache: list | None = None
_news_cache_time: float = 0.0
_NEWS_TTL = 600

NEWS_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"


def fetch_economic_news() -> list[dict]:
    """Fetch + filter today's High/Medium impact events with a 10-min TTL cache.
    Returns a list of news dicts (possibly a single placeholder if there's no news).
    Falls back to stale cache on transient network failure.
    """
    global _news_cache, _news_cache_time
    now = time.time()
    if _news_cache and (now - _news_cache_time) < _NEWS_TTL:
        return _news_cache

    try:
        r = requests.get(NEWS_URL, timeout=10)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        log.warning("fetch_economic_news failed: %s", e)
        if _news_cache:
            return _news_cache
        return [{"title": "Could not fetch live news.", "country": "ALL", "impact": "Unknown"}]

    today = datetime.datetime.now().strftime("%Y-%m-%d")
    filtered = []
    for item in data:
        if item.get("date", "").startswith(today) and item.get("impact") in ("High", "Medium"):
            filtered.append({
                "title": item.get("title"),
                "country": item.get("country"),
                "impact": item.get("impact"),
                "time": item.get("date"),
                "forecast": item.get("forecast", ""),
                "previous": item.get("previous", ""),
                "actual": item.get("actual", ""),
            })

    result = filtered or [{"title": "No major high-impact news today.", "country": "ALL", "impact": "Low", "time": today}]
    _news_cache, _news_cache_time = result, now
    return result


def _call_mimo_for_class(news_items: list[dict], focused_assets: list[str]) -> dict:
    """Single MiMo call for one asset class. Returns parsed JSON dict or fallback shape on failure."""
    api_key = os.getenv("MIMO_API_KEY")
    base_url = os.getenv("MIMO_BASE_URL", "https://token-plan-sgp.xiaomimimo.com/v1")
    model = os.getenv("MIMO_MODEL", "mimo-v2.5-pro")

    if not api_key:
        return {"bias": "Unknown", "summary": "MIMO_API_KEY missing", "impacts": {}}

    news_lines = [
        f"- {n.get('title', 'Unknown')} (Impact: {n.get('impact', 'Low')}) | Forecast: {n.get('forecast', 'N/A')}, Actual: {n.get('actual', 'N/A')}"
        for n in news_items
    ]
    news_text = "\n".join(news_lines)
    assets_str = ", ".join(focused_assets)

    prompt = f"""You are the Macroeconomic Desk of a hedge fund.
Analyze today's economic news and produce a morning briefing in English.
If 'Actual' deviates from 'Forecast', highlight expected market reaction.
State the bias as Risk-On / Risk-Off / Neutral and what it means for {assets_str}.

Return ONLY a JSON object matching this exact shape (no markdown fences):

{{
    "bias": "Risk-On|Risk-Off|Neutral",
    "sentiment_shift": "short text e.g. Shifted from Risk-Off to Risk-On",
    "confidence_score": "Low|Medium|High",
    "volatility": "Low|Moderate|Extreme",
    "summary": "1-2 sentences",
    "events_timeline": [
        {{"time": "HH:MM", "event": "name", "impact": "High|Medium"}}
    ],
    "impacts": {{
        "{focused_assets[0] if focused_assets else 'EXAMPLE'}": {{
            "badge": "Good News|Bad News|Neutral",
            "reasoning": "1 sentence",
            "trade_idea": "1 sentence"
        }}
    }}
}}

Keys inside "impacts" MUST exactly match these assets: {assets_str}

News:
{news_text}
"""

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a professional hedge fund macro analyst."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 2000,
    }

    try:
        r = requests.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=90,
        )
        if r.status_code != 200:
            log.warning("MiMo non-200 for %s: %s", assets_str, r.text[:200])
            return {"bias": "Error", "summary": f"AI error: {r.status_code}", "impacts": {}}

        content = r.json()["choices"][0]["message"]["content"]
        if "```" in content:
            content = content.replace("```json", "").replace("```", "").strip()
        return json.loads(content)
    except json.JSONDecodeError as e:
        log.warning("MiMo JSON parse failed for %s: %s", assets_str, e)
        return {"bias": "Unknown", "summary": content if 'content' in locals() else "parse error", "impacts": {}}
    except Exception as e:
        log.warning("MiMo call failed for %s: %s", assets_str, e)
        return {"bias": "Error", "summary": str(e), "impacts": {}}


def _group_assets_by_class(symbols: list[str]) -> dict[str, list[str]]:
    """Group symbols by ASSET_PROFILES.class. Unknown class symbols go to 'Other'."""
    groups: dict[str, list[str]] = {}
    for sym in symbols:
        klass = ASSET_PROFILES.get(sym, {}).get("class", "Other")
        groups.setdefault(klass, []).append(sym)
    return groups


def _merge_briefings(per_class: dict[str, dict]) -> dict:
    """Combine per-class briefings into a single top-level structure.

    - bias: most common across classes (with majority vote; tie-break = first)
    - summary: concatenated class-by-class
    - events_timeline: union (deduplicated by time+event)
    - impacts: union (assets are guaranteed disjoint across classes)
    """
    if not per_class:
        return {"bias": "Unknown", "summary": "No briefings generated.", "impacts": {}}

    # Bias majority vote
    bias_counts: dict[str, int] = {}
    for b in per_class.values():
        bias = b.get("bias", "Unknown")
        bias_counts[bias] = bias_counts.get(bias, 0) + 1
    top_bias = max(bias_counts, key=bias_counts.get)

    # Summary concat
    summary_parts = []
    for klass, brief in per_class.items():
        s = brief.get("summary", "").strip()
        if s:
            summary_parts.append(f"[{klass}] {s}")
    summary = " ".join(summary_parts) if summary_parts else "No macro signal."

    # Events: dedup by (time, event)
    events: list[dict] = []
    seen = set()
    for brief in per_class.values():
        for ev in brief.get("events_timeline", []) or []:
            key = (ev.get("time"), ev.get("event"))
            if key not in seen:
                seen.add(key)
                events.append(ev)

    # Impacts merge
    impacts: dict[str, dict] = {}
    for brief in per_class.values():
        for asset, info in (brief.get("impacts") or {}).items():
            impacts[asset] = info

    # Pick a representative confidence + volatility (just use first non-empty)
    confidence_score = "Medium"
    volatility = "Low"
    sentiment_shift = ""
    for brief in per_class.values():
        if confidence_score == "Medium" and brief.get("confidence_score"):
            confidence_score = brief["confidence_score"]
        if volatility == "Low" and brief.get("volatility"):
            volatility = brief["volatility"]
        if not sentiment_shift and brief.get("sentiment_shift"):
            sentiment_shift = brief["sentiment_shift"]

    return {
        "bias": top_bias,
        "sentiment_shift": sentiment_shift,
        "confidence_score": confidence_score,
        "volatility": volatility,
        "summary": summary,
        "events_timeline": events,
        "impacts": impacts,
    }


def get_morning_briefing() -> dict:
    """Fetch news, dispatch per-class MiMo briefings, merge, cache.

    Cache key is the news content hash — re-runs only when news changes.
    """
    global _cached_briefing, _last_news_hash

    news = fetch_economic_news()
    news_hash = hashlib.md5(json.dumps(news, sort_keys=True).encode("utf-8")).hexdigest()
    if _cached_briefing and news_hash == _last_news_hash:
        return _cached_briefing

    db = SessionLocal()
    try:
        row = db.query(SystemSettings).filter(SystemSettings.key == "core_assets").first()
        core_assets = json.loads(row.value) if row else ["XAUUSD", "US30", "USDJPY"]
    finally:
        db.close()

    groups = _group_assets_by_class(core_assets)
    log.info("Macro briefing: %d classes, assets=%s", len(groups), {k: len(v) for k, v in groups.items()})

    per_class: dict[str, dict] = {}
    for klass, assets in groups.items():
        if not assets:
            continue
        per_class[klass] = _call_mimo_for_class(news, assets)

    merged = _merge_briefings(per_class)

    _cached_briefing = {"raw_news": news, "ai_briefing": merged, "per_class": per_class}
    _last_news_hash = news_hash
    return _cached_briefing


def invalidate_briefing_cache() -> None:
    global _cached_briefing, _last_news_hash
    _cached_briefing = None
    _last_news_hash = None
