# CI/CD Pipeline Blueprint

Status: **DRAFT — DO NOT IMPLEMENT YET. AWAITING BOOTH REVIEW.**

Created: 2026-05-24 during autonomous overnight session.

Goal: Booth's vision = autonomous system running 24/7 with minimal manual oversight. CI/CD reduces
the "I need to be at the computer" tax. This blueprint stages the work.

---

## Stage 0 — Current state (no CI, no CD)

| Aspect | Status |
|---|---|
| Lint | Not enforced |
| Type check | None (no mypy / pyright) |
| Tests | None (0 unit, 0 integration, 0 E2E) |
| Build | Manual (`pip install`, `npm install`) |
| Deploy | Manual (`start_all.bat`) |
| Restart on crash | None (process dies = system down until manual restart) |
| Alerts | Only Discord on trade events (no system health alerts) |
| Backup | None (Postgres data could be lost) |
| Secrets | `.env` plaintext in repo root (not committed but no rotation policy) |
| Branch protection | N/A (no git repo yet — local-only) |

---

## Stage 1 — Add git + GitHub Actions (Sprint A, ~2-3 hours)

### 1.1 Initialize git locally

```bash
cd <repo-root>
git init
git add .gitignore
git add CLAUDE.md docs/ backend/app/ backend/requirements.txt frontend/src/ frontend/package.json frontend/vite.config.ts
git commit -m "Initial commit: Triple Screen v2.1 baseline"
```

Verify `.gitignore` excludes:
- `.env`, `.env.*`
- `backend/venv/`, `node_modules/`
- `*.pyc`, `__pycache__/`
- `dist/`, `build/`
- `run*_result.json`, `run*_poll.log`
- Backend logs

### 1.2 Push to private GitHub repo

```bash
gh repo create algotrade-hedgefund --private --source=. --remote=origin
git push -u origin main
```

Branch protection rules:
- `main` requires PR
- `main` requires 0 approvals (single dev) but requires CI green
- No direct push to `main`

### 1.3 Workflow: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  backend-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
      - run: pip install ruff mypy
      - run: ruff check backend/app/
      - run: mypy backend/app/ --ignore-missing-imports

  backend-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: testdb
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
      - run: pip install -r backend/requirements.txt pytest pytest-cov
      - run: pytest backend/tests/ -v --cov=app --cov-report=xml
        env:
          DATABASE_URL: postgresql://postgres:testpass@localhost:5432/testdb
          MT5_SKIP: "1"  # tests use mocked MT5

  frontend-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: cd frontend && npm ci
      - run: cd frontend && npm run lint

  frontend-build:
    runs-on: ubuntu-latest
    needs: frontend-lint
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: cd frontend && npm ci
      - run: cd frontend && npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: frontend-dist
          path: frontend/dist/
```

### 1.4 What this catches

- Backend syntax errors / unused imports (ruff)
- Backend type errors (mypy, gradual rollout)
- Backend unit test failures (once we write some)
- Frontend lint errors
- Frontend build errors

### 1.5 What this does NOT catch yet

- MT5 integration tests (requires Windows + MT5 install — different runner)
- Postgres migration tests (limited to in-memory pytest)
- E2E tests against running backend (no Playwright yet)
- Backtest engine regression tests (need baseline fixtures)

---

## Stage 2 — Add tests (Sprint B, ~10-15 hours)

### 2.1 Backend unit tests — minimum suite

| Module | Test priority | Effort |
|---|---|---|
| `quant_desk.compute_indicators` | High — math correctness | ~2h |
| `quant_desk.detect_trend` (D1/H4) | High — strategy core | ~2h |
| `backtest_engine._cost` | High — cost calc was a 10x bug | ~1h |
| `backtest_engine._gross_pnl` | High — P/L sanity | ~1h |
| `backtest_engine._advance_trailing` | High — state machine | ~3h |
| `execution_desk.has_open_position` | Medium — duplicate check | ~1h |
| `execution_desk.execute_trade` (mocked MT5) | Medium — placement logic | ~2h |
| `main._safety_gates_pass` | High — kill switch | ~1h |
| `historical_ingest.ingest_timeframe` | Medium — Postgres path | ~1h |

Target: 30-40 tests covering the critical paths. Run on every PR.

### 2.2 Backend integration tests

- Spin up Postgres via testcontainers (`pytest-docker`)
- Seed fixture HistoricalData with known bars
- Run end-to-end `run_backtest_multi` on fixture
- Assert PF, win_rate, trade_count match snapshot

Snapshot fixtures live in `backend/tests/fixtures/run_baseline.json`. Regression-test
that any backtest engine change either matches snapshot or explicitly updates it
(reviewable in PR diff).

### 2.3 Frontend tests

- Vitest for unit tests (already in stack)
- React Testing Library for component tests
- Target: Critical pages (BacktestRun, BacktestOptimize, Settings)
- E2E later (Playwright) for full flow

### 2.4 Smoke test endpoint

Add `/api/test/smoke` endpoint that runs in <2 sec:
- Postgres ping
- MT5 ping (returns mocked if `MT5_SKIP=1`)
- Settings cache read
- Symbol meta read for BTCUSD

Frontend Playwright test hits it as a liveness check.

---

## Stage 3 — Scheduled jobs in GitHub Actions (Sprint C, ~3-4 hours)

These RUN in GitHub Actions on cron, ARTIFACTS deploy to local agent via webhook.

### 3.1 Nightly backfill verification

```yaml
name: Nightly Data Health

