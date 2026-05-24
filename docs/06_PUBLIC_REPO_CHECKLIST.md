# Public GitHub Repo — Pre-Open Checklist

Status: **LIST ONLY. DO NOT EXECUTE.** Booth's instruction: list what's needed BEFORE
making the repo public. Actual transition to public happens later in a separate session.

Created: 2026-05-24 during autonomous overnight session.

---

## Why this matters

Going public on GitHub means:
- The full code history is publicly visible (including any past commits with secrets/data)
- Issues + PRs can come from anyone
- The repo is searchable / discoverable
- Once you delete a commit, GitHub may still have cached versions

**Do this RIGHT or not at all.** A leaked secret on a public repo is harder to recover from
than not opening at all.

---

## Phase 0 — Decide if you should

Before doing any work, answer honestly:

1. **What's the goal of going public?**
   - Showcase for hiring? (high value, low risk if cleaned properly)
   - Collaboration with others? (medium value, medium risk - need contributor policy)
   - Just sharing what you built? (low value, high risk - probably not worth it)

2. **What are you giving up?**
   - **Competitive edge:** if the strategy genuinely works, anyone can copy
   - **Liability:** if someone follows your code, loses money, they may blame you
   - **Maintenance:** strangers may file issues you feel obligated to answer
   - **Future capability:** if you ever want to sell access or monetize, public history limits options

3. **What are you gaining?**
   - **Portfolio piece** — a working algo trading system is impressive
   - **Feedback** — others may find bugs you missed
   - **Reputation** — useful if you want a quant/eng job

**Recommendation:** If the goal is portfolio, going public is good — but only after the system
is genuinely working (post-demo, post-cent, post-real-money-validation).
Going public during development phase = others see incomplete/buggy code = worse signal.

If unsure, default to KEEP PRIVATE for now. Revisit in 3-6 months when there's a clean v1 to point to.

---

## Phase 1 — Audit existing code + history (before init git)

### 1.1 Secret scan

Items that MUST NOT be in git history:

- `.env` files (any flavor)
- `MIMO_API_KEY`, `DISCORD_WEBHOOK_URL`, `DATABASE_URL`
- MT5 login credentials (account number + password + server)
- IUX broker-specific account IDs or hashes
- Any path that contains `C:\Users\Booth\` (personal identification)
- Backup of Postgres dumps (`*.dump`)
- Backtest result JSONs that mention real account balance
- Discord webhook URLs (anyone with the URL can post to your channel)
- Email addresses

Tools:
```bash
# Pre-commit hook
pip install detect-secrets
detect-secrets scan > .secrets.baseline
detect-secrets audit .secrets.baseline

# Trufflehog for git history
trufflehog filesystem --directory=.
```

### 1.2 Personal data scan

Search the codebase for:

```
grep -rEi "(booth|nattawat|flowaccount)" --exclude-dir={venv,node_modules,.git}
grep -rEi "C:\\\\Users\\\\Booth" --exclude-dir={venv,node_modules,.git}
grep -rEi "(@gmail|@flowaccount|@iux)" --exclude-dir={venv,node_modules,.git}
```

Any hits = remove or anonymize before going public.

CLAUDE.md contains Booth-specific instructions, paths, broker references. Consider:
- Move private CLAUDE.md to `~/.claude/` only (keep out of repo)
- Or rewrite CLAUDE.md to be project-generic ("the user" instead of "Booth")

### 1.3 Broker-specific code

Search for broker-specific assumptions:

```
grep -rEi "(iux|exness|fbs|roboforex|pepperstone)" --exclude-dir={venv,node_modules,.git}
```

Generalize via `.env` config:
- `BROKER_NAME=IUX`
- `BROKER_SYMBOL_ALIASES` map for non-standard symbol naming

Anyone forking the repo should be able to point to their broker without code edits.

### 1.4 Account-specific assumptions

- Hard-coded starting equity (e.g. `$10,000`) — make configurable
- IUX-specific commission/spread numbers in backtest cost model — make configurable
- Single-account architecture — document the assumption, don't apologize for it

---

## Phase 2 — Repo hygiene

### 2.1 `.gitignore`

Minimum exclusions:

```gitignore
# Secrets
.env
.env.*
!.env.example

