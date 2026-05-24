import React, { useEffect, useState } from 'react';
import { Activity, Database, Cpu, Clock, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { API_BASE } from '../lib/api';
import type { SystemHealthDeep } from '../lib/types';

const StatusPill = ({ ok, labelOk, labelBad }: { ok: boolean; labelOk: string; labelBad: string }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold ${
    ok ? 'bg-success/20 text-success border border-success/30' : 'bg-danger/20 text-danger border border-danger/30'
  }`}>
    {ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
    {ok ? labelOk : labelBad}
  </span>
);

const SystemHealth = () => {
  const [health, setHealth] = useState<SystemHealthDeep | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchHealth = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/health/deep`);
      if (!r.ok) {
        if (r.status === 404) {
          // endpoint not implemented yet
          setHealth(null);
          setError(null);
          setLoading(false);
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      const data = await r.json();
      setHealth(data);
      setError(null);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e?.message || 'Failed to load health');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, 15000); // refresh every 15s
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold">System Health</h2>
        {lastRefresh && (
          <div className="text-xs text-textMuted">
            Last refresh: {lastRefresh.toLocaleTimeString()} (auto-refresh 15s)
          </div>
        )}
      </div>

      {loading ? (
        <div className="bg-surface border border-surfaceLight rounded-lg p-8 text-center text-textMuted">
          Loading health data...
        </div>
      ) : error ? (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-6 text-danger">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={16} />
            <span className="font-bold">Backend unreachable</span>
          </div>
          <div className="text-sm">{error}</div>
        </div>
      ) : !health ? (
        <div className="bg-surface border border-surfaceLight rounded-lg p-8 text-center text-textMuted">
          <div className="text-lg font-semibold mb-2">/api/health/deep not implemented yet</div>
          <div className="text-sm">
            Backend endpoint pending. Once added, this page shows Postgres + MT5 + scheduler + last scans + DD state.
          </div>
        </div>
      ) : (
        <>
          {/* Top status row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-surface border border-surfaceLight rounded-lg p-4">
              <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
                <Cpu size={14} />
                Auto-trade
              </div>
              <StatusPill
                ok={health.auto_trade_enabled}
                labelOk="ENABLED"
                labelBad="DISABLED (kill switch)"
              />
            </div>
            <div className="bg-surface border border-surfaceLight rounded-lg p-4">
              <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
                <Database size={14} />
                Postgres
              </div>
              <StatusPill ok={health.postgres.ok} labelOk={`OK (${health.postgres.latency_ms?.toFixed(0)}ms)`} labelBad="DOWN" />
            </div>
            <div className="bg-surface border border-surfaceLight rounded-lg p-4">
              <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
                <Activity size={14} />
                MT5
              </div>
              <StatusPill
                ok={health.mt5.ok && health.mt5.trade_allowed}
                labelOk={`OK ${health.mt5.ping_ms?.toFixed(0)}ms`}
                labelBad="DISCONNECTED"
              />
            </div>
            <div className="bg-surface border border-surfaceLight rounded-lg p-4">
              <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
                <AlertTriangle size={14} />
                Daily DD
              </div>
              <StatusPill
                ok={!health.daily_dd_limit_hit}
                labelOk={`Under ${health.daily_dd_limit_pct.toFixed(1)}%`}
                labelBad={`HIT ${health.daily_dd_limit_pct.toFixed(1)}%`}
              />
            </div>
          </div>

          {/* Today realized PnL */}
          <div className="bg-surface border border-surfaceLight rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-3">Today realized P/L</h3>
            <div className={`text-3xl font-bold ${health.realized_pnl_today >= 0 ? 'text-success' : 'text-danger'}`}>
              {health.realized_pnl_today >= 0 ? '+' : ''}${health.realized_pnl_today.toFixed(2)}
            </div>
            <div className="text-xs text-textMuted mt-1">Sum of MT5 closing deals since 00:00 UTC</div>
          </div>

          {/* Scheduler */}
          <div className="bg-surface border border-surfaceLight rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-3">Scheduler jobs</h3>
            {health.scheduler.jobs.length === 0 ? (
              <div className="text-textMuted text-sm">No scheduled jobs</div>
            ) : (
              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-sm">
                  <thead className="text-textMuted border-b border-surfaceLight">
                    <tr>
                      <th className="text-left py-2 font-semibold">Job ID</th>
                      <th className="text-left py-2 font-semibold">Last Run</th>
                      <th className="text-left py-2 font-semibold">Next Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.scheduler.jobs.map(j => (
                      <tr key={j.id} className="border-b border-surfaceLight/40">
                        <td className="py-2 font-mono text-xs">{j.id}</td>
                        <td className="py-2 font-mono text-xs">{j.last_run ? new Date(j.last_run).toLocaleString() : '—'}</td>
                        <td className="py-2 font-mono text-xs">{j.next_run ? new Date(j.next_run).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Last activity */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-surface border border-surfaceLight rounded-lg p-6">
              <div className="flex items-center gap-2 text-textMuted text-xs uppercase font-semibold mb-2">
                <Clock size={14} />
                Last quant scan
              </div>
              <div className="text-lg font-bold">
                {health.last_quant_scan ? new Date(health.last_quant_scan).toLocaleString() : '—'}
              </div>
            </div>
            <div className="bg-surface border border-surfaceLight rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-3">Last historical ingest</h3>
              <div className="grid grid-cols-3 gap-2 text-xs">
                {(['D1', 'H4', 'H1'] as const).map(tf => (
                  <div key={tf} className="bg-background border border-surfaceLight rounded p-2">
                    <div className="text-textMuted uppercase font-semibold mb-1">{tf}</div>
                    <div className="font-mono">{health.last_ingest[tf] ? new Date(health.last_ingest[tf]!).toLocaleTimeString() : '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Core assets count */}
          <div className="bg-surface border border-surfaceLight rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-2">Active universe</h3>
            <div className="text-lg">
              {health.core_assets_count} symbols (G1 should = 11)
            </div>
          </div>

          {/* Uvicorn uptime */}
          <div className="text-xs text-textMuted">
            Backend started at: {new Date(health.uvicorn_started_at).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
};

export default SystemHealth;