on:
  schedule:
    - cron: "0 19 * * *"  # 02:00 Bangkok time

jobs:
  data-health-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          # Query Booth's backend via Tailscale or LAN tunnel
          curl -s "${BOOTH_BACKEND_URL}/api/historical/status" \
            | python scripts/data_health_check.py
        env:
          BOOTH_BACKEND_URL: ${{ secrets.BOOTH_BACKEND_URL }}
      - name: Alert on failure
        if: failure()
        run: |
          curl -X POST ${{ secrets.DISCORD_WEBHOOK }} \
            -d "content=Data health check failed at 02:00 Bangkok"
```

`scripts/data_health_check.py` verifies:
- All G1 symbols have D1/H4/H1 rows
- Last D1 timestamp within 24h
- Last H1 timestamp within 4h
- No gaps > 12h in last week of H1 data

### 3.2 Weekly walk-forward optimize

```yaml
name: Weekly Optimize

on:
  schedule:
    - cron: "0 17 * * 0"  # 00:00 Bangkok Sunday

jobs:
  optimize:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          curl -X POST "${BOOTH_BACKEND_URL}/api/backtest/optimize" \
            -H "Content-Type: application/json" \
            -d @config/weekly_optimize_sweep.json \
            > job.json
          JOB_ID=$(jq -r .job_id job.json)
          # poll until done
          while true; do
            STATUS=$(curl -s "${BOOTH_BACKEND_URL}/api/jobs/$JOB_ID" | jq -r .status)
            if [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ]; then break; fi
            sleep 60
          done
          curl -s "${BOOTH_BACKEND_URL}/api/jobs/$JOB_ID" > result.json
          python scripts/optimize_report.py result.json > report.md
      - uses: actions/upload-artifact@v4
        with:
          name: weekly-optimize-report
          path: report.md
      - name: Notify Discord
        run: |
          curl -X POST ${{ secrets.DISCORD_WEBHOOK }} \
            -d "content=Weekly optimize done. Report uploaded to GitHub artifacts."
```

### 3.3 Daily kill-switch sanity check

Verify `/api/health/deep` returns:
- auto_trade_enabled value matches expected
- MT5 connected + trade_allowed
- Last quant scan within 90 min
- Daily DD limit not exceeded

If any fail, page Discord. Booth can flip kill switch via UI from phone.

---

## Stage 4 — Local agent auto-restart (Sprint D, ~2 hours)

### 4.1 NSSM (Windows Service Wrapper)

Install nssm:
```powershell
choco install nssm
```

Install backend as service:
```powershell
cd <repo-root>\backend
nssm install AlgoTradeBackend "$(pwd)\venv\Scripts\python.exe" `
  "-m uvicorn app.main:app --host 0.0.0.0 --port 8000"
nssm set AlgoTradeBackend AppDirectory $(pwd)
nssm set AlgoTradeBackend AppStdout $(pwd)\logs\backend_stdout.log
nssm set AlgoTradeBackend AppStderr $(pwd)\logs\backend_stderr.log
nssm set AlgoTradeBackend AppRotateFiles 1
nssm set AlgoTradeBackend AppRestartDelay 5000
nssm start AlgoTradeBackend
```

Same for Vite frontend (or pre-build + serve static).

NSSM auto-restarts on crash, logs are rotated, runs at boot.

### 4.2 Health-check loop

A separate small Python script (`scripts/watchdog.py`) runs as another NSSM service:
- Every 60s, hit `http://127.0.0.1:8000/api/health/deep`
- If 3 consecutive failures, post Discord alert
- If 10 consecutive failures, restart `AlgoTradeBackend` service via `nssm restart`
- Log all events

### 4.3 Postgres backup

Scheduled task (Windows Task Scheduler or cron via cygwin):
```powershell
# Run daily at 03:00
pg_dump -U user -d hedgefund_cfd -F c -f "D:\backups\hedgefund_cfd_$(Get-Date -Format yyyy-MM-dd).dump"
# Keep last 14 days, delete older
Get-ChildItem D:\backups\hedgefund_cfd_*.dump | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item
```