# Python
__pycache__/
*.pyc
*.pyo
*.pyd
backend/venv/
backend/.venv/
*.egg-info/

# Node
node_modules/
frontend/dist/
frontend/.vite/

# IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Local data
*.dump
*.sqlite
*.db
backend/logs/
chroma_data/

# Run artifacts
run*_result.json
run*_poll.log
analyze_*.py
explore-reports/

# Backtest snapshots that may contain personal account data
backtest_history/
trade_journal.csv
equity_snapshots.csv
```

### 2.2 `.env.example`

Create `.env.example` with ALL keys but PLACEHOLDER values:

```bash
# MT5 connection
MT5_PATH=C:\path\to\terminal64.exe
MT5_LOGIN=your_account_number
MT5_PASSWORD=your_password
MT5_SERVER=Broker-Server-Name

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/hedgefund_cfd

# LLM (optional - leave blank to disable)
MIMO_API_KEY=

# Alerts (optional)
DISCORD_WEBHOOK_URL=

# Auth (recommended for remote access)
API_USER=admin
API_PASS=change_me_to_a_strong_password

# Risk overrides (optional)
DEFAULT_RISK_PERCENT=0.5
```

### 2.3 Rewrite README.md

The current README (if any) is internal-facing. Public README should:
- Open with a 1-line elevator pitch
- Show a screenshot or 2
- List dependencies + setup steps
- Document the strategy briefly
- LICENSE statement
- Disclaimer: NOT financial advice, NO warranty

Example structure:
```markdown
# AlgoTrade HedgeFund — Triple Screen Trend Following

Personal algorithmic CFD trading system on MetaTrader 5.
Triple Screen entry (D1+H4 trend + H1 RSI pullback) + 4-stage trailing exit.

## DISCLAIMER

This software is provided for educational and research purposes only. Trading CFDs
involves substantial risk. The author makes no warranty about profitability and
accepts no liability for any losses. NOT financial advice. Use at your own risk.

## Architecture

[diagram]

## Setup

1. Install dependencies
2. Copy `.env.example` to `.env` and fill in
3. Run `docker-compose up -d` for Postgres + ChromaDB
4. Run `start_all.bat`

## Strategy

[brief description, link to docs/01_BUSINESS_REQUIREMENTS.md]

## License

