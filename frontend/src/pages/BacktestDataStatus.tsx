import React, { useEffect, useState } from 'react';
import { Database, Loader2, Download, RefreshCw, History } from 'lucide-react';
import { API_BASE } from '../lib/api';

interface DataRow {
  symbol: string;
  timeframe: string;
  count: number;
  first: string | null;
  last: string | null;
}

const BacktestDataStatus = () => {
  const [rows, setRows] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [deepBackfilling, setDeepBackfilling] = useState(false);
  const [lastIngestSummary, setLastIngestSummary] = useState<any>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/historical/status`);
      const d = await r.json();
      setRows(d.rows || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, []);

  const triggerIngest = async () => {
    if (!confirm('Incremental ingest — pull only NEW candles since last stored. Quick (10-30s).')) return;
    setIngesting(true);
    setLastIngestSummary(null);
    try {
      const r = await fetch(`${API_BASE}/api/historical/ingest-now`, { method: 'POST' });
      const d = await r.json();
      setLastIngestSummary(d.totals);
      await refresh();
    } catch (e) {
      console.error(e);
    } finally {
      setIngesting(false);
    }
  };

  const triggerDeepBackfill = async () => {
    if (!confirm(
      'Deep Backfill: force-fetch 5000 candles per timeframe (D1 ≈ 14 years, H4 ≈ 2.5 years, H1 ≈ 7 months).\n\n' +
      'May take 1-3 minutes. Use this if you want to backtest on a longer window. Idempotent — safe to run multiple times.'
    )) return;
    setDeepBackfilling(true);
    setLastIngestSummary(null);
    try {
      const r = await fetch(`${API_BASE}/api/historical/deep-backfill`, { method: 'POST' });
      const d = await r.json();
      setLastIngestSummary(d.totals);
      await refresh();
    } catch (e) {
      console.error(e);
    } finally {
      setDeepBackfilling(false);
    }
  };

  // Aggregate by symbol for cleaner display
  const bySymbol: Record<string, Record<string, DataRow>> = {};
  rows.forEach(r => {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = {};
    bySymbol[r.symbol][r.timeframe] = r;
  });
  const symbols = Object.keys(bySymbol).sort();
  const timeframes = ['D1', 'H4', 'H1'];

  const totalCandles = rows.reduce((sum, r) => sum + r.count, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Database className="text-primary" size={32} />
            Backtest Data Status
          </h1>
          <p className="text-textMuted text-sm mt-1">
            OHLC candles stored in Postgres for the backtest engine.
            Auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={refresh}
            className="bg-surfaceLight hover:bg-surface text-text px-4 py-2 rounded-lg flex items-center gap-2"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={triggerIngest}
            disabled={ingesting || deepBackfilling}
            className="bg-primary hover:bg-primary/80 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50"
            title="Incremental — pull NEW candles since last sync"
          >
            {ingesting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {ingesting ? 'Ingesting...' : 'Incremental Sync'}
          </button>
          <button
            onClick={triggerDeepBackfill}
            disabled={ingesting || deepBackfilling}
            className="bg-warning hover:bg-warning/80 text-background px-4 py-2 rounded-lg font-bold flex items-center gap-2 disabled:opacity-50"
            title="Force-fetch 5000 candles per TF — deepens historical window for backtest"
          >
            {deepBackfilling ? <Loader2 size={16} className="animate-spin" /> : <History size={16} />}
            {deepBackfilling ? 'Deep Backfilling (may take 1-3 min)...' : 'Deep Backfill (5k)'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface border border-surfaceLight rounded-lg p-4">
          <div className="text-xs text-textMuted uppercase">Symbols tracked</div>
          <div className="text-2xl font-bold">{symbols.length}</div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded-lg p-4">
          <div className="text-xs text-textMuted uppercase">Timeframe slots filled</div>
          <div className="text-2xl font-bold">{rows.length}</div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded-lg p-4">
          <div className="text-xs text-textMuted uppercase">Total candles</div>
          <div className="text-2xl font-bold">{totalCandles.toLocaleString()}</div>
        </div>
      </div>

      {lastIngestSummary && (
        <div className="bg-success/10 border border-success/30 rounded-lg p-4">
          <div className="font-semibold text-success">Last ingest summary</div>
          <div className="text-sm text-textMuted mt-1">
            Fetched: {lastIngestSummary.fetched} · Inserted: {lastIngestSummary.inserted} · Errors: {lastIngestSummary.errors}
          </div>
        </div>
      )}

      <div className="bg-surface border border-surfaceLight rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-background border-b border-surfaceLight">
            <tr>
              <th className="text-left py-3 px-4 font-semibold">Symbol</th>
              {timeframes.map(tf => (
                <th key={tf} className="text-center py-3 px-4 font-semibold">{tf}</th>
              ))}
              <th className="text-right py-3 px-4 font-semibold">Latest</th>
            </tr>
          </thead>
          <tbody>
            {loading && symbols.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-12 text-textMuted">
                <Loader2 className="animate-spin inline mr-2" size={16} /> Loading...
              </td></tr>
            ) : symbols.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-12 text-textMuted">
                No data yet. Click "Ingest Now" to populate from MT5.
              </td></tr>
            ) : symbols.map(sym => {
              const latest = timeframes
                .map(tf => bySymbol[sym][tf]?.last)
                .filter(Boolean)
                .sort()
                .pop();
              return (
                <tr key={sym} className="border-b border-surfaceLight">
                  <td className="py-3 px-4 font-bold">{sym}</td>
                  {timeframes.map(tf => {
                    const r = bySymbol[sym][tf];
                    return (
                      <td key={tf} className="text-center py-3 px-4">
                        {r ? (
                          <span className={`px-2 py-1 rounded font-mono text-xs ${
                            r.count > 500 ? 'bg-success/20 text-success' :
                            r.count > 100 ? 'bg-warning/20 text-warning' :
                            'bg-danger/20 text-danger'
                          }`}>
                            {r.count.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-textMuted">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="text-right py-3 px-4 font-mono text-xs text-textMuted">
                    {latest ? new Date(latest).toLocaleString() : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default BacktestDataStatus;
