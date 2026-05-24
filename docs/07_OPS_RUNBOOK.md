# Ops Runbook — Day-to-Day Operations

Status: Living document. Update as you learn.

Created: 2026-05-24 during autonomous overnight session.

---

## Start the system

```powershell
cd <repo-root>
.\start_all.bat
```

This launches:
- Backend: `uvicorn app.main:app --reload --port 8000` (window 1)
- Frontend: `npm run dev` on port 5173 (window 2)

Required prereqs (must be running BEFORE start_all.bat):
- Docker Desktop -> `docker-compose up -d` (Postgres :5432, ChromaDB :8001)
- MT5 terminal logged in, Algo Trading enabled

Verify by opening browser to http://127.0.0.1:5173

---

## Stop the system

Close both terminal windows. The python + node processes will terminate.

If a process hangs:
```powershell
Get-Process python | Where-Object { $_.Path -like "*HedgeFund*" } | Stop-Process -Force
Get-Process node | Where-Object { $_.Path -like "*HedgeFund*" } | Stop-Process -Force
```

---

## LAN remote access (phone / other PC on same WiFi)

### Backend side (PC running uvicorn)

1. Find the PC's LAN IP:
   ```powershell
   ipconfig | Select-String "IPv4"
   ```
   Example output: `IPv4 Address: 192.168.1.42`

2. Backend default binds `--port 8000` only (127.0.0.1). For LAN, edit `start_all.bat`:
   ```
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

3. Update CORS allow-list in `backend/app/main.py` (around line 360). Add LAN origin:
   ```python
   app.add_middleware(
       CORSMiddleware,
       allow_origins=[
           "http://localhost:5173",
           "http://127.0.0.1:5173",
           "http://192.168.1.42:5173",  # ADD: replace with backend PC's LAN IP
       ],
       allow_credentials=True,
       allow_methods=["*"],
       allow_headers=["*"],
   )
   ```
   Note: CORS is strict — wildcard `*` won't work with allow_credentials=True. Must list explicit
   origins. If LAN IP changes (DHCP), update + restart uvicorn.

4. Frontend (Vite) already configured with `host: true` in vite.config.ts (added 2026-05-24).

4. Open Windows Firewall for ports 8000 + 5173 from local subnet ONLY (not internet):
   ```powershell
   # Run as Administrator
   New-NetFirewallRule -DisplayName "AlgoTrade Backend (LAN)" `
     -Direction Inbound -Protocol TCP -LocalPort 8000 `
     -RemoteAddress LocalSubnet -Action Allow
   New-NetFirewallRule -DisplayName "AlgoTrade Frontend (LAN)" `
     -Direction Inbound -Protocol TCP -LocalPort 5173 `
     -RemoteAddress LocalSubnet -Action Allow
   ```

5. Set frontend env to use LAN IP for API:
   ```bash
   # frontend/.env.local (NOT committed)
   VITE_API_URL=http://192.168.1.42:8000
   ```
   Restart Vite dev server.

### Client side (phone / other PC)

1. Connect to same WiFi as backend PC
2. Open browser: `http://192.168.1.42:5173`
3. Frontend will hit backend at `http://192.168.1.42:8000` (per VITE_API_URL)

### Verification

From client:
```bash
curl http://192.168.1.42:8000/api/health
# Should return JSON with auto_trade_enabled, core_assets_count, mt5 status
```

If timeout:
- Firewall rule didn't apply (check `Get-NetFirewallRule -DisplayName 'AlgoTrade*'`)
- LAN IP changed (run ipconfig again)
- Backend bound to 127.0.0.1 not 0.0.0.0 (check `netstat -an | findstr :8000`)

### Migrating existing hardcoded URLs

Currently 7 frontend files have `http://127.0.0.1:8000` hardcoded. To make all pages use
the centralized API_BASE from lib/api.ts:

```bash
cd frontend
# Files to migrate (verified 2026-05-24):
# - src/App.tsx
# - src/store/useMarketStore.ts
# - src/components/ChartWidget.tsx
# - src/pages/BacktestRun.tsx
# - src/pages/BacktestOptimize.tsx
# - src/pages/BacktestDataStatus.tsx
# - src/pages/Settings.tsx
```

In each file:
1. Add `import { API_BASE } from '../lib/api';` (adjust depth)
2. Replace `'http://127.0.0.1:8000` with `\`${API_BASE}` (note backtick + template literal)
3. Replace `"http://127.0.0.1:8000` with `\`${API_BASE}`

After migration, all pages obey VITE_API_URL.

---

## Common ops tasks

### Check what backend is doing right now