MIT (or other - see Phase 3)
```

### 2.4 LICENSE

Pick one:

| License | Pros | Cons |
|---|---|---|
| MIT | Most permissive, fewest restrictions | Anyone can fork + sell |
| Apache 2.0 | MIT + patent protection | Slightly more legalese |
| GPL v3 | Forces forks to stay open source | Discourages corporate use |
| Custom "personal use only" | Restricts commercial use | Not OSS-compliant, GitHub may flag |

For a portfolio piece: **MIT or Apache 2.0**. Don't try to enforce non-commercial — it's
unenforceable and signals overconfidence in the strategy.

### 2.5 CONTRIBUTING.md

Set expectations:
- Issues welcome
- PRs welcome but require discussion first
- No support guarantee
- Maintainer (Booth) reviews on weekends only

### 2.6 CODE_OF_CONDUCT.md

GitHub will prompt for this. Use the [Contributor Covenant](https://www.contributor-covenant.org/)
template — boilerplate, signals good faith.

### 2.7 SECURITY.md

Document how to report vulnerabilities:
- Don't open public issue
- Email maintainer privately
- 90-day disclosure timeline

---

## Phase 3 — Internal-only files to KEEP OUT

Move these OUT of the repo before going public:

- `CLAUDE.md` (Booth-specific AI instructions)
- `docs/03_AGENT_HANDOFF.md` (mentions Booth, internal paths)
- `analyze_run*.py` (ad-hoc analysis scripts with hardcoded paths)
- `start_all.bat` (Windows-specific, references C:\Users\Booth)
- Memory files under `~/.claude/projects/...` (already outside repo)
- `Obsidian/Claude-Memory/` (already outside repo)

OR generalize them:
- Replace "Booth" with "the user"
- Replace `C:\Users\Booth\...` with `<repo_root>` or env vars
- Strip session-specific dates

### 3.1 What stays public

- `backend/app/` — all source
- `frontend/src/` — all source
- `docs/01_BUSINESS_REQUIREMENTS.md` — strategy + Tuning History (consider redacting Run 1 IS numbers if they reveal alpha)
- `docs/02_TECHNICAL_ARCHITECTURE.md` — system design (safe)
- `docs/04_PHASE_4_IMPLEMENTATION.md` — generic engineering doc (safe)
- `docs/05_CICD_BLUEPRINT.md` — generic (safe)
- `requirements.txt`, `package.json` — needed for setup
- `docker-compose.yml` — needed for setup

### 3.2 What stays private (in private fork or local-only)

- Tuning History (Run 1-N detailed results) — strategy edge
- Live trade journal — account balance + P/L
- Equity snapshots — account balance
- Settings table dump — current params (alpha signal)

---

## Phase 4 — Branding + presentation

If portfolio is the goal:

- Repo name: pick something memorable, NOT broker-specific (e.g. `triple-screen-trader` not `iux-bot`)
- Topics tags: `algorithmic-trading`, `metatrader5`, `python`, `fastapi`, `react`, `cfd`
- About: 1 sentence + link to a writeup (if you write one)
- Repo image: screenshot of the dashboard
- Pinned issue: roadmap (gives newcomers a way to engage)

If collaboration is the goal:
- All of the above PLUS
- Good first issue labels (easy stuff for contributors)
- Project board with milestones

---

## Phase 5 — Pre-flight gate (the final check)

Before clicking "Make Public":

- [ ] Secret scan tool reports 0 secrets
- [ ] No `C:\Users\Booth\` in any file
- [ ] No personal email addresses
- [ ] No broker account numbers or IDs
- [ ] `.env.example` is comprehensive
- [ ] README disclaimer is prominent
- [ ] LICENSE present and chosen deliberately
- [ ] All Booth-specific docs moved out of repo
- [ ] Latest commit doesn't break the build
- [ ] You have explicit comfort with strangers reading every line
- [ ] You've decided what to do if someone reports a bug or PR

**Once public, run a SECOND secret scan from a clean clone:**
```bash
git clone https://github.com/$user/algotrade-hedgefund.git /tmp/audit
cd /tmp/audit
trufflehog filesystem --directory=.
detect-secrets scan
```

If anything leaks, immediately:
1. Make repo private again
2. Rotate the leaked secret
3. Force-push history rewrite (`git filter-branch` or `bfg`)
4. Treat the leaked secret as compromised forever

---

## Recommendation for timing

| Phase | Stage of project | Recommended action |
|---|---|---|
| Demo testing | Now | **KEEP PRIVATE.** Code changes frequent, secrets risk high. |
| Cent account active | Q4 2026 (estimated) | Keep private, audit cleanup |
| Real money sustained 3 months | Q1 2027 (estimated) | Consider going public for portfolio |
| 6+ months profitable | Q2 2027+ | If desired, transition to public after Phase 1-5 audit |

**Never go public during active development on live capital** — the cognitive overhead of
"someone might be watching" interferes with hard engineering decisions.

---

## TL;DR

**Don't do this now.** Plan for later. The checklist above is a roadmap, not an action item.

When you DO want to go public:
1. Allocate a focused session (~4-6 hours)
2. Do the audit BEFORE git init
3. Use private repo first as a staging ground
4. Triple-check secret scan
5. Have a rollback plan if something leaks
