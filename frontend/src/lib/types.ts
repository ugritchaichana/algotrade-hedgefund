/**
 * Shared types between frontend pages.
 *
 * Keep types in sync with backend Pydantic models in main.py.
 */

export interface EquitySnapshot {
  id: number;
  recorded_at: string;
  equity: number;
  balance: number;
  free_margin: number;
  open_positions: number;
  daily_pnl: number;
}

export interface TradeJournalEntry {
  id: number;
  ticket: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  opened_at: string;
  closed_at: string | null;
  entry_price: number;
  exit_price: number | null;
  sl: number;
  tp: number;
  lot: number;
  exit_reason: string | null;
  r_multiple: number | null;
  pnl: number | null;
  slippage_entry: number | null;
  slippage_exit: number | null;
  signal_context: {
    d1_trend?: string;
    h4_trend?: string;
    h1_rsi?: number;
    h1_volume?: number;
    h1_vma?: number;
    atr?: number;
  } | null;
}

export interface SystemHealthDeep {
  uvicorn_started_at: string;
  postgres: {
    ok: boolean;
    latency_ms: number | null;
  };
  mt5: {
    ok: boolean;
    trade_allowed: boolean;
    ping_ms: number | null;
  };
  scheduler: {
    jobs: Array<{
      id: string;
      next_run: string | null;
      last_run: string | null;
    }>;
  };
  last_quant_scan: string | null;
  last_ingest: Record<string, string | null>;  // timeframe -> ISO timestamp
  auto_trade_enabled: boolean;
  realized_pnl_today: number;
  daily_dd_limit_pct: number;
  daily_dd_limit_hit: boolean;
  core_assets_count: number;
}