```bash
curl -s http://127.0.0.1:8000/api/health | python -m json.tool
curl -s http://127.0.0.1:8000/api/analysis/quant | python -m json.tool
curl -s http://127.0.0.1:8000/api/historical/status | python -m json.tool
```

### Pause auto-trade (kill switch)

UI: Click red "STOP AUTO-TRADE" button in header. Confirm.

CLI:
```bash
curl -X POST http://127.0.0.1:8000/api/kill-switch
```

Resume:
```bash
curl -X POST http://127.0.0.1:8000/api/kill-switch/restore
```

### Manual backfill (after gap)

UI: Backtest > Data Status > "Deep Backfill (5000 candles)" button.

CLI:
```bash
curl -X POST http://127.0.0.1:8000/api/historical/deep-backfill
```

### Run on-demand quant scan

```bash
curl -s http://127.0.0.1:8000/api/analysis/technical | python -m json.tool
```

(Heavy — re-scans + sends Discord on new ENTRY signals.)

### Check current settings

```bash
curl -s http://127.0.0.1:8000/api/config/assets | python -m json.tool
curl -s http://127.0.0.1:8000/api/settings | python -m json.tool
```

### Run a backtest from CLI (job-based)

```bash
JOB=$(curl -s -X POST http://127.0.0.1:8000/api/backtest \
  -H "Content-Type: application/json" \
  -d '{"symbols": ["BTCUSD"], "start_date": "2025-12-01", "end_date": "2026-05-01"}' \
  | python -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
# Poll
curl -s "http://127.0.0.1:8000/api/jobs/$JOB" | python -m json.tool
```

---

## When something breaks

### Backend won't start

1. Port 8000 already in use?
   ```powershell
   netstat -ano | findstr :8000
   # If found, kill the PID
   Stop-Process -Id <PID> -Force
   ```

2. Postgres down?
   ```bash
   docker ps | grep postgres
   # If missing
   docker-compose up -d
   ```

3. MT5 terminal not open?
   - Open MT5 manually, log in, enable Algo Trading
   - Restart backend

4. Schema drift detected, migration loops?
   - Check `backend/logs/` for migration error
   - Last resort: drop affected table in psql, restart backend (will recreate)

### Frontend won't load

1. Vite dev server stopped? Restart `cd frontend && npm run dev`
2. Backend unreachable? Check `curl http://127.0.0.1:8000/api/health`
3. CORS error in browser? Verify backend's CORS middleware allows frontend origin

### Trade not placing

Check `/api/health` shows:
- `auto_trade_enabled: true`
- `mt5.ok: true`
- `mt5.trade_allowed: true`

Then check `/api/analysis/quant` — any symbol showing `signal: "ENTRY_*"`? If none, no trade
because no signal qualifies (D1+H4 alignment + RSI in zone + volume confirmation).

If signal exists but no order placed, check backend logs for `_safety_gates_pass` rejection.

### Daily DD limit hit

Once daily_dd_limit_pct is exceeded, auto-trade halts for the rest of the day. Resets at
00:00 UTC next day.

Manual override: kill switch on, then resume next day after market reset.

If you want to lower the limit, edit Settings > daily_dd_limit_pct (default 5%).

---

## Backup + recovery

### Postgres backup

```powershell
# Daily via Task Scheduler at 03:00
docker exec -t hedgefund_db pg_dump -U postgres -d hedgefund_cfd > "D:\backups\hedgefund_cfd_$(Get-Date -Format yyyy-MM-dd).sql"
```

### Restore

```powershell
docker exec -i hedgefund_db psql -U postgres -d hedgefund_cfd < "D:\backups\hedgefund_cfd_2026-05-24.sql"
```

### ChromaDB backup

ChromaDB data is in Docker volume. Backup the volume:
```bash
docker run --rm -v hedgefund_chroma:/data -v D:/backups:/backup ubuntu \
  tar czf /backup/chroma_$(date +%Y-%m-%d).tar.gz -C /data .
```

---

## Logs

Backend logs go to stdout (in start_all.bat window) unless NSSM is configured to redirect.

After NSSM (per docs/05 §4.1):
- `backend/logs/backend_stdout.log`
- `backend/logs/backend_stderr.log`

Frontend logs go to Vite dev server window. Production build has no equivalent runtime logs
(browser console only).

Tail useful events:
```powershell
# action_log table in Postgres has structured events
docker exec -it hedgefund_db psql -U postgres -d hedgefund_cfd \
  -c "SELECT created_at, source, action, details FROM action_logs ORDER BY id DESC LIMIT 50;"
```
