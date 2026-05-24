# System & Context
You are working on the **AlgoTrade HedgeFund System v2.1**.
Local Algorithmic Trading Screener + Auto-Execution bot for MetaTrader 5 (MT5).

Authoritative rules: `CLAUDE.md`. This file documents MiMo-specific routing.

# LLM Role — Informational Only (Important)

In the **current code**, the LLM (Xiaomi MiMo) does NOT gate trade decisions. It:
- Shows `reason_economic`, `trade_idea`, `badge` to the dashboard
- Generates Daily Reflection at end of day
- Suggests asset universe (Settings > AI Suggest)
- Critiques action logs

The auto-trade path (`app/main.py:background_quant_analysis`) executes purely on technical signal
+ safety gates. LLM output is NOT in the decision branch.

**If you wire LLM into gating, do it consciously in `_safety_gates_pass` and document the impact
on backtest reliability (backtest cannot replay historical LLM outputs).**

# MiMo Routing

| Use case | Model | Why |
|---|---|---|
| Macro morning briefing (per asset class) | `mimo-v2.5-pro` | Reasoning over news → bias + per-asset impact |
| Macro briefing fallback / sentiment NLP | `mimo-v2.5` | Cheaper for routine news tagging |
| Asset universe recommendation | `mimo-v2.5` | Light filtering |
| Daily Trading Reflection | `mimo-v2.5-pro` | Deep critique |
| Log analysis critique | `mimo-v2.5-pro` | Pattern spotting |

# Configuration
- `.env` keys: `MIMO_API_KEY`, `MIMO_BASE_URL` (default `https://token-plan-sgp.xiaomimimo.com/v1`), `MIMO_MODEL` (default `mimo-v2.5-pro`).
- API: OpenAI-compatible `/chat/completions`.

# Cost discipline
- Macro briefing caches on news content hash (no re-call when news unchanged).
- One call per asset class per refresh (4 classes typical).
- Daily reflection runs once on-demand.

# Failure handling
- Network error → placeholder briefing returned; stale cache used as fallback.
- JSON parse error → log + empty impacts; do NOT crash the signal scan.
- Missing `MIMO_API_KEY` → degrade gracefully.

# Future roadmap (where LLM CAN add measurable value — TBD)

Per `CLAUDE.md` realistic-expectations section, LLM as a layer on TOP of working quant has
expected lift 10-30%, NOT alpha generation from scratch. Possible additions:

1. **News-event blackout filter** (Tier 1): block new trades within 90 min of high-impact events.
2. **Regime classifier**: weekly regime label → adjust strategy params per regime.
3. **Cross-asset sentiment**: aggregate Twitter/Reddit/news → sentiment feature.
4. **Strategy auto-tuner**: suggest next sweep ranges based on prior optimize results.

None of these are implemented as of v2.1. They are tracked in `docs/03_AGENT_HANDOFF.md` as
"Phase 4+ work".
