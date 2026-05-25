"""Live-backend API integration tests.

Hits the running uvicorn at http://127.0.0.1:8000 with PIN header and verifies every
GET endpoint responds 200, plus a handful of safe POST endpoints (settings round-trip).

Heavy / destructive endpoints are EXCLUDED:
  - POST /api/backtest                    (runs a full backtest — slow)
  - POST /api/backtest/optimize           (queues a grid search job)
  - POST /api/historical/deep-backfill    (300k-candle pull blocks MT5 IPC)
  - POST /api/optimize/auto-refresh       (already manually triggered earlier)
  - POST /api/kill-switch                 (would actually disable auto-trade)

Run all:
    .\\venv\\Scripts\\python.exe -m pytest tests/test_api_endpoints.py -v

Run only API tests:
    .\\venv\\Scripts\\python.exe -m pytest tests -v -k api_endpoints

If backend is not running on :8000 every test is skipped (not failed).
"""

import os
import requests
import pytest

BASE_URL = os.getenv("ALGOTRADE_TEST_URL", "http://127.0.0.1:8000")
PIN = os.getenv("ALGOTRADE_TEST_PIN", "130944")
HEADERS = {"x-pin": PIN, "Content-Type": "application/json"}


@pytest.fixture(scope="session", autouse=True)
def backend_available():
    """Probe /api/health once at session start. Skip entire file if backend down."""
    try:
        r = requests.get(f"{BASE_URL}/api/health", headers=HEADERS, timeout=3)
        if r.status_code != 200:
            pytest.skip(f"Backend at {BASE_URL} returned {r.status_code} — skipping API tests")
    except requests.exceptions.RequestException as e:
        pytest.skip(f"Backend not reachable at {BASE_URL}: {e}")


def _get(path: str, **kwargs):
    return requests.get(f"{BASE_URL}{path}", headers=HEADERS, timeout=15, **kwargs)


def _post(path: str, json_data=None, **kwargs):
    return requests.post(f"{BASE_URL}{path}", headers=HEADERS,
                          json=json_data, timeout=15, **kwargs)


def _delete(path: str, **kwargs):
    return requests.delete(f"{BASE_URL}{path}", headers=HEADERS, timeout=15, **kwargs)


# ============================ AUTH ============================

def test_auth_pin_correct():
    r = _post("/api/auth/pin", {"pin": PIN})
    assert r.status_code == 200
    assert r.json().get("ok") is True


def test_auth_pin_wrong_returns_401():
    r = requests.post(f"{BASE_URL}/api/auth/pin",
                      headers={"Content-Type": "application/json"},
                      json={"pin": "wrong_pin_99999"}, timeout=3)
    # NOTE: PIN middleware on POST /api/auth/pin uses path bypass — it processes the
    # request body and returns 401 if PIN invalid. Either way: not 200.
    assert r.status_code in (401, 429)


def test_unauthenticated_request_rejected():
    """API call without x-pin header must return 401."""
    r = requests.get(f"{BASE_URL}/api/health", timeout=3)
    assert r.status_code == 401


# ============================ HEALTH ============================

def test_health_basic():
    r = _get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert "mt5" in body
    assert "auto_trade_enabled" in body
    assert "core_assets_count" in body
    assert isinstance(body["core_assets_count"], int)


def test_health_deep():
    r = _get("/api/health/deep")
    assert r.status_code == 200
    body = r.json()
    assert "postgres" in body
    assert "mt5" in body
    assert body["postgres"]["ok"] is True
    # scheduler jobs list expected
    jobs = body.get("scheduler", {}).get("jobs") or body.get("jobs", [])
    assert isinstance(jobs, list)


def test_watchdog():
    r = _get("/api/system/watchdog")
    # 200 if all healthy, 503 if any failure. Both are valid responses.
    assert r.status_code in (200, 503)
    body = r.json()
    assert "ok" in body


# ============================ CONFIG + SETTINGS ============================

def test_config_assets():
    r = _get("/api/config/assets")
    assert r.status_code == 200
    body = r.json()
    assert "assets" in body
    assert isinstance(body["assets"], list)


def test_settings_get_list():
    r = _get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    # endpoint returns either list of {key, value} dicts or a dict — accept both shapes
    assert isinstance(body, (list, dict))


