"""Asset profiles for AlgoTrade HedgeFund v2.1.

Only G1 (Volatile Trending) assets are supported by the current Triple Screen strategy.
G2 (Forex pairs) was empirically shown to LOSE on this strategy across a 6-month walk-forward
test — they mean-revert rather than trend, and Triple Screen doesn't fit. Forex is intentionally
NOT listed here. Re-enable only when a separate mean-reversion strategy variant exists.

Each profile defines:
- class: asset class (Crypto, Metals, Indices, Energy)
- peak_hours: tuple of (start_hour, end_hour) in UTC+7. Entries outside become ALERT not ENTRY.
- max_spread: max acceptable spread in MT5 points; abort trade if exceeded (spread protection).
"""

ASSET_PROFILES = {
    # Crypto — 24h markets, high volatility, strong trends in Q4 2025 - Q2 2026 sample
    "BTCUSD": {"class": "Crypto",      "peak_hours": (0, 24),  "max_spread": 5000},
    "ETHUSD": {"class": "Crypto",      "peak_hours": (0, 24),  "max_spread": 3000},
    "SOLUSD": {"class": "Crypto",      "peak_hours": (0, 24),  "max_spread": 1000},
    "LTCUSD": {"class": "Crypto",      "peak_hours": (0, 24),  "max_spread": 500},

    # Precious Metals — XAU/XAG most active during London PM + NY open overlap
    "XAUUSD": {"class": "Metals",      "peak_hours": (19, 23), "max_spread": 500},
    "XAGUSD": {"class": "Metals",      "peak_hours": (19, 23), "max_spread": 800},

    # US Equity Indices — most volatile during NY session (UTC+7 evening to midnight)
    "NAS100": {"class": "Indices",     "peak_hours": (20, 3),  "max_spread": 300},
    "US30":   {"class": "Indices",     "peak_hours": (20, 3),  "max_spread": 500},
    "SPX500": {"class": "Indices",     "peak_hours": (20, 3),  "max_spread": 200},

    # Energy — moves on inventory data + geopolitics
    "USOIL":  {"class": "Energy",      "peak_hours": (15, 22), "max_spread": 100},
    "UKOIL":  {"class": "Energy",      "peak_hours": (15, 22), "max_spread": 100},
}

# G1 = canonical default asset universe (11 volatile trending symbols).
# Used by database.seed + reset_core_assets_to_defaults + frontend "From Settings" button.
G1_ASSETS = list(ASSET_PROFILES.keys())

# Backwards compatibility alias — older code imports `DEFAULT_30_ASSETS`.
# Marked deprecated; remove once all callers migrate to G1_ASSETS.
DEFAULT_30_ASSETS = G1_ASSETS
