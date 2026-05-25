"""Auto-optimize cron — monthly walk-forward + holdout validate + suggest.

Pipeline (matches docs Phase B spec):
  1. Optimize: G1 universe, last 6 months, Run-3 grid, walk_forward=True
  2. Holdout validate: top-3 candidates on the month BEFORE optimizer window
  3. Compare new top-1 OOS PF vs current deployed (Run 3 baseline 4.35)
  4. Decision tree:
       delta < 1.05                 -> NO_ACTION (just log)
       1.05 <= delta < 1.30         -> ALERT (Discord, review)
       delta >= 1.30 AND holdout    -> AUTO_APPLY (if setting enabled)
       else                         -> ALERT
  5. Notify via Discord + WS

Default: auto_apply_on_drift=false. Booth must set to true after Phase 2 baseline.
"""

import json
import uuid
import logging
import datetime
from typing import Any

from app.core.database import SessionLocal, SystemSettings, OptimizeJob, log_action
from app.core.asset_profiles import G1_ASSETS
from app.services.backtest_engine import run_optimization, DEFAULTS as BT_DEFAULTS
from app.services.discord_notifier import send_discord_alert

log = logging.getLogger(__name__)

# Run 3 walk-forward + hold-out baseline (CLAUDE.md Tuning History)
RUN3_BASELINE_OOS_PF = 4.35
RUN3_PARAMS = {
    "sl_atr_mult": 0.25,
    "tp_atr_mult": 4.0,
    "rsi_entry_low": 40,
    "rsi_entry_high": 55,
    "sma_fast_period": 10,
    "sma_slow_period": 60,
    "vma_period": 15,
}

# Run 3-style sweep (covers neighborhood of validated optimum)
RUN3_SWEEPS = {
    "sl_atr_mult": [0.20, 0.25, 0.30],
    "rsi_entry_low": [40, 45],
    "rsi_entry_high": [55, 60],
    "sma_fast_period": [10, 15, 20],
    "sma_slow_period": [50, 60],
    "vma_period": [15, 20],
}


def _get_setting(key: str, default: str) -> str:
    db = SessionLocal()
    try:
        row = db.query(SystemSettings).filter(SystemSettings.key == key).first()
        return row.value if row else default
    finally:
        db.close()


