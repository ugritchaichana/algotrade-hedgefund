# AlgoTrade — HedgeFund System

Algorithmic CFD trading system on MetaTrader 5. Triple Screen Multi-Timeframe trend-following
on volatile assets, with full backtest + walk-forward optimization infrastructure.

**Status:** Strategy validated via walk-forward; live trading requires Phase 1 implementation
(see `docs/00_ROADMAP.md`).

---

## DISCLAIMER

This software is provided for **educational and research purposes only**.
**Not financial advice.** Trading CFDs involves substantial risk of loss.
Past backtest performance does not guarantee future results.

The author makes no warranty of profitability and accepts no liability for losses.
Use at your own risk. Trade only capital you can afford to lose entirely.

---

## What it does

Scans 11 volatile-trending assets every hour (crypto + indices + metals + oil), places pending
limit orders when all three timeframes align:

1. **D1 macro trend** — SMA(20/50) bullish or bearish (not sideways)
2. **H4 confirmation** — must agree with D1 trend
3. **H1 entry** — RSI(14) in zone + volume above VMA(20) + ATR-based SL/TP

Once filled, a 4-stage trailing state machine manages exits:
- 1.0R → SL to breakeven
- 1.5R → close 50% volume + lock SL at +0.5R
- 2.0R → trail SL at max_favorable − 1×ATR
- 3.0R → tighter trail at max_favorable − 0.5×ATR

LLM (Xiaomi MiMo) is **informational only** — does not gate trade decisions.

## Universe

11 G1 (volatile trending) symbols: BTCUSD, ETHUSD, SOLUSD, LTCUSD, XAUUSD, XAGUSD,
NAS100, US30, SPX500, USOIL, UKOIL.

Forex pairs intentionally excluded — they mean-revert rather than trend, and Triple Screen
doesn't fit. Would need a separate mean-reversion strategy variant.

## Walk-forward validated result

| Set      | IS PF | OOS PF | Robustness | Notes |
|---       |---    |---     |---         |---    |
| Run 1    | 1.44  | 1.62   | 1.125      | Conservative baseline (SL=0.5×ATR) |
| Run 3    | 4.32  | 4.35   | 1.007      | **Deploy candidate** (SL=0.25×ATR), survived 5 robustness tests |
| Run 4    | 11.20 | 13.38  | 1.195      | Overfit — rejected via true hold-out test (53% transfer) |

Decision: **deploy Run 3 params** after live-trailing parity is implemented (Phase 1).

See `docs/00_ROADMAP.md` for full phase plan and `docs/01_BUSINESS_REQUIREMENTS.md` for
strategy details.

## Tech stack

- **Backend:** Python 3.12, FastAPI, APScheduler, SQLAlchemy + PostgreSQL, MetaTrader5 IPC,
  ChromaDB (LLM memory), ProcessPoolExecutor for parallel backtest optimization
- **Frontend:** React 19, Vite, TypeScript, Zustand, Tailwind CSS, Lightweight-Charts
- **Infra:** Docker for Postgres + ChromaDB

## Setup

### Prerequisites
- Python 3.12+ (Windows — MetaTrader5 IPC is Windows-only)
- Node.js 20+
- Docker Desktop
- MetaTrader 5 terminal installed + logged in to your broker

### Install

```bash
# Backend
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install

# Databases
cd ..
docker-compose up -d
```

### Configure

Copy `backend/.env.example` to `backend/.env` and fill in:

```bash
MT5_PATH=C:/Program Files/MetaTrader 5/terminal64.exe
MT5_LOGIN=<your_account_number>
MT5_PASSWORD=<your_password>
MT5_SERVER=<your_broker_server>
DATABASE_URL=postgresql://admin:password123@localhost:5432/hedgefund_cfd
MIMO_API_KEY=<optional_llm_key>
DISCORD_WEBHOOK_URL=<optional_discord_alerts>
```

Copy `frontend/.env.example` to `frontend/.env.local` if you need to point the frontend at a
non-localhost backend (e.g. LAN access).

### Run

```bash
# Windows
.\start_all.bat
```

Opens two terminals (backend on :8000, frontend on :5173). Visit http://localhost:5173.

## Architecture

See `docs/02_TECHNICAL_ARCHITECTURE.md` for system design, sequence diagrams, and
performance benchmarks.

Key invariants:
- All MT5 calls flow through `execution_desk.execute_trade()`
- Triple Screen alignment is mandatory (D1 + H4 must agree)
- Lot sizing uses equity, not balance
- Walk-forward validation required before deploying any param set

## Documentation map

| File | Purpose |
|---|---|
| `docs/00_ROADMAP.md` | Master roadmap, 9 phases backtest → public |
| `docs/01_BUSINESS_REQUIREMENTS.md` | Strategy spec + Tuning History (Run 1-8) |
| `docs/02_TECHNICAL_ARCHITECTURE.md` | System design + components |
| `docs/03_AGENT_HANDOFF.md` | Quickstart + pitfalls |
| `docs/04_PHASE_4_IMPLEMENTATION.md` | Live trailing parity implementation guide |
| `docs/05_CICD_BLUEPRINT.md` | CI/CD pipeline blueprint |
| `docs/06_PUBLIC_REPO_CHECKLIST.md` | Open-source release checklist |
| `docs/07_OPS_RUNBOOK.md` | Day-to-day operations |
| `docs/08_BACKEND_CHANGES_READY.md` | Reference: backend code additions |

## Contributing

Issues and PRs welcome but:
- No support guarantee — solo maintainer
- Discuss large changes in an issue before opening a PR
- Don't expect the maintainer to validate that your fork is profitable on YOUR broker

## License

MIT — see [LICENSE](LICENSE). Note the DISCLAIMER section.

## Acknowledgments

- MetaTrader 5 (broker IPC)
- FastAPI / APScheduler / SQLAlchemy ecosystem
- Lightweight-Charts (chart rendering)
- Xiaomi MiMo (LLM, informational layer)
