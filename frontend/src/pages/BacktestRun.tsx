import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Loader2, TrendingUp, TrendingDown, Copy, Check, RefreshCw } from 'lucide-react';
import { createChart, LineSeries, ColorType } from 'lightweight-charts';
import { useMarketStore } from '../store/useMarketStore';
import CalendarPicker from '../components/CalendarPicker';
import { API_BASE } from '../lib/api';

interface DateRange {
  intersection: { first: string | null; last: string | null; days_available: number };
  fully_ready: string[];
  not_ready: { symbol: string; reason: string }[];
  per_symbol: Record<string, { first: string | null; last: string | null; timeframes: any }>;
}

const BacktestRun = () => {
  const storeAssets = useMarketStore(s => s.assets);
  const [coreAssets, setCoreAssets] = useState<string[]>([]);
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [loadingRange, setLoadingRange] = useState(false);

  // Fetch coreAssets directly from REST so the page works even while WS is reconnecting
  useEffect(() => {
    fetch(`${API_BASE}/api/config/assets`)
      .then(r => r.json())
      .then(d => setCoreAssets(d.assets || []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (storeAssets.length > 0) setCoreAssets(storeAssets);
  }, [storeAssets]);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [riskPercent, setRiskPercent] = useState('1.0');
  const [spreadPips, setSpreadPips] = useState('2.0');
  const [slippagePips, setSlippagePips] = useState('1.0');
  const [startingEquity, setStartingEquity] = useState('10000');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [actionLogs, setActionLogs] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const chartContainerRef = useRef<HTMLDivElement>(null);

  // Fetch the full MT5 symbol list once for the picker
  useEffect(() => {
    fetch(`${API_BASE}/api/mt5/symbols`)
      .then(r => r.json())
      .then(d => setAllSymbols((d.symbols || []).map((s: any) => s.name)));
  }, []);

  // Sync default selection from configured core_assets
  useEffect(() => {
    if (coreAssets.length > 0 && selectedSymbols.length === 0) {
      setSelectedSymbols(coreAssets);
    }
  }, [coreAssets, selectedSymbols.length]);

  // Refresh available date range whenever selected symbols change
  useEffect(() => {
    if (selectedSymbols.length === 0) {
      setDateRange(null);
      return;
    }
    setLoadingRange(true);
    fetch(`${API_BASE}/api/historical/date-range?symbols=${selectedSymbols.join(',')}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setDateRange(d);
          if (d.intersection?.first && d.intersection?.last) {
            // Auto-fill date range to last 60 days inside the intersection if not already set or out of range
            const intFirst = new Date(d.intersection.first);
            const intLast = new Date(d.intersection.last);
            const defaultStart = new Date(Math.max(intFirst.getTime(), intLast.getTime() - 60 * 24 * 3600 * 1000));
            if (!startDate || new Date(startDate) < intFirst || new Date(startDate) > intLast) {
              setStartDate(defaultStart.toISOString().slice(0, 10));
            }
            if (!endDate || new Date(endDate) > intLast || new Date(endDate) < intFirst) {
              setEndDate(intLast.toISOString().slice(0, 10));
            }
          }
        }
      })
      .catch(() => setDateRange(null))
      .finally(() => setLoadingRange(false));
  }, [selectedSymbols.join(',')]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Render equity curve (single-symbol only — multi shows per-symbol table instead)
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const node = chartContainerRef.current;
    node.innerHTML = '';
    if (!result?.equity_curve?.length) return;
    const chart = createChart(node, {
      layout: { background: { type: ColorType.Solid, color: '#0a0a0a' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: 'rgba(42,46,57,0.5)' }, horzLines: { color: 'rgba(42,46,57,0.5)' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      width: node.clientWidth,
      height: 380,
    });
    const series = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 2 });
    series.setData(
      result.equity_curve.map((e: any) => ({
        time: Math.floor(new Date(e.time).getTime() / 1000) as any,
        value: e.equity,
      })),
    );
    chart.timeScale().fitContent();
    const onResize = () => chart.applyOptions({ width: node.clientWidth });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
    };
  }, [result]);

  const intersectionFirst = dateRange?.intersection?.first?.slice(0, 10) || '';
  const intersectionLast = dateRange?.intersection?.last?.slice(0, 10) || '';
  const validRange = !!(intersectionFirst && intersectionLast && selectedSymbols.length > 0);

  const filteredSymbolList = useMemo(() => {
    const q = search.toLowerCase();
    return allSymbols.filter(s => s.toLowerCase().includes(q));
  }, [allSymbols, search]);

  const toggleSymbol = (sym: string) => {
    setSelectedSymbols(prev => (prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]));
  };

  const selectAll = () => setSelectedSymbols(filteredSymbolList);
  const selectFromSettings = () => setSelectedSymbols(coreAssets);
  const clearAll = () => setSelectedSymbols([]);

  const run = async () => {
    setRunning(true);
    setResult(null);
    setActionLogs([]);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: selectedSymbols,
          start_date: startDate,
          end_date: endDate,
          risk_percent: parseFloat(riskPercent),
          spread_pips: parseFloat(spreadPips),
          slippage_pips: parseFloat(slippagePips),
          starting_equity: parseFloat(startingEquity),
        }),
      });
      const d = await r.json();
      if (d.ok === false) {
        setError(d.error || 'Backtest failed');
      } else {
        setResult(d);
        // Fetch action logs from the same period for the report
        try {
          const logsR = await fetch(`${API_BASE}/api/logs/range?start=${startDate}T00:00:00&end=${endDate}T23:59:59&limit=500`);
          const logsD = await logsR.json();
          if (logsD.ok) setActionLogs(logsD.logs || []);
        } catch { /* ignore — logs are optional */ }
      }
    } catch (e: any) {
      setError(String(e));
    }
    setRunning(false);
  };

  const buildReport = (): string => {
    if (!result) return '';
    const cfg = result.config || {};
    const agg = result.aggregate || {};
    const perSymbol = result.per_symbol || [];
    const trades = result.all_trades || [];
    const ts = new Date().toISOString();

    const lines: string[] = [];
    lines.push('# Backtest Report — AlgoTrade HedgeFund');
    lines.push('');
    lines.push(`**Generated:** ${ts}`);
    lines.push(`**Mode:** ${result.mode === 'single' ? 'Single-symbol' : `Multi-symbol (${selectedSymbols.length})`}`);
    lines.push(`**Date Range:** ${startDate} to ${endDate}`);
    lines.push('');
    lines.push('## Configuration');
    lines.push(`- **Symbols (${selectedSymbols.length}):** ${selectedSymbols.join(', ')}`);
    lines.push(`- Risk per trade: ${cfg.risk_percent}%`);
    lines.push(`- Spread (pips): ${cfg.spread_pips}`);
    lines.push(`- Slippage (pips): ${cfg.slippage_pips}`);
    lines.push(`- Starting equity: $${cfg.starting_equity} ${result.mode === 'multi' ? 'per symbol (parallel portfolios)' : ''}`);
    lines.push(`- SL ATR multiplier: ${cfg.sl_atr_mult ?? '1.5 (default)'}`);
    lines.push(`- TP ATR multiplier: ${cfg.tp_atr_mult ?? '3.0 (default)'}`);
    lines.push(`- RSI entry zone: ${cfg.rsi_entry_low ?? 40}-${cfg.rsi_entry_high ?? 60}`);
    lines.push(`- SMA periods (D1+H4): fast=${cfg.sma_fast_period ?? 20} slow=${cfg.sma_slow_period ?? 50}`);
    lines.push(`- VMA period (H1): ${cfg.vma_period ?? 20}`);
    lines.push('');
    lines.push('## Strategy');
    lines.push('Triple Screen Multi-Timeframe trend-following:');
    lines.push('- D1 SMA(fast/slow) determines macro trend.');
    lines.push('- H4 SMA(fast/slow) must AGREE with D1 (strict alignment, no entry on disagreement or Sideways).');
    lines.push('- H1 RSI in entry zone AND tick_volume > H1 VMA = entry trigger.');
    lines.push('- Pending LIMIT order at the low (BUY) or high (SELL) of the previous CLOSED H1 bar.');
    lines.push('- SL = entry ± SL_mult × ATR(14), TP = entry ± TP_mult × ATR(14).');
    lines.push('- Risk per trade computed off EQUITY (not balance) — drawdown-adaptive.');
    lines.push('- Pending orders that don\'t fill within 24 H1 bars are cancelled.');
    lines.push('- Realistic cost model: spread + slippage subtracted per closed trade.');
    lines.push('');
    lines.push('## Aggregate Stats');
    lines.push(`- **Total P/L:** $${agg.total_pnl} (${agg.total_return_pct >= 0 ? '+' : ''}${agg.total_return_pct}%)`);
    lines.push(`- **Trade count:** ${agg.trade_count} (W: ${agg.win_count}, L: ${agg.loss_count})`);
    lines.push(`- **Win Rate:** ${agg.win_rate}%`);
    lines.push(`- **Profit Factor:** ${agg.profit_factor}`);
    lines.push(`- **Max Drawdown:** ${agg.max_drawdown_pct}%`);
    if (agg.sharpe_like !== undefined) lines.push(`- **Sharpe-like (per-trade):** ${agg.sharpe_like}`);
    if (agg.avg_win !== undefined) lines.push(`- Avg win: $${agg.avg_win}, Avg loss: $${agg.avg_loss}`);
    if (agg.largest_win !== undefined) lines.push(`- Largest win: $${agg.largest_win}, Largest loss: $${agg.largest_loss}`);
    if (agg.symbols_traded !== undefined) {
      lines.push(`- Symbols that traded: ${agg.symbols_traded}/${selectedSymbols.length} (${agg.symbols_no_trades} produced no signals in this window)`);
    }
    lines.push('');

    if (perSymbol.length > 1) {
      lines.push('## Per-Symbol Breakdown');
      lines.push('');
      lines.push('| Symbol | Trades | Win% | Total P/L | Profit Factor | Max DD% |');
      lines.push('|---|---:|---:|---:|---:|---:|');
      const sorted = [...perSymbol].sort((a, b) => (b.stats?.total_pnl || 0) - (a.stats?.total_pnl || 0));
      for (const s of sorted) {
        if (!s.ok || !s.stats) {
          lines.push(`| ${s.symbol} | — | — | (failed: ${s.error || 'unknown'}) | — | — |`);
        } else {
          lines.push(`| ${s.symbol} | ${s.stats.trade_count} | ${s.stats.win_rate} | $${s.stats.total_pnl} | ${s.stats.profit_factor} | ${s.stats.max_drawdown_pct} |`);
        }
      }
      lines.push('');
    }

    // Top trades by absolute P/L (top 30 to keep manageable)
    if (trades.length > 0) {
      const top = [...trades]
        .sort((a: any, b: any) => Math.abs(b.pnl) - Math.abs(a.pnl))
        .slice(0, 30);
      lines.push(`## Top ${top.length} Trades by Absolute P/L`);
      lines.push('');
      lines.push('| Symbol | Type | Entry Time | Exit Time | Entry | Exit | Reason | Lot | P/L |');
      lines.push('|---|---|---|---|---:|---:|---|---:|---:|');
      for (const t of top) {
        lines.push(`| ${t.symbol} | ${t.type} | ${t.entry_time} | ${t.exit_time} | ${t.entry?.toFixed(4)} | ${t.exit_price?.toFixed(4)} | ${t.reason} | ${t.lot} | ${t.pnl >= 0 ? '+' : ''}$${t.pnl} |`);
      }
      lines.push('');
      lines.push(`(Showing top 30 of ${trades.length} total trades.)`);
      lines.push('');
    }

    if (actionLogs.length > 0) {
      lines.push(`## Live System Action Logs (same period)`);
      lines.push('');
      lines.push('```');
      for (const log of actionLogs.slice(0, 200)) {
        lines.push(`[${log.timestamp}] ${log.source}/${log.action}: ${log.message}`);
      }
      lines.push('```');
      if (actionLogs.length > 200) lines.push(`(...${actionLogs.length - 200} more entries truncated)`);
      lines.push('');
    } else {
      lines.push('## Live System Action Logs');
      lines.push('_No live action logs in this date range. (Backtest period may pre-date system deployment.)_');
      lines.push('');
    }

    lines.push('## Analysis Questions for AI');
    lines.push('Please analyze this backtest report and answer:');
    lines.push('1. Is the win rate consistent across asset classes (Forex / Indices / Commodities / Crypto)? Which class is the weakest?');
    lines.push('2. Are there parameter ranges that would likely improve win rate above 60% while keeping trade count usable (>30 over this window)?');
    lines.push('3. Does the equity curve show specific time windows of consistent losses? Could that point to a macro regime that the strategy mishandles?');
    lines.push('4. Are the SL hits clustered around news events (you can infer if many SLs hit at similar wall-clock times)?');
    lines.push('5. What is one ALGORITHMIC change (not a manual tweak) that would most likely improve robustness — be specific (e.g. "filter trades when ATR < X * 20-period avg ATR").');
    lines.push('6. Are there any signs of overfitting risk in the current parameter set?');
    lines.push('');
    lines.push('Provide specific, testable suggestions. Avoid vague advice.');

    return lines.join('\n');
  };

  const copyReport = async () => {
    const md = buildReport();
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback: open in new window
      const w = window.open('', '_blank');
      if (w) {
        w.document.body.innerText = md;
      }
    }
  };

  const stats = result?.aggregate;
  const isMulti = result?.mode === 'multi';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Play className="text-primary" size={32} />
          Run Backtest
        </h1>
        <p className="text-textMuted text-sm mt-1">
          Replay the Triple Screen strategy on one symbol or many. Calendar is restricted to the date range available in your ingested data.
        </p>
      </div>

      {/* ===== Symbol selection ===== */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <h3 className="text-lg font-bold">Symbols</h3>
            <p className="text-xs text-textMuted">{selectedSymbols.length} selected</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={selectFromSettings} className="text-xs bg-surfaceLight hover:bg-surface text-text px-3 py-1.5 rounded">From Settings ({coreAssets.length})</button>
            <button onClick={selectAll} className="text-xs bg-primary/20 hover:bg-primary/30 text-primary px-3 py-1.5 rounded">Select All ({filteredSymbolList.length})</button>
            <button onClick={clearAll} className="text-xs bg-danger/10 hover:bg-danger/20 text-danger px-3 py-1.5 rounded">Clear</button>
          </div>
        </div>
        <input
          type="text"
          placeholder="Search symbols..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text mb-3"
        />
        <div className="max-h-48 overflow-y-auto custom-scrollbar grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1.5 bg-background/40 p-2 rounded border border-surfaceLight">
          {filteredSymbolList.slice(0, 300).map(sym => {
            const isSelected = selectedSymbols.includes(sym);
            return (
              <button
                key={sym}
                onClick={() => toggleSymbol(sym)}
                className={`text-xs px-2 py-1.5 rounded border transition-colors ${
                  isSelected
                    ? 'bg-primary/30 border-primary text-primary font-semibold'
                    : 'bg-surface border-surfaceLight text-textMuted hover:border-textMuted/50'
                }`}
              >
                {sym}
              </button>
            );
          })}
        </div>
        {filteredSymbolList.length > 300 && (
          <p className="text-xs text-textMuted mt-2">Showing first 300 of {filteredSymbolList.length} matching symbols. Narrow the search to see more.</p>
        )}
      </div>

      {/* ===== Date range + params ===== */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <h3 className="text-lg font-bold">Date Range &amp; Strategy Parameters</h3>
          {loadingRange ? (
            <span className="text-xs text-textMuted flex items-center gap-1"><Loader2 className="animate-spin" size={12} /> Checking data...</span>
          ) : dateRange?.intersection?.first ? (
            <span className="text-xs text-textMuted">
              Available: <span className="text-success font-mono">{intersectionFirst}</span> → <span className="text-success font-mono">{intersectionLast}</span> ({dateRange.intersection.days_available} days)
            </span>
          ) : selectedSymbols.length > 0 ? (
            <span className="text-xs text-danger">No data intersection — ingest data first via Backtest &gt; Data Status.</span>
          ) : null}
        </div>

        {dateRange?.not_ready && dateRange.not_ready.length > 0 && (
          <div className="bg-warning/10 border border-warning/30 rounded p-3 mb-4 text-xs text-warning">
            <strong>{dateRange.not_ready.length} symbol(s) lack data:</strong>{' '}
            {dateRange.not_ready.map(r => `${r.symbol} (${r.reason})`).join(', ')}
            . They will be skipped. Run "Ingest Now" in Data Status to fix.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Start Date</label>
            <CalendarPicker
              value={startDate}
              onChange={setStartDate}
              min={intersectionFirst}
              max={intersectionLast}
              disabled={!validRange}
              placeholder="Pick start"
              rangeStart={startDate}
              rangeEnd={endDate}
            />
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">End Date</label>
            <CalendarPicker
              value={endDate}
              onChange={setEndDate}
              min={intersectionFirst}
              max={intersectionLast}
              disabled={!validRange}
              placeholder="Pick end"
              rangeStart={startDate}
              rangeEnd={endDate}
            />
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Risk %</label>
            <input type="number" step="0.1" value={riskPercent} onChange={e => setRiskPercent(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text" />
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Spread (pips)</label>
            <input type="number" step="0.1" value={spreadPips} onChange={e => setSpreadPips(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text" />
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Slippage (pips)</label>
            <input type="number" step="0.1" value={slippagePips} onChange={e => setSlippagePips(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text" />
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Starting Equity ($)</label>
            <input type="number" step="100" value={startingEquity} onChange={e => setStartingEquity(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text" />
          </div>
        </div>

        <button
          onClick={run}
          disabled={running || !validRange}
          className="mt-4 bg-primary hover:bg-primary/80 text-white px-6 py-3 rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
          {running ? `Running backtest (${selectedSymbols.length} symbols)...` : `Run Backtest (${selectedSymbols.length} symbols)`}
        </button>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-4 text-danger">{error}</div>
      )}

      {/* ===== Aggregate stats + Copy ===== */}
      {stats && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h3 className="text-xl font-bold">
              Results — {isMulti ? `${result.successful.length} symbols traded` : result.symbols_requested?.[0]}
            </h3>
            <div className="flex gap-2">
              <button
                onClick={copyReport}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold transition-colors ${
                  copied ? 'bg-success/20 border border-success/50 text-success' : 'bg-primary/20 border border-primary/50 text-primary hover:bg-primary/30'
                }`}
              >
                {copied ? <><Check size={16} /> Copied!</> : <><Copy size={16} /> Copy Report (Markdown)</>}
              </button>
              <button
                onClick={run}
                disabled={running}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surfaceLight hover:bg-surface text-text disabled:opacity-50"
              >
                <RefreshCw size={16} className={running ? 'animate-spin' : ''} />
                Re-run
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatCard label="Trades" value={stats.trade_count} />
            <StatCard label="Win Rate" value={`${stats.win_rate}%`} accent={stats.win_rate >= 50 ? 'success' : 'warning'} />
            <StatCard label="Profit Factor" value={stats.profit_factor} accent={stats.profit_factor >= 1 ? 'success' : 'danger'} />
            <StatCard label="Total P/L" value={`$${stats.total_pnl}`} accent={stats.total_pnl >= 0 ? 'success' : 'danger'} />
            <StatCard label="Total Return" value={`${stats.total_return_pct}%`} accent={stats.total_return_pct >= 0 ? 'success' : 'danger'} />
            <StatCard label="Max DD" value={`${stats.max_drawdown_pct}%`} accent="warning" />
            {!isMulti && stats.avg_win !== undefined && (
              <>
                <StatCard label="Avg Win" value={`$${stats.avg_win}`} accent="success" />
                <StatCard label="Avg Loss" value={`$${stats.avg_loss}`} accent="danger" />
                <StatCard label="Largest Win" value={`$${stats.largest_win}`} accent="success" />
                <StatCard label="Largest Loss" value={`$${stats.largest_loss}`} accent="danger" />
              </>
            )}
            {isMulti && (
              <>
                <StatCard label="Symbols Traded" value={`${stats.symbols_traded || 0}/${selectedSymbols.length}`} />
                <StatCard label="No Signals" value={stats.symbols_no_trades || 0} accent="warning" />
              </>
            )}
          </div>
        </div>
      )}

      {/* ===== Per-symbol breakdown (multi only) ===== */}
      {isMulti && result?.per_symbol?.length > 1 && (
        <div className="bg-surface border border-surfaceLight rounded-lg p-4 overflow-x-auto">
          <h3 className="text-lg font-bold mb-3">Per-Symbol Breakdown</h3>
          <table className="w-full text-sm">
            <thead className="bg-background">
              <tr className="text-textMuted">
                <th className="text-left py-2 px-3 font-semibold">Symbol</th>
                <th className="text-right py-2 px-3 font-semibold">Trades</th>
                <th className="text-right py-2 px-3 font-semibold">Wins / Losses</th>
                <th className="text-right py-2 px-3 font-semibold">Win Rate</th>
                <th className="text-right py-2 px-3 font-semibold">Total P/L</th>
                <th className="text-right py-2 px-3 font-semibold">Profit Factor</th>
                <th className="text-right py-2 px-3 font-semibold">Max DD%</th>
              </tr>
            </thead>
            <tbody>
              {[...result.per_symbol]
                .sort((a: any, b: any) => (b.stats?.total_pnl || -Infinity) - (a.stats?.total_pnl || -Infinity))
                .map((s: any) => (
                  <tr key={s.symbol} className="border-b border-surfaceLight hover:bg-background/40">
                    <td className="py-2 px-3 font-bold">{s.symbol}</td>
                    {s.ok ? (
                      <>
                        <td className="text-right py-2 px-3 font-mono">{s.stats.trade_count}</td>
                        <td className="text-right py-2 px-3 font-mono"><span className="text-success">{s.stats.win_count}</span> / <span className="text-danger">{s.stats.loss_count}</span></td>
                        <td className="text-right py-2 px-3 font-mono">{s.stats.win_rate}%</td>
                        <td className={`text-right py-2 px-3 font-mono font-bold ${s.stats.total_pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                          {s.stats.total_pnl >= 0 ? '+' : ''}${s.stats.total_pnl}
                        </td>
                        <td className="text-right py-2 px-3 font-mono">{s.stats.profit_factor}</td>
                        <td className="text-right py-2 px-3 font-mono">{s.stats.max_drawdown_pct}%</td>
                      </>
                    ) : (
                      <td colSpan={6} className="text-right py-2 px-3 text-warning">{s.error || 'Failed'}</td>
                    )}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ===== Equity curve (single-symbol only) ===== */}
      {result?.equity_curve?.length > 0 && (
        <div className="bg-surface border border-surfaceLight rounded-lg p-4">
          <h3 className="text-lg font-bold mb-3">Equity Curve</h3>
          <div ref={chartContainerRef} className="w-full" />
        </div>
      )}

      {/* ===== Trade list ===== */}
      {result?.all_trades?.length > 0 && (
        <div className="bg-surface border border-surfaceLight rounded-lg p-4 overflow-x-auto">
          <h3 className="text-lg font-bold mb-3">Trades ({result.all_trades.length})</h3>
          <div className="max-h-96 overflow-y-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-background sticky top-0">
                <tr className="text-textMuted">
                  <th className="text-left py-2 px-3 font-semibold">Symbol</th>
                  <th className="text-center py-2 px-3 font-semibold">Type</th>
                  <th className="text-left py-2 px-3 font-semibold">Entry Time</th>
                  <th className="text-left py-2 px-3 font-semibold">Exit Time</th>
                  <th className="text-right py-2 px-3 font-semibold">Entry</th>
                  <th className="text-right py-2 px-3 font-semibold">Exit</th>
                  <th className="text-center py-2 px-3 font-semibold">Reason</th>
                  <th className="text-right py-2 px-3 font-semibold">Lot</th>
                  <th className="text-right py-2 px-3 font-semibold">P/L</th>
                  <th className="text-right py-2 px-3 font-semibold">Equity</th>
                </tr>
              </thead>
              <tbody>
                {result.all_trades.map((t: any, i: number) => (
                  <tr key={i} className="border-b border-surfaceLight hover:bg-background/40">
                    <td className="py-2 px-3 font-bold">{t.symbol}</td>
                    <td className="text-center py-2 px-3">
                      {t.type === 'BUY' ? (
                        <span className="inline-flex items-center gap-1 text-success font-bold"><TrendingUp size={12} /> BUY</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-danger font-bold"><TrendingDown size={12} /> SELL</span>
                      )}
                    </td>
                    <td className="py-2 px-3 font-mono text-xs">{new Date(t.entry_time).toLocaleString()}</td>
                    <td className="py-2 px-3 font-mono text-xs">{new Date(t.exit_time).toLocaleString()}</td>
                    <td className="text-right py-2 px-3 font-mono">{t.entry?.toFixed(4)}</td>
                    <td className="text-right py-2 px-3 font-mono">{t.exit_price?.toFixed(4)}</td>
                    <td className="text-center py-2 px-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-semibold ${t.reason === 'TP' ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'}`}>{t.reason}</span>
                    </td>
                    <td className="text-right py-2 px-3 font-mono">{t.lot}</td>
                    <td className={`text-right py-2 px-3 font-mono font-bold ${t.pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                      {t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2)}
                    </td>
                    <td className="text-right py-2 px-3 font-mono text-textMuted">{t.equity_after !== undefined ? `$${t.equity_after?.toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

function StatCard({ label, value, accent }: { label: string; value: any; accent?: 'success' | 'warning' | 'danger' }) {
  const color =
    accent === 'success' ? 'text-success' :
    accent === 'warning' ? 'text-warning' :
    accent === 'danger' ? 'text-danger' :
    'text-text';
  return (
    <div className="bg-surface border border-surfaceLight rounded-lg p-3">
      <div className="text-xs text-textMuted uppercase mb-1">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

export default BacktestRun;