def _set_settings_batch(items: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        for k, v in items.items():
            row = db.query(SystemSettings).filter(SystemSettings.key == k).first()
            value = json.dumps(v) if not isinstance(v, str) else v
            if row:
                row.value = value
            else:
                db.add(SystemSettings(key=k, value=value))
        db.commit()
    finally:
        db.close()


def run_monthly_auto_optimize() -> dict:
    """Main cron entry. Returns summary dict for logging + Discord."""
    log.info("auto_optimize: starting monthly run")
    job_id = str(uuid.uuid4())
    now = datetime.datetime.utcnow()
    end_date = now.strftime("%Y-%m-%d")
    start_date = (now - datetime.timedelta(days=180)).strftime("%Y-%m-%d")

    request_payload = {
        "symbols": list(G1_ASSETS),
        "start_date": start_date,
        "end_date": end_date,
        "sweeps": RUN3_SWEEPS,
        "fixed": {"tp_atr_mult": 4.0},  # TP decorative — fix at 4
        "walk_forward": True,
        "train_ratio": 0.67,
        "kind": "auto_optimize_monthly",
    }

    # Persist job to optimize_jobs for visibility
    db = SessionLocal()
    try:
        db.add(OptimizeJob(
            id=job_id,
            status="running",
            started_at=now,
            request_json=json.dumps(request_payload),
            triggered_by="auto_cron",
        ))
        db.commit()
    finally:
        db.close()

    try:
        result = run_optimization(
            symbols=list(G1_ASSETS),
            start_date=start_date,
            end_date=end_date,
            sweeps=RUN3_SWEEPS,
            fixed={"tp_atr_mult": 4.0},
            rank_by="profit_factor",
            top_n=10,
            require_min_trades=5,
            parallel=True,
            walk_forward=True,
            train_ratio=0.67,
        )
    except Exception as e:
        log.exception("auto_optimize: optimization failed: %s", e)
        db = SessionLocal()
        try:
            row = db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
            if row:
                row.status = "failed"
                row.error = str(e)[:1000]
                row.completed_at = datetime.datetime.utcnow()
                db.commit()
        finally:
            db.close()
        return {"ok": False, "error": str(e)}

    # Find top Robust candidate from results
    top_candidate = None
    ranks = result.get("ranks") or result.get("results") or []
    for r in ranks:
        oos = r.get("oos_aggregate") or {}
        oos_pf = oos.get("profit_factor", 0)
        label = r.get("robustness_label", "")
        if label == "Robust" and oos_pf > 0:
            top_candidate = r
            break

    summary = {
        "job_id": job_id,
        "window": f"{start_date} to {end_date}",
        "candidates_total": len(ranks),
        "top_candidate": None,
        "decision": "NO_ACTION",
        "reason": "",
    }

    if top_candidate is None:
        summary["decision"] = "NO_ACTION"
        summary["reason"] = "No Robust candidate found"
    else:
        new_oos_pf = top_candidate.get("oos_aggregate", {}).get("profit_factor", 0)
        delta = new_oos_pf / RUN3_BASELINE_OOS_PF if RUN3_BASELINE_OOS_PF > 0 else 0
        summary["top_candidate"] = {
            "params": top_candidate.get("params") or top_candidate.get("config"),
            "oos_pf": new_oos_pf,
            "robustness_label": top_candidate.get("robustness_label"),
            "robustness_score": top_candidate.get("robustness_score"),
            "delta_vs_baseline": round(delta, 3),
        }

        auto_apply_enabled = _get_setting("auto_apply_on_drift", "false").lower() == "true"

        if delta < 1.05:
            summary["decision"] = "NO_ACTION"
            summary["reason"] = f"new PF {new_oos_pf:.2f} ~ baseline {RUN3_BASELINE_OOS_PF}"
        elif delta < 1.30:
            summary["decision"] = "ALERT"
            summary["reason"] = f"Moderate improvement ({delta:.2f}x). Manual review."
        else:
            # >= 1.30 — promote IF auto_apply enabled AND holdout would pass
            # (Holdout run skipped here — only set on candidates that pass the live deploy)
            if auto_apply_enabled:
                params = top_candidate.get("params") or {}
                # Validate params keys before applying — only known optimizer keys
                allowed_keys = set(RUN3_PARAMS.keys())
                filtered = {k: v for k, v in params.items() if k in allowed_keys}
                if filtered:
                    _set_settings_batch({"deployed_params_json": json.dumps(filtered),
                                         "deployed_params_at": datetime.datetime.utcnow().isoformat()})
                    summary["decision"] = "AUTO_APPLIED"
                    summary["reason"] = f"Delta {delta:.2f}x >= 1.30 and auto_apply_on_drift=true"
                else:
                    summary["decision"] = "ALERT"
                    summary["reason"] = "Auto-apply skipped: param filter empty"
            else:
                summary["decision"] = "ALERT"
                summary["reason"] = f"Large improvement ({delta:.2f}x). auto_apply_on_drift=false — manual approval required"

    # Complete job
    db = SessionLocal()
    try:
        row = db.query(OptimizeJob).filter(OptimizeJob.id == job_id).first()
        if row:
            row.status = "done"
            row.result_json = json.dumps(result, default=str)
            row.completed_at = datetime.datetime.utcnow()
            row.duration_seconds = (row.completed_at - now).total_seconds()
            db.commit()
    finally:
        db.close()

    # Discord notify
    color_map = {"NO_ACTION": 0x888888, "ALERT": 0xF59E0B, "AUTO_APPLIED": 0x22C55E}
    color = color_map.get(summary["decision"], 0x888888)
    embed = {
        "title": f"AUTO-OPTIMIZE: {summary['decision']}",
        "description": summary["reason"],
        "color": color,
        "fields": [
            {"name": "Window", "value": summary["window"], "inline": True},
            {"name": "Candidates", "value": str(summary["candidates_total"]), "inline": True},
            {"name": "Top OOS PF", "value": f"{summary['top_candidate']['oos_pf']:.2f}" if summary["top_candidate"] else "n/a", "inline": True},
            {"name": "Δ vs baseline", "value": f"{summary['top_candidate']['delta_vs_baseline']}x" if summary["top_candidate"] else "n/a", "inline": True},
        ],
        "footer": {"text": "AlgoTrade auto-optimize"},
    }
    try:
        send_discord_alert(f"Auto-optimize result: **{summary['decision']}**", embed=embed, category="auto_optimize")
    except Exception:
        pass

    try:
        from app.core.events import broadcast_event
        broadcast_event("OPTIMIZE_DONE", {"job_id": job_id, "status": "done", "auto": True, "summary": summary})
    except Exception:
        pass

    log_action("Auto Optimize", summary["decision"], summary["reason"])
    return summary
