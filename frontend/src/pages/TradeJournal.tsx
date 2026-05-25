import React, { useEffect, useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Download, Filter, Target, AlertTriangle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { API_BASE } from '../lib/api';
import type { TradeJournalEntry } from '../lib/types';

interface Attribution {
  window_days: number;
  overall: { count: number; win_rate: number; avg_r: number; total_pnl: number; profit_factor: number | null };
  edge: { count: number; win_rate: number; avg_r: number; total_pnl: number; profit_factor: number | null };
  noise: { count: number; win_rate: number; avg_r: number; total_pnl: number; profit_factor: number | null };
  mixed: { count: number; win_rate: number; avg_r: number; total_pnl: number; profit_factor: number | null };
  r_distribution: Record<string, number>;
  by_exit_reason: Record<string, any>;
  by_symbol: Record<string, any>;
}

const TradeJournal = () => {
  const [rows, setRows] = useState<TradeJournalEntry[]>([]);
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [symbolFilter, setSymbolFilter] = useState<string>('');
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [reasonFilter, setReasonFilter] = useState<string>('');
  const [days, setDays] = useState<number>(30);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Parallel: journal + attribution
        const [r, ar] = await Promise.all([
          fetch(`${API_BASE}/api/journal?days=${days}`),
          fetch(`${API_BASE}/api/journal/attribution?days=${days}`),
        ]);
        if (!r.ok) {
          if (r.status === 404) {
            setRows([]);
            setLoading(false);
            return;
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const data = await r.json();
        if (!cancel) {
          setRows(data.rows || []);
          if (ar.ok) {
            const adata = await ar.json();
            setAttribution(adata);
          }
        }
      } catch (e: any) {
        if (!cancel) setError(e?.message || 'Failed to load journal');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [days]);

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (symbolFilter && !r.symbol.toLowerCase().includes(symbolFilter.toLowerCase())) return false;
      if (sideFilter !== 'ALL' && r.side !== sideFilter) return false;
      if (reasonFilter && (r.exit_reason || '').toLowerCase().indexOf(reasonFilter.toLowerCase()) < 0) return false;
      return true;
    });
  }, [rows, symbolFilter, sideFilter, reasonFilter]);

  const metrics = useMemo(() => {
    const closed = filtered.filter(r => r.pnl !== null);
    const wins = closed.filter(r => (r.pnl ?? 0) > 0);
    const losses = closed.filter(r => (r.pnl ?? 0) < 0);
    const totalPnl = closed.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const winSum = wins.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const lossSum = Math.abs(losses.reduce((s, r) => s + (r.pnl ?? 0), 0));
    const pf = lossSum > 0 ? winSum / lossSum : 0;
    const wr = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
    const avgR = closed.length > 0
      ? closed.reduce((s, r) => s + (r.r_multiple ?? 0), 0) / closed.length
      : 0;
    const avgWin = wins.length > 0 ? winSum / wins.length : 0;
    const avgLoss = losses.length > 0 ? lossSum / losses.length : 0;
    const expectancy = closed.length > 0
      ? (wr / 100) * avgWin - (1 - wr / 100) * avgLoss
      : 0;
    return {
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      pf,
      wr,
      avgR,
      avgWin,
      avgLoss,
      totalPnl,
      expectancy,
    };
  }, [filtered]);

  const toggleExpand = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  const exportCsv = () => {
    if (filtered.length === 0) return;
    const cols = ['ticket', 'symbol', 'side', 'opened_at', 'closed_at', 'entry_price', 'exit_price',
                  'sl', 'tp', 'lot', 'exit_reason', 'r_multiple', 'pnl'];
    const csv = [
      cols.join(','),
      ...filtered.map(r =>
        cols.map(c => {
          const v = (r as any)[c];
          if (v === null || v === undefined) return '';
          if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
          return v;
        }).join(',')
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade_journal_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold">Trade Journal</h2>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={e => setDays(parseInt(e.target.value))}
            className="bg-surface border border-surfaceLight rounded px-3 py-1.5 text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 365 days</option>
          </select>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 border border-primary/30 text-primary rounded text-sm font-semibold hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={14} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <div className="bg-surface border border-surfaceLight rounded p-3 text-center">
          <div className="text-xs text-textMuted uppercase font-semibold mb-1">Trades</div>
          <div className="text-xl font-bold">{metrics.totalTrades}</div>
          <div className="text-xs text-textMuted">{metrics.wins}W / {metrics.losses}L</div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded p-3 text-center">
          <div className="text-xs text-textMuted uppercase font-semibold mb-1">Win Rate</div>
          <div className="text-xl font-bold">{metrics.wr.toFixed(1)}%</div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded p-3 text-center">
          <div className="text-xs text-textMuted uppercase font-semibold mb-1">Profit Factor</div>
          <div className={`text-xl font-bold ${metrics.pf > 1.5 ? 'text-success' : metrics.pf > 1.0 ? 'text-warning' : 'text-danger'}`}>
            {metrics.pf > 0 ? metrics.pf.toFixed(2) : '—'}
          </div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded p-3 text-center">
          <div className="text-xs text-textMuted uppercase font-semibold mb-1">Avg R</div>
          <div className={`text-xl font-bold ${metrics.avgR > 0 ? 'text-success' : 'text-danger'}`}>
            {metrics.avgR.toFixed(2)}
          </div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded p-3 text-center">
          <div className="text-xs text-textMuted uppercase font-semibold mb-1">Expectancy</div>
          <div className={`text-xl font-bold ${metrics.expectancy > 0 ? 'text-success' : 'text-danger'}`}>
            ${metrics.expectancy.toFixed(2)}
          </div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded p-3 text-center">
          <div className="text-xs text-textMuted uppercase font-semibold mb-1">Total P/L</div>
          <div className={`text-xl font-bold ${metrics.totalPnl >= 0 ? 'text-success' : 'text-danger'}`}>
            ${metrics.totalPnl.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Attribution (Edge vs Noise) + R-distribution — Phase 2 decision tools */}
      {attribution && attribution.overall.count > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Edge vs Noise breakdown */}
          <div className="bg-surface border border-surfaceLight rounded-lg p-4 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <Target size={16} className="text-primary" />
              <h3 className="font-semibold text-sm">Edge vs Noise</h3>
            </div>
            <p className="text-xs text-textMuted mb-3">
              Edge = thesis trades (partial close, TP, trail ≥1.5R). Noise = stopped before trail.
            </p>
            <div className="space-y-2">
              <div className="border-l-4 border-success pl-3 py-2 bg-success/5 rounded">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-success">Edge</span>
                  <span className="text-xs text-textMuted">{attribution.edge.count} trades</span>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-1 text-xs">
                  <div><span className="text-textMuted">WR</span> <span className="font-mono font-semibold">{attribution.edge.win_rate}%</span></div>
                  <div><span className="text-textMuted">PF</span> <span className="font-mono font-semibold">{attribution.edge.profit_factor ?? '∞'}</span></div>
                  <div><span className="text-textMuted">avg R</span> <span className="font-mono font-semibold">{attribution.edge.avg_r}</span></div>
                </div>
                <div className="text-xs text-textMuted mt-1">P/L: <span className={`font-mono ${attribution.edge.total_pnl >= 0 ? 'text-success' : 'text-danger'}`}>${attribution.edge.total_pnl}</span></div>
              </div>
              <div className="border-l-4 border-danger pl-3 py-2 bg-danger/5 rounded">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-danger">Noise</span>
                  <span className="text-xs text-textMuted">{attribution.noise.count} trades</span>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-1 text-xs">
                  <div><span className="text-textMuted">WR</span> <span className="font-mono font-semibold">{attribution.noise.win_rate}%</span></div>
                  <div><span className="text-textMuted">PF</span> <span className="font-mono font-semibold">{attribution.noise.profit_factor ?? '0'}</span></div>
                  <div><span className="text-textMuted">avg R</span> <span className="font-mono font-semibold">{attribution.noise.avg_r}</span></div>
                </div>
                <div className="text-xs text-textMuted mt-1">P/L: <span className={`font-mono ${attribution.noise.total_pnl >= 0 ? 'text-success' : 'text-danger'}`}>${attribution.noise.total_pnl}</span></div>
              </div>
              <div className="border-l-4 border-textMuted pl-3 py-2 bg-surfaceLight/30 rounded">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-textMuted">Mixed</span>
                  <span className="text-xs text-textMuted">{attribution.mixed.count} trades</span>
                </div>
                <div className="text-xs text-textMuted mt-1">P/L: <span className="font-mono">${attribution.mixed.total_pnl}</span></div>
              </div>
            </div>
          </div>

          {/* R-distribution histogram */}
          <div className="bg-surface border border-surfaceLight rounded-lg p-4 lg:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={16} className="text-warning" />
              <h3 className="font-semibold text-sm">R-multiple Distribution</h3>
            </div>
            <p className="text-xs text-textMuted mb-3">
              Where trades exited relative to risk. Healthy: skewed right (1.5R+ has frequency, &lt;-1R is small).
            </p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={Object.entries(attribution.r_distribution).map(([range, count]) => ({ range, count }))}>
                <XAxis dataKey="range" stroke="rgb(var(--c-textMuted))" tick={{ fontSize: 11 }} />
                <YAxis stroke="rgb(var(--c-textMuted))" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: 'rgb(var(--c-surface))', border: '1px solid rgb(var(--c-surfaceLight))', borderRadius: 6 }}
                  labelStyle={{ color: 'rgb(var(--c-text))' }}
                />
                <Bar dataKey="count">
                  {Object.keys(attribution.r_distribution).map((range, idx) => {
                    const isNeg = range.startsWith('<') || range.startsWith('-');
                    const isPos = range.startsWith('1.5') || range.startsWith('2') || range.startsWith('>=');
                    return <Cell key={idx} fill={isNeg ? 'rgb(var(--c-danger))' : isPos ? 'rgb(var(--c-success))' : 'rgb(var(--c-textMuted))'} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-textMuted text-sm">
          <Filter size={14} />
          Filters:
        </div>
        <input
          type="text"
          placeholder="Symbol"
          value={symbolFilter}
          onChange={e => setSymbolFilter(e.target.value)}
          className="bg-background border border-surfaceLight rounded px-3 py-1.5 text-sm w-32"
        />
        <select
          value={sideFilter}
          onChange={e => setSideFilter(e.target.value as 'ALL' | 'BUY' | 'SELL')}
          className="bg-background border border-surfaceLight rounded px-3 py-1.5 text-sm"
        >
          <option value="ALL">All Sides</option>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
        <input
          type="text"
          placeholder="Exit reason"
          value={reasonFilter}
          onChange={e => setReasonFilter(e.target.value)}
          className="bg-background border border-surfaceLight rounded px-3 py-1.5 text-sm w-40"
        />
        <div className="text-textMuted text-sm ml-auto">
          {filtered.length} / {rows.length} trades
        </div>
      </div>

      {/* Trade table */}
      <div className="bg-surface border border-surfaceLight rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-textMuted">Loading journal...</div>
        ) : error ? (
          <div className="p-12 text-center text-danger">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-textMuted">
            <div className="text-lg font-semibold mb-2">No trade history yet</div>
            <div className="text-sm">
              Trades will appear here once /api/journal is implemented on the backend.
              <br />
              Each closed position gets a row with signal context + R-multiple + exit reason.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-background text-textMuted border-b border-surfaceLight">
                <tr>
                  <th className="text-left py-2 px-3 font-semibold w-8"></th>
                  <th className="text-left py-2 px-3 font-semibold">Symbol</th>
                  <th className="text-left py-2 px-3 font-semibold">Side</th>
                  <th className="text-left py-2 px-3 font-semibold">Opened</th>
                  <th className="text-right py-2 px-3 font-semibold">Entry</th>
                  <th className="text-right py-2 px-3 font-semibold">Exit</th>
                  <th className="text-right py-2 px-3 font-semibold">Lot</th>
                  <th className="text-left py-2 px-3 font-semibold">Exit Reason</th>
                  <th className="text-right py-2 px-3 font-semibold">R</th>
                  <th className="text-right py-2 px-3 font-semibold">P/L</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <React.Fragment key={r.id}>
                    <tr
                      className="border-b border-surfaceLight/40 hover:bg-surfaceLight/30 cursor-pointer"
                      onClick={() => toggleExpand(r.id)}
                    >
                      <td className="py-2 px-3">
                        {expanded.has(r.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </td>
                      <td className="py-2 px-3 font-bold">{r.symbol}</td>
                      <td className={`py-2 px-3 font-bold ${r.side === 'BUY' ? 'text-success' : 'text-danger'}`}>{r.side}</td>
                      <td className="py-2 px-3 font-mono text-xs">{new Date(r.opened_at).toLocaleString()}</td>
                      <td className="py-2 px-3 text-right font-mono">{r.entry_price.toFixed(5)}</td>
                      <td className="py-2 px-3 text-right font-mono">{r.exit_price?.toFixed(5) ?? '—'}</td>
                      <td className="py-2 px-3 text-right">{r.lot}</td>
                      <td className="py-2 px-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          r.exit_reason?.includes('TP') || r.exit_reason?.includes('PARTIAL') ? 'bg-success/20 text-success' :
                          r.exit_reason?.includes('SL') ? 'bg-danger/20 text-danger' :
                          r.exit_reason?.includes('TRAIL') ? 'bg-primary/20 text-primary' :
                          'bg-surfaceLight text-textMuted'
                        }`}>
                          {r.exit_reason ?? 'OPEN'}
                        </span>
                      </td>
                      <td className={`py-2 px-3 text-right font-semibold ${(r.r_multiple ?? 0) >= 0 ? 'text-success' : 'text-danger'}`}>
                        {r.r_multiple !== null ? `${r.r_multiple >= 0 ? '+' : ''}${r.r_multiple.toFixed(2)}R` : '—'}
                      </td>
                      <td className={`py-2 px-3 text-right font-bold ${(r.pnl ?? 0) >= 0 ? 'text-success' : 'text-danger'}`}>
                        {r.pnl !== null ? `${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                    {expanded.has(r.id) && (
                      <tr className="bg-background/40 border-b border-surfaceLight/40">
                        <td colSpan={10} className="py-3 px-6">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div>
                              <div className="text-textMuted uppercase font-semibold mb-1">Initial SL</div>
                              <div className="font-mono">{r.sl.toFixed(5)}</div>
                            </div>
                            <div>
                              <div className="text-textMuted uppercase font-semibold mb-1">Initial TP</div>
                              <div className="font-mono">{r.tp.toFixed(5)}</div>
                            </div>
                            <div>
                              <div className="text-textMuted uppercase font-semibold mb-1">Slippage entry/exit</div>
                              <div className="font-mono">
                                {r.slippage_entry?.toFixed(2) ?? '—'} / {r.slippage_exit?.toFixed(2) ?? '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-textMuted uppercase font-semibold mb-1">Closed at</div>
                              <div className="font-mono">{r.closed_at ? new Date(r.closed_at).toLocaleString() : 'OPEN'}</div>
                            </div>
                            {r.signal_context && (
                              <>
                                <div>
                                  <div className="text-textMuted uppercase font-semibold mb-1">D1 / H4 Trend</div>
                                  <div className="font-mono text-xs">{r.signal_context.d1_trend ?? '?'} / {r.signal_context.h4_trend ?? '?'}</div>
                                </div>
                                <div>
                                  <div className="text-textMuted uppercase font-semibold mb-1">H1 RSI</div>
                                  <div className="font-mono">{r.signal_context.h1_rsi?.toFixed(1) ?? '—'}</div>
                                </div>
                                <div>
                                  <div className="text-textMuted uppercase font-semibold mb-1">H1 Volume vs VMA</div>
                                  <div className="font-mono">
                                    {r.signal_context.h1_volume?.toFixed(0) ?? '—'} / {r.signal_context.h1_vma?.toFixed(0) ?? '—'}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-textMuted uppercase font-semibold mb-1">ATR at entry</div>
                                  <div className="font-mono">{r.signal_context.atr?.toFixed(5) ?? '—'}</div>
                                </div>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default TradeJournal;
