/**
 * Activity feed widget — collapsible bottom-right drawer.
 * Shows chronological stream of: TRADE_OPENED, TRADE_CLOSED, TRADE_STATE_CHANGE,
 * SAFETY_EVENT, INGEST_TICK, SETTING_CHANGED, OPTIMIZE_DONE, HEALTH_DELTA.
 * Auto-scrolls when expanded. Badge with unread count when collapsed.
 */

import { useState, useEffect, useRef } from 'react';
import { useMarketStore, type ActivityEvent } from '../store/useMarketStore';
import { Activity, X } from 'lucide-react';

function eventColor(type: string): string {
  switch (type) {
    case 'TRADE_OPENED': return 'text-success border-success/40';
    case 'TRADE_CLOSED': return 'text-primary border-primary/40';
    case 'TRADE_STATE_CHANGE': return 'text-warning border-warning/40';
    case 'SAFETY_EVENT': return 'text-danger border-danger/40';
    case 'EQUITY_SNAPSHOT': return 'text-textMuted border-surfaceLight';
    case 'OPTIMIZE_DONE': return 'text-primary border-primary/40';
    case 'INGEST_TICK': return 'text-textMuted border-surfaceLight';
    case 'HEALTH_DELTA': return 'text-warning border-warning/40';
    case 'SETTING_CHANGED': return 'text-textMuted border-surfaceLight';
    default: return 'text-text border-surfaceLight';
  }
}

function eventLine(ev: ActivityEvent): string {
  const d = ev.data || {};
  switch (ev.type) {
    case 'TRADE_OPENED':
      return `OPEN #${d.ticket} ${d.symbol} ${d.side} ${d.lot} @ ${d.entry_price}`;
    case 'TRADE_CLOSED':
      return `CLOSE #${d.ticket} ${d.symbol} pnl=$${d.pnl} R=${d.r_multiple} (${d.exit_reason})`;
    case 'TRADE_STATE_CHANGE':
      return `TRAIL #${d.ticket} ${d.symbol} stage ${d.old_stage}→${d.new_stage} SL=${d.new_sl} R=${d.r_multiple}`;
    case 'SAFETY_EVENT':
      return `SAFETY [${d.title}] ${d.detail?.slice(0, 80) || ''}`;
    case 'EQUITY_SNAPSHOT':
      return `EQUITY $${d.equity?.toFixed(2)} daily $${d.daily_pnl?.toFixed(2)} (${d.open_positions} open)`;
    case 'OPTIMIZE_DONE':
      return `OPTIMIZE ${d.status} job=${d.job_id?.slice(0, 8)}${d.auto ? ' (auto)' : ''}`;
    case 'INGEST_TICK':
      return `INGEST ${d.timeframe} ${d.symbol} +${d.inserted}`;
    case 'HEALTH_DELTA':
      return `HEALTH ${d.job_id} → ${d.last_status}${d.last_error ? `: ${d.last_error.slice(0, 50)}` : ''}`;
    case 'SETTING_CHANGED':
      return `SETTING ${d.key} = ${String(d.value).slice(0, 50)}`;
    default:
      return JSON.stringify(d).slice(0, 100);
  }
}

export function ActivityFeed() {
  const events = useMarketStore((s) => s.recentEvents);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const lastSeenRef = useRef<string | null>(null);

  // Track unread events when closed
  useEffect(() => {
    if (!open && events.length > 0) {
      if (lastSeenRef.current === null) {
        lastSeenRef.current = events[0].id;
        return;
      }
      const idx = events.findIndex((e) => e.id === lastSeenRef.current);
      if (idx > 0) setUnread((u) => u + idx);
    } else if (open && events.length > 0) {
      lastSeenRef.current = events[0].id;
      setUnread(0);
    }
  }, [events, open]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 bg-surface border border-surfaceLight rounded-full shadow-lg p-3 hover:bg-surfaceLight transition-colors flex items-center gap-2"
        title="Open activity feed"
      >
        <Activity size={18} className="text-primary" />
        {unread > 0 && (
          <span className="bg-primary text-white text-xs px-2 py-0.5 rounded-full font-semibold">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 w-96 max-h-[60vh] bg-surface border border-surfaceLight rounded-xl shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surfaceLight">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-primary" />
          <span className="font-semibold text-sm">Activity Feed</span>
          <span className="text-xs text-textMuted">{events.length}</span>
        </div>
        <button onClick={() => setOpen(false)} className="text-textMuted hover:text-text">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
        {events.length === 0 ? (
          <div className="text-textMuted text-sm text-center py-8">
            No events yet. Waiting for trades + system activity...
          </div>
        ) : (
          events.map((ev) => (
            <div
              key={ev.id}
              className={`text-xs border-l-2 pl-2 py-1.5 mb-1 ${eventColor(ev.type)}`}
            >
              <div className="font-mono">{eventLine(ev)}</div>
              <div className="text-textMuted text-[10px] mt-0.5">
                {new Date(ev.ts).toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
