import React, { useEffect, useRef, useState, useMemo } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { TrendingUp, TrendingDown, Activity, AlertTriangle } from 'lucide-react';
import { ComposedChart, Area, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';
import { API_BASE } from '../lib/api';
import type { EquitySnapshot } from '../lib/types';

interface Stats {
  start_equity: number;
  current_equity: number;
  peak_equity: number;
  total_return_pct: number;
  current_dd_pct: number;
  max_dd_pct: number;
  days_tracked: number;
}

const EquityCurve = () => {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const [snapshots, setSnapshots] = useState<EquitySnapshot[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/equity/series?range=${range}`);
      if (!r.ok) {
        if (r.status === 404) {
          // endpoint not implemented yet — show empty state
          setSnapshots([]);
          setStats(null);
          setLoading(false);
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      const data = await r.json();
      setSnapshots(data.snapshots || []);
      setStats(data.stats || null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load equity data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [range]);

  useEffect(() => {
    if (!chartRef.current || snapshots.length === 0) return;

    if (!chartApi.current) {
      chartApi.current = createChart(chartRef.current, {
        layout: {
          background: { color: '#0f172a' },
          textColor: '#cbd5e1',
        },
        grid: {
          vertLines: { color: '#1e293b' },
          horzLines: { color: '#1e293b' },
        },
        rightPriceScale: { borderColor: '#334155' },
        timeScale: { borderColor: '#334155', timeVisible: true },
        autoSize: true,
      });
      seriesRef.current = chartApi.current.addSeries(AreaSeries, {
        lineColor: '#22d3ee',
        topColor: 'rgba(34, 211, 238, 0.4)',
        bottomColor: 'rgba(34, 211, 238, 0)',
        lineWidth: 2,
      });
    }

    const data = snapshots.map(s => ({
      time: Math.floor(new Date(s.recorded_at).getTime() / 1000) as any,
      value: s.equity,
    }));
    seriesRef.current?.setData(data);
    chartApi.current?.timeScale().fitContent();

    return () => {
      // cleanup on unmount
    };
  }, [snapshots]);

  useEffect(() => {
    return () => {
      chartApi.current?.remove();
      chartApi.current = null;
      seriesRef.current = null;
    };
  }, []);

  const dd = stats?.current_dd_pct ?? 0;
  const ret = stats?.total_return_pct ?? 0;

  // Compute drawdown series + daily P/L bars for Recharts overlay
  const ddSeries = useMemo(() => {
    if (snapshots.length === 0) return [];
    let peak = snapshots[0].equity;
    return snapshots.map((s) => {
      peak = Math.max(peak, s.equity);
      const dd_pct = peak > 0 ? ((s.equity - peak) / peak) * 100 : 0;
      return {
        time: new Date(s.recorded_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' }),
        equity: s.equity,
        drawdown: dd_pct,
        daily_pnl: s.daily_pnl,
      };
    });
  }, [snapshots]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold">Equity Curve</h2>
        <div className="flex gap-1 bg-surface border border-surfaceLight rounded-lg p-1">
          {(['7d', '30d', '90d', 'all'] as const).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-sm font-semibold rounded transition-colors ${
                range === r
                  ? 'bg-primary text-background'
                  : 'text-textMuted hover:bg-surfaceLight'
              }`}
            >
              {r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-surface border border-surfaceLight rounded-lg p-4 flex flex-col">
          <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
            <Activity size={14} />
            Current Equity
          </div>
          <div className="text-2xl font-bold">
            ${stats?.current_equity?.toFixed(2) ?? '—'}
          </div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded-lg p-4 flex flex-col">
          <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
            {ret >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            Total Return
          </div>
          <div className={`text-2xl font-bold ${ret >= 0 ? 'text-success' : 'text-danger'}`}>
            {stats ? `${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%` : '—'}
          </div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded-lg p-4 flex flex-col">
          <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
            <AlertTriangle size={14} />
            Current DD
          </div>
          <div className={`text-2xl font-bold ${dd > 5 ? 'text-danger' : dd > 2 ? 'text-warning' : 'text-textMuted'}`}>
            {stats ? `${dd.toFixed(2)}%` : '—'}
          </div>
        </div>
        <div className="bg-surface border border-surfaceLight rounded-lg p-4 flex flex-col">
          <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
            <AlertTriangle size={14} />
            Max DD
          </div>
          <div className={`text-2xl font-bold ${(stats?.max_dd_pct ?? 0) > 10 ? 'text-danger' : 'text-warning'}`}>
            {stats ? `${stats.max_dd_pct.toFixed(2)}%` : '—'}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-surface border border-surfaceLight rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Equity over time</h3>
        {loading ? (
          <div className="h-96 flex items-center justify-center text-textMuted">
            Loading equity data...
          </div>
        ) : error ? (
          <div className="h-96 flex items-center justify-center text-danger">
            {error}
          </div>
        ) : snapshots.length === 0 ? (
          <div className="h-96 flex items-center justify-center text-textMuted text-center px-6">
            <div>
              <div className="text-lg font-semibold mb-2">No equity history yet</div>
              <div className="text-sm">
                Equity snapshots are captured every 4 hours by the scheduler.
                <br />
                Once /api/equity/series is implemented on the backend, this chart populates.
              </div>
            </div>
          </div>
        ) : (
          <div ref={chartRef} className="h-96" />
        )}
      </div>

      {/* Drawdown + Daily P/L (Recharts overlay — themable colors) */}
      {snapshots.length > 0 && (
        <div className="bg-surface border border-surfaceLight rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Drawdown shading + Daily P/L bars</h3>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={ddSeries}>
              <XAxis dataKey="time" stroke="rgb(var(--c-textMuted))" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="left" stroke="rgb(var(--c-textMuted))" tick={{ fontSize: 11 }} domain={[(min: number) => Math.floor(min * 1.1), 0]} label={{ value: 'DD %', angle: -90, position: 'insideLeft', fill: 'rgb(var(--c-textMuted))', fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" stroke="rgb(var(--c-textMuted))" tick={{ fontSize: 11 }} label={{ value: 'Daily P/L', angle: 90, position: 'insideRight', fill: 'rgb(var(--c-textMuted))', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: 'rgb(var(--c-surface))', border: '1px solid rgb(var(--c-surfaceLight))', borderRadius: 6 }}
                labelStyle={{ color: 'rgb(var(--c-text))' }}
              />
              <ReferenceLine yAxisId="right" y={0} stroke="rgb(var(--c-textMuted))" />
              <Area yAxisId="left" type="monotone" dataKey="drawdown" stroke="rgb(var(--c-danger))" fill="rgb(var(--c-danger))" fillOpacity={0.15} />
              <Bar yAxisId="right" dataKey="daily_pnl">
                {ddSeries.map((d, idx) => (
                  <Cell key={idx} fill={d.daily_pnl >= 0 ? 'rgb(var(--c-success))' : 'rgb(var(--c-danger))'} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent snapshots table */}
      {snapshots.length > 0 && (
        <div className="bg-surface border border-surfaceLight rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Recent snapshots</h3>
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="text-textMuted border-b border-surfaceLight">
                <tr>
                  <th className="text-left py-2 font-semibold">Recorded</th>
                  <th className="text-right py-2 font-semibold">Equity</th>
                  <th className="text-right py-2 font-semibold">Balance</th>
                  <th className="text-right py-2 font-semibold">Free Margin</th>
                  <th className="text-right py-2 font-semibold">Open</th>
                  <th className="text-right py-2 font-semibold">Daily P/L</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.slice(-20).reverse().map(s => (
                  <tr key={s.id} className="border-b border-surfaceLight/40 hover:bg-surfaceLight/30">
                    <td className="py-2 font-mono text-xs">{new Date(s.recorded_at).toLocaleString()}</td>
                    <td className="py-2 text-right font-bold">${s.equity.toFixed(2)}</td>
                    <td className="py-2 text-right">${s.balance.toFixed(2)}</td>
                    <td className="py-2 text-right">${s.free_margin.toFixed(2)}</td>
                    <td className="py-2 text-right">{s.open_positions}</td>
                    <td className={`py-2 text-right font-semibold ${s.daily_pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                      {s.daily_pnl >= 0 ? '+' : ''}${s.daily_pnl.toFixed(2)}
                    </td>
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

export default EquityCurve;