Optionally rsync to external drive or cloud (S3/Backblaze) for 3-2-1 backup.

---

## Stage 5 — Remote access (Sprint E, ~1-2 hours)

### 5.1 LAN access (immediate)

- Backend listens on `0.0.0.0:8000` (already covered in Stage 4.1 NSSM args)
- Vite dev server listens on `0.0.0.0:5173` (add `--host 0.0.0.0` to package.json)
- Windows Firewall rule allowing inbound TCP 8000 + 5173 from local subnet only:
  ```powershell
  New-NetFirewallRule -DisplayName "AlgoTrade Backend" -Direction Inbound -Protocol TCP -LocalPort 8000 -RemoteAddress LocalSubnet -Action Allow
  New-NetFirewallRule -DisplayName "AlgoTrade Frontend" -Direction Inbound -Protocol TCP -LocalPort 5173 -RemoteAddress LocalSubnet -Action Allow
  ```
- Access from phone on same WiFi: `http://192.168.x.x:5173`

### 5.2 Remote access (future)

**Tailscale (recommended)**: install on PC + phone, get a magic DNS name, access from anywhere.
- Free for personal use
- End-to-end encrypted
- No port-forwarding needed
- ACL-based access control

**Cloudflare Tunnel (alternative)**: free, gives HTTPS endpoint, no static IP needed.

Both work without touching router config.

### 5.3 Auth on backend (required for remote)

Even on Tailscale, add basic auth on FastAPI to prevent accidental access:

```python
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi import Depends, HTTPException

security = HTTPBasic()

def authenticate(creds: HTTPBasicCredentials = Depends(security)):
    expected_user = os.getenv("API_USER", "booth")
    expected_pass = os.getenv("API_PASS")
    if not expected_pass:
        return  # no auth configured = open
    if creds.username != expected_user or creds.password != expected_pass:
        raise HTTPException(status_code=401)

# Apply to sensitive endpoints
@app.post("/api/kill-switch")
def kill_switch(creds: HTTPBasicCredentials = Depends(authenticate)):
    ...
```

Settings + kill-switch + apply-winners protected. Read-only health/dashboard can stay open
for the local frontend.

Future: replace with JWT + single-user token issued at login.

---

## Stage 6 — Cloud migration (Sprint F, ~10+ hours, defer until needed)

MT5 is Windows-only, so cloud migration means:
- AWS EC2 Windows instance (~$30/month for t3.medium with Spot)
- Or Vultr Windows VPS (~$15/month)
- Install MT5 on the VM
- Map broker login
- Connect from Booth's PC via RDP for occasional checks

Trigger to migrate:
- Booth's PC needs to be off (travel, maintenance)
- Capital growth justifies the cost
- Reliability becomes critical (live capital > $5k)

Not needed for demo / cent phase.

---

## Recommended sequencing

| Sprint | Items | Effort | Trigger |
|---|---|---|---|
| **S0 (now)** | docs/04 Phase 4 plan, docs/05 this blueprint, docs/06 public repo checklist | done | this session |
| **S1** | Phase 4 code work (live trailing parity, DD bug, docstring) | ~3h | After backtest results stable + Booth approves |
| **S2** | git init + push to private repo + CI yaml (Stage 1) | ~3h | Before any team grows or anything public |
| **S3** | NSSM auto-restart + Postgres backup + LAN access (Stage 4.1 + 4.3 + 5.1) | ~3h | Before opening cent account |
| **S4** | Trade journal + equity snapshot + deep health endpoint (already planned in this session) | ~5h | Before demo $10k |
| **S5** | Basic unit tests for cost/PnL/state machine (Stage 2.1) | ~8h | Before pulling new contributors / Phase 4 deployment |
| **S6** | Tailscale + auth + remote access (Stage 5.2 + 5.3) | ~2h | When Booth wants phone visibility |
| **S7** | Scheduled jobs in CI (Stage 3) | ~4h | When everything is stable + 4+ weeks live |
| **S8** | Cloud migration | ~10h | Only when justified |

---

## What this blueprint does NOT do

- Does not auto-deploy code changes to live trading. Code changes should always be:
  1. Tested locally (backtest match)
  2. PR reviewed
  3. Manually merged
  4. Backend manually restarted

- Does not blindly trust scheduled optimize results. Weekly optimize report is generated;
  Booth manually decides whether to apply (per existing project conventions).

- Does not centralize logs / metrics yet. Stage 4.5+ adds Prometheus/Grafana if needed.

- Does not handle multi-account scaling. v2.1 is single-account; multi-account is future scope.
