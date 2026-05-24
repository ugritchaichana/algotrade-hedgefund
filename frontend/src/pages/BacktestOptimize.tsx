import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Zap, Loader2, Copy, Check, ChevronDown, ChevronUp, X, Target, FileDown } from 'lucide-react';
import { useMarketStore } from '../store/useMarketStore';
import CalendarPicker from '../components/CalendarPicker';
import { useToast } from '../lib/toast';
import { API_BASE } from '../lib/api';

interface SweepConfig {
  enabled: boolean;
  values: string;  // comma-separated
  label: string;
  description: string;
  type: 'float' | 'int';
}

// Defaults centered around walk-forward-validated values (SL=0.5, TP=4, RSI 40-55)
const DEFAULT_SWEEPS: Record<string, SweepConfig> = {
  sl_atr_mult: { enabled: true, values: '0.5, 0.75, 1.0, 1.5', label: 'SL ATR multiplier', description: 'Stop loss width in ATR units. Validated optimum: 0.5 (tight)', type: 'float' },
  tp_atr_mult: { enabled: true, values: '3, 4, 5, 6', label: 'TP ATR multiplier', description: 'Take profit distance in ATR units. Validated optimum: 4 (trailing usually exits earlier)', type: 'float' },
  rsi_entry_low: { enabled: true, values: '40, 45, 50', label: 'RSI lower bound', description: 'Lower edge of RSI entry zone. Validated optimum: 40', type: 'float' },
  rsi_entry_high: { enabled: true, values: '55, 60', label: 'RSI upper bound', description: 'Upper edge of RSI entry zone. Validated optimum: 55', type: 'float' },
  sma_fast_period: { enabled: false, values: '15, 20, 25', label: 'SMA fast period', description: 'Fast SMA on D1 and H4', type: 'int' },
  sma_slow_period: { enabled: false, values: '40, 50, 60', label: 'SMA slow period', description: 'Slow SMA on D1 and H4', type: 'int' },
  vma_period: { enabled: false, values: '15, 20, 25', label: 'VMA period', description: 'Volume MA on H1', type: 'int' },
};

const METRICS = [
  { value: 'profit_factor', label: 'Profit Factor (gross win / gross loss)' },
  { value: 'total_pnl', label: 'Total P/L ($)' },
  { value: 'total_return_pct', label: 'Total Return %' },
  { value: 'win_rate', label: 'Win Rate %' },
  { value: 'sharpe_like', label: 'Sharpe-like (per-trade mean/std)' },
  { value: 'max_drawdown_pct', label: 'Min Max-Drawdown % (lower = better)' },
];