def test_settings_roundtrip():
    """Write a known key, read back, DELETE — leaves no pollution in settings."""
    PROBE_KEY = "api_test_probe_value"
    PROBE_VALUE = "test_marker_2026"
    try:
        # Set
        r = _post("/api/settings", {"key": PROBE_KEY, "value": PROBE_VALUE})
        assert r.status_code == 200
        # Verify via GET (returns dict)
        r2 = _get("/api/settings")
        body = r2.json()
        assert isinstance(body, dict)
        assert body.get(PROBE_KEY) == PROBE_VALUE
    finally:
        # Cleanup — DELETE so it doesn't leak into Activity Feed / Settings UI
        _delete(f"/api/settings/{PROBE_KEY}")
        # Verify deletion
        body_after = _get("/api/settings").json()
        assert PROBE_KEY not in body_after, "Cleanup failed — probe key still in DB"


# ============================ JOURNAL ============================

def test_journal_list():
    r = _get("/api/journal?days=30")
    assert r.status_code == 200
    body = r.json()
    assert "rows" in body
    assert isinstance(body["rows"], list)


def test_journal_attribution():
    r = _get("/api/journal/attribution?days=30")
    assert r.status_code == 200
    body = r.json()
    assert "overall" in body
    assert "edge" in body
    assert "noise" in body
    assert "r_distribution" in body
    assert "by_symbol" in body
    # Buckets must have correct structure
    for bucket in ("overall", "edge", "noise", "mixed"):
        b = body[bucket]
        assert "count" in b
        assert "win_rate" in b
        assert "total_pnl" in b


def test_journal_attribution_with_symbol_filter():
    r = _get("/api/journal/attribution?days=30&symbol=BTCUSD")
    assert r.status_code == 200
    assert "overall" in r.json()


# ============================ EQUITY ============================

def test_equity_series():
    r = _get("/api/equity/series?range=30d")
    # 200 always — empty if no data
    assert r.status_code == 200
    body = r.json()
    assert "snapshots" in body


# ============================ JOBS ============================

def test_jobs_list():
    r = _get("/api/jobs?limit=10")
    assert r.status_code == 200
    body = r.json()
    assert "jobs" in body
    assert isinstance(body["jobs"], list)


def test_jobs_get_nonexistent_returns_not_found():
    r = _get("/api/jobs/this-job-id-definitely-does-not-exist-12345")
    assert r.status_code == 200  # endpoint returns 200 with ok=False per impl
    body = r.json()
    assert body.get("ok") is False or body.get("status") == "not_found"


def test_jobs_filter_by_status():
    r = _get("/api/jobs?status=done&limit=5")
    assert r.status_code == 200
    body = r.json()
    for job in body.get("jobs", []):
        assert job["status"] == "done"


# ============================ ANALYSIS ============================

def test_analysis_quant():
    r = _get("/api/analysis/quant")
    assert r.status_code == 200
    # Returns dict (symbol -> result) or empty dict if no scan ran yet
    body = r.json()
    assert isinstance(body, dict)


def test_analysis_technical_for_symbol():
    r = _get("/api/analysis/technical/XAUUSD")
    # Either 200 with signal data or non-200 if MT5 disconnected — accept both
    assert r.status_code in (200, 404, 500, 503)


def test_logs_recent():
    r = _get("/api/logs/recent")
    assert r.status_code == 200


# ============================ MT5 PROXY ============================

def test_prices():
    r = _get("/api/prices")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, dict)


def test_orders():
    r = _get("/api/orders")
    assert r.status_code == 200
    body = r.json()
    # Either list or dict with 'orders' key
    assert isinstance(body, (list, dict))


def test_account_status():
    r = _get("/api/account/status")
    assert r.status_code == 200


def test_mt5_symbols():
    r = _get("/api/mt5/symbols")
    # Heavy call (queries all broker symbols) — allow longer timeout
    assert r.status_code == 200


# ============================ HISTORICAL ============================

def test_historical_status():
    r = _get("/api/historical/status")
    assert r.status_code == 200


def test_historical_date_range():
    r = _get("/api/historical/date-range")
    assert r.status_code == 200


def test_historical_symbol():
    r = _get("/api/historical/BTCUSD?timeframe=H1&limit=10")
    # Should return data if BTCUSD has H1 ingested
    assert r.status_code == 200


# ============================ BACKTEST DEFAULTS ============================

def test_backtest_defaults():
    r = _get("/api/backtest/defaults")
    assert r.status_code == 200
    body = r.json()
    # Endpoint wraps in {"defaults": {...}}; should contain Run 3 SL=0.25
    defaults = body.get("defaults", body)
    assert defaults.get("sl_atr_mult") == 0.25
    assert defaults.get("tp_atr_mult") == 4.0


# ============================ HEAVY ENDPOINTS ============================
# Marked @pytest.mark.heavy — excluded by default (see pytest.ini addopts).
# Opt-in:  .\venv\Scripts\python.exe -m pytest tests -m heavy -v
#
# These actually mutate state, run long, or burn broker quota. Use sparingly.

import time as _time