const BacktestOptimize = () => {
  const toast = useToast();
  const storeAssets = useMarketStore(s => s.assets);
  const [coreAssets, setCoreAssets] = useState<string[]>([]);
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<any>(null);

  // Fetch coreAssets directly from REST so the page works even when WS is reconnecting
  useEffect(() => {
    fetch(`${API_BASE}/api/config/assets`)
      .then(r => r.json())
      .then(d => setCoreAssets(d.assets || []))
      .catch(() => {});
  }, []);
  // Prefer store version once WS is alive (kept in sync with kill-switch + settings)
  useEffect(() => {
    if (storeAssets.length > 0) setCoreAssets(storeAssets);
  }, [storeAssets]);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [riskPercent, setRiskPercent] = useState('1.0');
  const [spreadPips, setSpreadPips] = useState('2.0');
  const [slippagePips, setSlippagePips] = useState('1.0');
  const [startingEquity, setStartingEquity] = useState('10000');

  const [sweeps, setSweeps] = useState<Record<string, SweepConfig>>(DEFAULT_SWEEPS);
  const [rankBy, setRankBy] = useState('profit_factor');
  const [topN, setTopN] = useState('20');
  const [minTrades, setMinTrades] = useState('5');
  const [walkForward, setWalkForward] = useState(true);
  const [trainRatio, setTrainRatio] = useState('0.67');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [copiedRank, setCopiedRank] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [applyingRank, setApplyingRank] = useState<number | null>(null);
  const [applyResult, setApplyResult] = useState<{ rank: number; kept: string[]; dropped: string[] } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ pct: number; combos_done: number; combos_total: number; runs_done: number; runs_total: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/mt5/symbols`)
      .then(r => r.json())
      .then(d => setAllSymbols((d.symbols || []).map((s: any) => s.name)));
  }, []);

  useEffect(() => {
    if (coreAssets.length > 0 && selectedSymbols.length === 0) {
      setSelectedSymbols(coreAssets);
    }
  }, [coreAssets, selectedSymbols.length]);

  useEffect(() => {
    if (selectedSymbols.length === 0) {
      setDateRange(null);
      return;
    }
    fetch(`${API_BASE}/api/historical/date-range?symbols=${selectedSymbols.join(',')}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setDateRange(d);
          if (d.intersection?.first && d.intersection?.last) {
            const intFirst = new Date(d.intersection.first);
            const intLast = new Date(d.intersection.last);
            const defaultStart = new Date(Math.max(intFirst.getTime(), intLast.getTime() - 90 * 24 * 3600 * 1000));
            if (!startDate || new Date(startDate) < intFirst || new Date(startDate) > intLast) {
              setStartDate(defaultStart.toISOString().slice(0, 10));
            }
            if (!endDate || new Date(endDate) > intLast || new Date(endDate) < intFirst) {
              setEndDate(intLast.toISOString().slice(0, 10));
            }
          }
        }
      });
  }, [selectedSymbols.join(',')]);  // eslint-disable-line react-hooks/exhaustive-deps

  const intersectionFirst = dateRange?.intersection?.first?.slice(0, 10) || '';
  const intersectionLast = dateRange?.intersection?.last?.slice(0, 10) || '';
  const validRange = !!(intersectionFirst && intersectionLast && selectedSymbols.length > 0);

  const filteredSymbolList = useMemo(() => {
    const q = search.toLowerCase();
    return allSymbols.filter(s => s.toLowerCase().includes(q));
  }, [allSymbols, search]);

  const parseValues = (str: string, type: 'float' | 'int'): number[] => {
    return str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean).map(s => type === 'int' ? parseInt(s) : parseFloat(s)).filter(n => !isNaN(n));
  };

  const gridSize = useMemo(() => {
    let n = 1;
    for (const sc of Object.values(sweeps)) {
      if (!sc.enabled) continue;
      const vals = parseValues(sc.values, sc.type);
      if (vals.length === 0) continue;
      n *= vals.length;
    }
    return n;
  }, [sweeps]);

  const totalRuns = gridSize * selectedSymbols.length;
  const estimatedSeconds = totalRuns * 0.1;  // ~100ms per backtest as a rough heuristic

  const toggleSymbol = (sym: string) => setSelectedSymbols(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]);
  const selectAll = () => setSelectedSymbols(filteredSymbolList);
  const selectFromSettings = () => setSelectedSymbols(coreAssets);
  const clearAll = () => setSelectedSymbols([]);

  const updateSweep = (key: string, patch: Partial<SweepConfig>) => {
    setSweeps(s => ({ ...s, [key]: { ...s[key], ...patch } }));
  };

  // Cleanup polling on unmount or restart
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const cancelJob = async () => {
    if (!jobId) return;
    stopPolling();
    try {
      await fetch(`${API_BASE}/api/jobs/${jobId}`, { method: 'DELETE' });
    } catch { /* ignore */ }
    setJobId(null);
    setRunning(false);
    setProgress(null);
  };

  const run = async () => {
    stopPolling();
    setRunning(true);
    setResult(null);
    setError(null);
    setExpandedRow(null);
    setProgress({ pct: 0, combos_done: 0, combos_total: 0, runs_done: 0, runs_total: 0 });

    const sweepsPayload: Record<string, number[]> = {};
    for (const [key, sc] of Object.entries(sweeps)) {
      if (!sc.enabled) continue;
      const vals = parseValues(sc.values, sc.type);
      if (vals.length === 0) continue;
      sweepsPayload[key] = vals;
    }

    if (Object.keys(sweepsPayload).length === 0) {
      setError('Enable at least one sweep parameter.');
      setRunning(false);
      setProgress(null);
      return;
    }

    try {
      const r = await fetch(`${API_BASE}/api/backtest/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: selectedSymbols,
          start_date: startDate,
          end_date: endDate,
          sweeps: sweepsPayload,
          fixed: {
            risk_percent: parseFloat(riskPercent),
            spread_pips: parseFloat(spreadPips),
            slippage_pips: parseFloat(slippagePips),
            starting_equity: parseFloat(startingEquity),
          },
          rank_by: rankBy,
          top_n: parseInt(topN),
          require_min_trades: parseInt(minTrades),
          walk_forward: walkForward,
          train_ratio: parseFloat(trainRatio),
        }),
      });
      const d = await r.json();
      if (d.ok === false || !d.job_id) {
        setError(d.error || 'Optimize submission failed');
        setRunning(false);
        setProgress(null);
        return;
      }
      setJobId(d.job_id);

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const jr = await fetch(`${API_BASE}/api/jobs/${d.job_id}`);
          const job = await jr.json();
          if (job.status === 'not_found') {
            setError('Job was lost (backend restarted?). Re-run.');
            stopPolling();
            setRunning(false);
            return;
          }
          if (job.progress) setProgress(job.progress);
          if (job.status === 'done') {
            setResult(job.result);
            stopPolling();
            setRunning(false);
            setJobId(null);
          } else if (job.status === 'failed') {
            setError(job.error || 'Job failed');
            stopPolling();
            setRunning(false);
            setJobId(null);
          }
        } catch (e) {
          // Backend likely restarting — keep polling, exponential might be nicer but keep simple
        }
      }, 1000);
    } catch (e: any) {
      setError(String(e));
      setRunning(false);
      setProgress(null);
    }
  };

  const buildReportForRank = (entry: any): string => {
    const ts = new Date().toISOString();
    const lines: string[] = [];
    lines.push('# Backtest Optimization Result — AlgoTrade HedgeFund');
    lines.push('');
    lines.push(`**Generated:** ${ts}`);
    lines.push(`**Rank:** #${entry.rank} of ${result.qualified} qualified combos (out of ${result.total_combos} total)`);
    lines.push(`**Ranked by:** ${rankBy}`);
    lines.push(`**Optimization duration:** ${result.duration_seconds}s`);
    lines.push('');
    lines.push('## Configuration');
    lines.push(`- **Symbols (${selectedSymbols.length}):** ${selectedSymbols.join(', ')}`);
    lines.push(`- Date Range: ${startDate} to ${endDate}`);
    lines.push(`- Risk per trade: ${riskPercent}%`);
    lines.push(`- Spread (pips): ${spreadPips}`);
    lines.push(`- Slippage (pips): ${slippagePips}`);
    lines.push(`- Starting equity: $${startingEquity} per symbol`);
    lines.push(`- Filter: require_min_trades = ${minTrades}`);
    lines.push('');
    lines.push('## Winning Parameters');
    for (const [k, v] of Object.entries(entry.params)) {
      lines.push(`- **${k}:** ${v}`);
    }
    lines.push('');
    lines.push('## Aggregate Stats');
    const agg = entry.aggregate;
    lines.push(`- **Total P/L:** $${agg.total_pnl} (${agg.total_return_pct}%)`);
    lines.push(`- **Trades:** ${agg.trade_count} (W: ${agg.win_count}, L: ${agg.loss_count})`);
    lines.push(`- **Win Rate:** ${agg.win_rate}%`);
    lines.push(`- **Profit Factor:** ${agg.profit_factor}`);
    lines.push(`- **Max Drawdown:** ${agg.max_drawdown_pct}%`);
    lines.push('');
    lines.push('## Per-Symbol Trade + PnL Breakdown');
    lines.push('');
    lines.push('| Symbol | Trades | P/L |');
    lines.push('|---|---:|---:|');
    for (const ps of [...entry.per_symbol_trades].sort((a: any, b: any) => b.total_pnl - a.total_pnl)) {
      lines.push(`| ${ps.symbol} | ${ps.trade_count} | $${ps.total_pnl} |`);
    }
    lines.push('');

    // Top 5 alternative parameter sets for comparison
    const alternatives = (result.ranked || []).slice(0, 5).filter((r: any) => r.rank !== entry.rank);
    if (alternatives.length > 0) {
      lines.push('## Other Top Parameter Combos (for comparison)');
      lines.push('');
      lines.push(`| Rank | Params | Trades | Win% | P/L | Profit Factor | Max DD% |`);
      lines.push(`|---:|---|---:|---:|---:|---:|---:|`);
      for (const alt of alternatives) {
        const paramStr = Object.entries(alt.params).map(([k, v]) => `${k}=${v}`).join(' ');
        const a = alt.aggregate;
        lines.push(`| ${alt.rank} | ${paramStr} | ${a.trade_count} | ${a.win_rate} | $${a.total_pnl} | ${a.profit_factor} | ${a.max_drawdown_pct} |`);
      }
      lines.push('');
    }

    lines.push('## Strategy Description');
    lines.push('Triple Screen Multi-Timeframe trend-following on MT5 (live broker IUX).');
    lines.push('- D1 SMA(fast/slow) macro trend filter.');
    lines.push('- H4 SMA(fast/slow) must AGREE with D1 (strict alignment).');
    lines.push('- H1 RSI in entry zone + tick_volume > H1 VMA = entry trigger.');
    lines.push('- Pending LIMIT order at low (BUY) or high (SELL) of previous CLOSED H1 bar.');
    lines.push('- SL = entry ± SL_mult × ATR(14), TP = entry ± TP_mult × ATR(14).');
    lines.push('- Risk computed off EQUITY (not balance) — drawdown-adaptive.');
    lines.push('- Pending orders cancelled after 24 unfilled H1 bars.');
    lines.push('- Cost: spread + slippage subtracted per closed trade.');
    lines.push('');
    lines.push('## Analysis Questions for AI');
    lines.push('1. Are the winning parameters within the "interior" of the swept ranges, or at the edge? Edge-of-grid hits suggest the optimum is OUTSIDE this sweep — recommend new ranges.');
    lines.push('2. Look at the per-symbol breakdown — does a single symbol dominate the P/L? If yes, the strategy may be over-fit to one asset.');
    lines.push('3. Compare top-5 parameter sets — are the params stable (similar to each other) or scattered? Stable = robust; scattered = unstable = potential overfit.');
    lines.push('4. The optimizer ranked by `' + rankBy + '`. Would ranking by a different metric give meaningfully different winners? If so, the strategy has no single "best" point.');
    lines.push('5. What additional sweeps would you recommend testing next (specifying ranges)?');
    lines.push('6. Are these results consistent with the strategy thesis (trend-following pullback entries)? If not, what does the data suggest the strategy IS doing?');
    return lines.join('\n');
  };

  const copyReport = async (entry: any) => {
    try {
      await navigator.clipboard.writeText(buildReportForRank(entry));
      setCopiedRank(entry.rank);
      setTimeout(() => setCopiedRank(null), 2500);
    } catch {
      const w = window.open('', '_blank');
      if (w) w.document.body.innerText = buildReportForRank(entry);
    }
  };

  const copyAllReports = async () => {
    if (!result?.ranked) return;
    const SEPARATOR = '\n\n---\n\n';
    const big = result.ranked.map((r: any) => buildReportForRank(r)).join(SEPARATOR);
    try {
      await navigator.clipboard.writeText(big);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2500);
    } catch {
      // Fallback: download as file
      downloadAllReports();
    }
  };

  const downloadAllReports = () => {
    if (!result?.ranked) return;
    const SEPARATOR = '\n\n---\n\n';
    const big = result.ranked.map((r: any) => buildReportForRank(r)).join(SEPARATOR);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([big], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `optimize-report-${ts}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const applyWinnersToCoreAssets = async (entry: any, minPnl: number = 0) => {
    const winners = entry.per_symbol_trades
      .filter((s: any) => s.total_pnl > minPnl && s.trade_count > 0)
      .map((s: any) => s.symbol);
    const dropped = entry.per_symbol_trades
      .filter((s: any) => !(s.total_pnl > minPnl && s.trade_count > 0))
      .map((s: any) => s.symbol);

    if (winners.length === 0) {
      toast.warning('No symbols with positive P/L in this combo. Nothing to apply.');
      return;
    }

    const msg = [
      `Apply rank #${entry.rank} winners as your Asset Universe?`,
      '',
      `KEEP (${winners.length}, total P/L > $${minPnl}):`,
      winners.join(', '),
      '',
      `DROP (${dropped.length}):`,
      dropped.join(', ') || '(none)',
      '',
      'This overwrites the core_assets setting. You can revert via Settings → Reset.',
    ].join('\n');

    if (!confirm(msg)) return;

    setApplyingRank(entry.rank);
    try {
      const r = await fetch(`${API_BASE}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'core_assets', value: JSON.stringify(winners) }),
      });
      const d = await r.json();
      if (d.status === 'success') {
        setApplyResult({ rank: entry.rank, kept: winners, dropped });
        // Force WS-driven assets refresh by hitting the endpoint — store will pick up
        try {
          const cr = await fetch(`${API_BASE}/api/config/assets`).then(x => x.json());
          if (cr.assets) useMarketStore.getState().setAssets(cr.assets);
        } catch { /* ignore */ }
      } else {
        toast.error('Failed to apply: ' + JSON.stringify(d));
      }
    } catch (e: any) {
      toast.error('Apply failed: ' + String(e));
    }
    setApplyingRank(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Zap className="text-warning" size={32} />
          Backtest Optimization
        </h1>
        <p className="text-textMuted text-sm mt-1">
          Grid-search across parameter ranges to find the best Triple Screen configuration. Each combo is tested on every selected symbol.
        </p>
      </div>

      {/* Symbols */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <h3 className="text-lg font-bold">Symbols</h3>
            <p className="text-xs text-textMuted">{selectedSymbols.length} selected — each combo runs N times (one per symbol)</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={selectFromSettings} className="text-xs bg-surfaceLight hover:bg-surface text-text px-3 py-1.5 rounded">From Settings ({coreAssets.length})</button>
            <button onClick={selectAll} className="text-xs bg-primary/20 hover:bg-primary/30 text-primary px-3 py-1.5 rounded">Select All</button>
            <button onClick={clearAll} className="text-xs bg-danger/10 hover:bg-danger/20 text-danger px-3 py-1.5 rounded">Clear</button>
          </div>
        </div>
        <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text mb-3" />
        <div className="max-h-40 overflow-y-auto custom-scrollbar grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1.5 bg-background/40 p-2 rounded border border-surfaceLight">
          {filteredSymbolList.slice(0, 300).map(sym => {
            const sel = selectedSymbols.includes(sym);
            return (
              <button key={sym} onClick={() => toggleSymbol(sym)} className={`text-xs px-2 py-1.5 rounded border ${sel ? 'bg-primary/30 border-primary text-primary font-semibold' : 'bg-surface border-surfaceLight text-textMuted hover:border-textMuted/50'}`}>
                {sym}
              </button>
            );
          })}
        </div>
      </div>

      {/* Dates + fixed params */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-lg font-bold">Date Range &amp; Fixed Parameters</h3>
          {dateRange?.intersection?.first && (
            <span className="text-xs text-textMuted">Available: <span className="text-success font-mono">{intersectionFirst}</span> → <span className="text-success font-mono">{intersectionLast}</span> ({dateRange.intersection.days_available} days)</span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Start</label>
            <CalendarPicker value={startDate} onChange={setStartDate} min={intersectionFirst} max={intersectionLast} disabled={!validRange} placeholder="Pick start" rangeStart={startDate} rangeEnd={endDate} />
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">End</label>
            <CalendarPicker value={endDate} onChange={setEndDate} min={intersectionFirst} max={intersectionLast} disabled={!validRange} placeholder="Pick end" rangeStart={startDate} rangeEnd={endDate} />
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
            <label className="text-xs text-textMuted uppercase block mb-1">Equity / symbol</label>
            <input type="number" step="100" value={startingEquity} onChange={e => setStartingEquity(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text" />
          </div>
        </div>
      </div>

      {/* Sweeps */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-6">
        <h3 className="text-lg font-bold mb-3">Parameter Sweeps</h3>
        <p className="text-xs text-textMuted mb-4">Enable a parameter and provide comma-separated values to try. The optimizer tests every combination across every symbol.</p>
        <div className="space-y-3">
          {Object.entries(sweeps).map(([key, sc]) => (
            <div key={key} className="flex items-center gap-3 p-3 bg-background border border-surfaceLight rounded">
              <input
                type="checkbox"
                checked={sc.enabled}
                onChange={e => updateSweep(key, { enabled: e.target.checked })}
                className="w-4 h-4 accent-primary"
              />
              <div className="flex-1">
                <label className="font-semibold text-text">{sc.label}</label>
                <p className="text-xs text-textMuted">{sc.description}</p>
              </div>
              <input
                type="text"
                value={sc.values}
                onChange={e => updateSweep(key, { values: e.target.value })}
                disabled={!sc.enabled}
                placeholder="e.g. 1.0, 1.5, 2.0"
                className="w-72 bg-surface border border-surfaceLight rounded px-3 py-2 text-text text-sm disabled:opacity-40 font-mono"
              />
              <span className="text-xs text-textMuted w-16 text-right">
                {sc.enabled ? `${parseValues(sc.values, sc.type).length} vals` : 'disabled'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Ranking + run */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div className="md:col-span-2">
            <label className="text-xs text-textMuted uppercase block mb-1">Rank by</label>
            <select value={rankBy} onChange={e => setRankBy(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text">
              {METRICS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Top N results</label>
            <input type="number" value={topN} onChange={e => setTopN(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text" />
          </div>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Min trades to qualify</label>
            <input type="number" value={minTrades} onChange={e => setMinTrades(e.target.value)} className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4 p-3 bg-background/40 border border-primary/30 rounded">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={walkForward}
              onChange={e => setWalkForward(e.target.checked)}
              className="w-4 h-4 accent-primary"
            />
            <div>
              <div className="text-sm font-semibold text-primary">Walk-Forward Validate</div>
              <div className="text-xs text-textMuted">Train on first portion, test out-of-sample. Recommended.</div>
            </div>
          </label>
          <div>
            <label className="text-xs text-textMuted uppercase block mb-1">Train ratio (0.4-0.9)</label>
            <input
              type="number"
              step="0.05"
              min={0.4}
              max={0.9}
              value={trainRatio}
              onChange={e => setTrainRatio(e.target.value)}
              disabled={!walkForward}
              className="w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text disabled:opacity-40"
            />
          </div>
          <div className="text-xs text-textMuted flex items-center">
            {walkForward ? (
              <span>
                Train ≈ {(parseFloat(trainRatio) * 100).toFixed(0)}% / Test ≈ {((1 - parseFloat(trainRatio)) * 100).toFixed(0)}% of window.
                Robustness = OOS_PF / IS_PF.
                <span className="text-success"> ≥0.85 = Robust</span>,
                <span className="text-warning"> 0.5-0.85 = Marginal</span>,
                <span className="text-danger"> &lt;0.5 = Overfit</span>.
              </span>
            ) : (
              <span className="text-warning">In-sample only — results may overfit to this window. Enable Walk-Forward.</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-3 p-3 bg-background border border-surfaceLight rounded mb-4">
          <div className="text-sm">
            <strong className="text-warning">Grid size:</strong> <span className="font-mono">{gridSize}</span> param combos
            × <span className="font-mono">{selectedSymbols.length}</span> symbols
            = <span className="font-mono text-warning">{totalRuns}</span> total backtests
          </div>
          <div className="text-xs text-textMuted">
            Est. duration: ~{estimatedSeconds < 60 ? `${estimatedSeconds.toFixed(0)}s` : `${(estimatedSeconds / 60).toFixed(1)} min`}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={run} disabled={running || !validRange || gridSize === 0} className="bg-warning hover:bg-warning/80 text-background px-6 py-3 rounded-lg font-bold flex items-center gap-2 disabled:opacity-50">
            {running ? <Loader2 size={18} className="animate-spin" /> : <Zap size={18} />}
            {running ? 'Running...' : 'Run Optimization'}
          </button>
          {running && (
            <button onClick={cancelJob} className="bg-danger/20 hover:bg-danger/30 border border-danger/50 text-danger px-4 py-3 rounded-lg font-semibold flex items-center gap-2">
              <X size={16} />
              Cancel
            </button>
          )}
        </div>

        {/* Live progress */}
        {running && progress && (
          <div className="mt-4 bg-background border border-surfaceLight rounded-lg p-4">
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="font-semibold text-warning">
                {progress.combos_done > 0 ? `Combo ${progress.combos_done}/${progress.combos_total}` : 'Starting...'}
              </span>
              <span className="text-textMuted font-mono">
                {progress.runs_done}/{progress.runs_total} runs · {progress.pct.toFixed(1)}%
              </span>
            </div>
            <div className="w-full bg-surface rounded-full h-2 overflow-hidden border border-surfaceLight">
              <div
                className="h-full bg-warning transition-all duration-300"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            <p className="text-xs text-textMuted mt-2">
              Optimization runs in a background thread. WebSocket tick + other dashboards stay live during the run.
              {jobId && <> · Job <code className="bg-surface px-1 rounded">{jobId.slice(0, 8)}</code></>}
            </p>
          </div>
        )}
      </div>

      {error && <div className="bg-danger/10 border border-danger/30 rounded-lg p-4 text-danger">{error}</div>}

      {result && (
        <div className="bg-surface border border-surfaceLight rounded-lg p-6">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-xl font-bold">Results — Top {Math.min(parseInt(topN), result.ranked?.length || 0)}</h3>
              <div className="text-xs text-textMuted mt-1">
                {result.qualified}/{result.total_combos} combos qualified · {result.filtered_out_low_trades} filtered (too few trades) · {result.duration_seconds}s
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={copyAllReports}
                disabled={!result.ranked?.length}
                className={`flex items-center gap-2 px-3 py-2 rounded text-sm font-semibold transition-colors ${
                  copiedAll ? 'bg-success/20 border border-success/50 text-success' : 'bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary'
                }`}
                title="Copy reports for ALL ranked results, separated by horizontal rules"
              >
                {copiedAll ? <><Check size={14} /> Copied all!</> : <><Copy size={14} /> Copy All ({result.ranked?.length || 0})</>}
              </button>
              <button
                onClick={downloadAllReports}
                disabled={!result.ranked?.length}
                className="flex items-center gap-2 px-3 py-2 rounded text-sm font-semibold bg-surfaceLight hover:bg-surface text-text transition-colors"
                title="Download all ranked reports as one .md file (better for very long outputs)"
              >
                <FileDown size={14} /> Download .md
              </button>
            </div>
          </div>

          {applyResult && (
            <div className="bg-success/10 border border-success/30 rounded p-3 mb-4 text-sm">
              <strong className="text-success">Applied rank #{applyResult.rank}:</strong> core_assets now = {applyResult.kept.length} symbols ({applyResult.kept.join(', ')}). Dropped {applyResult.dropped.length} losers.
            </div>
          )}

          {result.ranked.length === 0 ? (
            <div className="text-center py-8 text-textMuted">
              No combos qualified. Lower "Min trades to qualify" or widen sweep ranges.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-background">
                  <tr className="text-textMuted">
                    <th className="text-left py-2 px-2 font-semibold">#</th>
                    <th className="text-left py-2 px-2 font-semibold">Parameters</th>
                    <th className="text-right py-2 px-2 font-semibold">Trades</th>
                    <th className="text-right py-2 px-2 font-semibold">Win%</th>
                    <th className="text-right py-2 px-2 font-semibold">IS PF</th>
                    {result.walk_forward && <th className="text-right py-2 px-2 font-semibold border-l border-surfaceLight">OOS PF</th>}
                    {result.walk_forward && <th className="text-center py-2 px-2 font-semibold">Robust</th>}
                    <th className="text-right py-2 px-2 font-semibold">Total P/L</th>
                    <th className="text-right py-2 px-2 font-semibold">Return%</th>
                    <th className="text-right py-2 px-2 font-semibold">Max DD%</th>
                    <th className="text-center py-2 px-2 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {result.ranked.map((r: any) => {
                    const robClass =
                      r.robustness_label === 'Robust' ? 'bg-success/20 text-success' :
                      r.robustness_label === 'Marginal' ? 'bg-warning/20 text-warning' :
                      r.robustness_label === 'Overfit' ? 'bg-danger/20 text-danger' :
                      'bg-surfaceLight text-textMuted';
                    return (
                    <React.Fragment key={r.rank}>
                      <tr className={`border-b border-surfaceLight hover:bg-background/40 ${r.rank === 1 ? 'bg-success/5' : ''}`}>
                        <td className="py-2 px-2 font-bold">{r.rank}</td>
                        <td className="py-2 px-2 font-mono text-xs">
                          {Object.entries(r.params).map(([k, v]) => `${k.replace('_atr_mult', '×ATR').replace('_period', '').replace('rsi_entry_', 'RSI')}=${v}`).join(' · ')}
                        </td>
                        <td className="text-right py-2 px-2 font-mono">{r.aggregate.trade_count}</td>
                        <td className="text-right py-2 px-2 font-mono">{r.aggregate.win_rate}%</td>
                        <td className="text-right py-2 px-2 font-mono">{r.aggregate.profit_factor}</td>
                        {result.walk_forward && (
                          <td className={`text-right py-2 px-2 font-mono border-l border-surfaceLight ${r.oos_aggregate?.profit_factor >= 1 ? 'text-success' : 'text-danger'}`}>
                            {r.oos_aggregate?.profit_factor ?? '—'}
                          </td>
                        )}
                        {result.walk_forward && (
                          <td className="text-center py-2 px-2">
                            <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${robClass}`} title={`Robustness = ${r.robustness_score}`}>
                              {r.robustness_label || '—'}
                            </span>
                          </td>
                        )}
                        <td className={`text-right py-2 px-2 font-mono font-bold ${r.aggregate.total_pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                          {r.aggregate.total_pnl >= 0 ? '+' : ''}${r.aggregate.total_pnl}
                        </td>
                        <td className={`text-right py-2 px-2 font-mono ${r.aggregate.total_return_pct >= 0 ? 'text-success' : 'text-danger'}`}>{r.aggregate.total_return_pct}%</td>
                        <td className="text-right py-2 px-2 font-mono text-warning">{r.aggregate.max_drawdown_pct}%</td>
                        <td className="text-center py-2 px-2">
                          <div className="flex gap-1 justify-center">
                            <button
                              onClick={() => setExpandedRow(expandedRow === r.rank ? null : r.rank)}
                              className="bg-surfaceLight hover:bg-surface text-text rounded px-2 py-1"
                              title="Expand per-symbol"
                            >
                              {expandedRow === r.rank ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </button>
                            <button
                              onClick={() => copyReport(r)}
                              className={`rounded px-2 py-1 ${copiedRank === r.rank ? 'bg-success/20 text-success' : 'bg-primary/20 hover:bg-primary/30 text-primary'}`}
                              title="Copy report"
                            >
                              {copiedRank === r.rank ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                            <button
                              onClick={() => applyWinnersToCoreAssets(r)}
                              disabled={applyingRank === r.rank}
                              className="rounded px-2 py-1 bg-warning/20 hover:bg-warning/30 text-warning disabled:opacity-50"
                              title="Apply this rank's profitable symbols as the live core_assets universe"
                            >
                              {applyingRank === r.rank ? <Loader2 size={14} className="animate-spin" /> : <Target size={14} />}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedRow === r.rank && (
                        <tr className="bg-background">
                          <td colSpan={result.walk_forward ? 11 : 9} className="p-4">
                            <h4 className="text-sm font-bold mb-2 text-textMuted uppercase">Per-symbol breakdown</h4>
                            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                              {[...r.per_symbol_trades].sort((a: any, b: any) => b.total_pnl - a.total_pnl).map((ps: any) => (
                                <div key={ps.symbol} className="bg-surface border border-surfaceLight rounded p-2">
                                  <div className="font-bold text-xs">{ps.symbol}</div>
                                  <div className="text-xs text-textMuted">{ps.trade_count} trades</div>
                                  <div className={`text-sm font-mono font-bold ${ps.total_pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                                    {ps.total_pnl >= 0 ? '+' : ''}${ps.total_pnl}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BacktestOptimize;