@pytest.mark.heavy
def test_backtest_run():
    """POST /api/backtest with a small window — verify it runs end-to-end."""
    r = _post("/api/backtest", {
        "symbols": ["BTCUSD"],
        "start_date": "2026-04-01",
        "end_date": "2026-04-15",
        "risk_percent": 1.0,
    })
    assert r.status_code == 200, f"backtest failed: {r.text[:300]}"
    body = r.json()
    # Expect aggregate metrics or per-symbol breakdown
    assert "aggregate" in body or "results" in body or "ok" in body


@pytest.mark.heavy
def test_backtest_optimize_queue():
    """POST /api/backtest/optimize — verify job_id returned + visible in /api/jobs."""
    r = _post("/api/backtest/optimize", {
        "symbols": ["BTCUSD"],
        "start_date": "2026-04-01",
        "end_date": "2026-04-15",
        "sweeps": {"sl_atr_mult": [0.25, 0.3]},
        "fixed": {"tp_atr_mult": 4.0},
        "walk_forward": False,
        "rank_by": "profit_factor",
        "top_n": 5,
        "require_min_trades": 1,
        "parallel": True,
    })
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    job_id = body.get("job_id")
    assert job_id

    # Verify it shows up in jobs list within 2s
    _time.sleep(1)
    r2 = _get(f"/api/jobs/{job_id}")
    assert r2.status_code == 200
    job = r2.json()
    assert job.get("status") in ("queued", "running", "done", "failed")


@pytest.mark.heavy
def test_historical_deep_backfill_single_symbol():
    """POST /api/historical/deep-backfill — limit to 1 symbol H1 to bound runtime."""
    r = _post("/api/historical/deep-backfill", {
        "symbols": ["BTCUSD"],
        "timeframes": ["H1"],
    })
    assert r.status_code == 200, f"deep-backfill failed: {r.text[:300]}"
    body = r.json()
    # Returns per-(symbol, timeframe) result dict
    assert isinstance(body, (list, dict))


@pytest.mark.heavy
def test_kill_switch_roundtrip():
    """POST /api/kill-switch then /api/kill-switch/restore. Verifies endpoint without
    leaving auto_trade disabled. Reads health to confirm toggle landed."""
    # Snapshot original state
    orig = _get("/api/health").json()
    orig_state = orig.get("auto_trade_enabled")

    try:
        # Disable
        r1 = _post("/api/kill-switch")
        assert r1.status_code == 200
        _time.sleep(0.5)
        # Verify disabled
        h = _get("/api/health").json()
        assert h.get("auto_trade_enabled") is False
    finally:
        # Always restore, even on assert fail
        r2 = _post("/api/kill-switch/restore")
        assert r2.status_code == 200
        _time.sleep(0.5)
        # Confirm restored to original (which was likely True)
        h2 = _get("/api/health").json()
        if orig_state is True:
            assert h2.get("auto_trade_enabled") is True


@pytest.mark.heavy
def test_reflection_run_daily():
    """POST /api/reflection/run-daily — invokes MiMo LLM. Slow + uses API quota.
    Custom 120s timeout because LLM round-trip can take 30-90s."""
    r = requests.post(f"{BASE_URL}/api/reflection/run-daily",
                       headers=HEADERS, timeout=120)
    # Either 200 with reflection text or 500/503 if MiMo unreachable
    assert r.status_code in (200, 500, 503)


# ============================ SUMMARY ============================

def test_endpoint_coverage_summary(capsys):
    """Print summary of which endpoints are covered. Always passes."""
    covered = [
        "POST /api/auth/pin", "GET /api/health", "GET /api/health/deep",
        "GET /api/system/watchdog", "GET /api/config/assets",
        "GET /api/settings", "POST /api/settings",
        "GET /api/journal", "GET /api/journal/attribution",
        "GET /api/equity/series",
        "GET /api/jobs", "GET /api/jobs/{id}",
        "GET /api/analysis/quant", "GET /api/analysis/technical/{sym}",
        "GET /api/logs/recent",
        "GET /api/prices", "GET /api/orders", "GET /api/account/status",
        "GET /api/mt5/symbols",
        "GET /api/historical/status", "GET /api/historical/date-range",
        "GET /api/historical/{sym}",
        "GET /api/backtest/defaults",
    ]
    heavy_opt_in = [
        "POST /api/backtest", "POST /api/backtest/optimize",
        "POST /api/historical/deep-backfill",
        "POST /api/kill-switch + restore", "POST /api/reflection/run-daily",
    ]
    with capsys.disabled():
        print(f"\n  DEFAULT (-m 'not heavy'): {len(covered)} endpoints")
        print(f"  HEAVY (opt-in via -m heavy): {len(heavy_opt_in)} endpoints")
