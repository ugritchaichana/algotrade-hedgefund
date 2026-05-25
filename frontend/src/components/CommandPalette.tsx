/**
 * Cmd+K command palette — fast navigation + actions for solo desktop use.
 *
 * Triggered by Cmd+K / Ctrl+K. Searches: pages, actions (kill switch, refresh), recent symbols.
 */

import { useState, useEffect, useCallback } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { useMarketStore } from '../store/useMarketStore';
import { API_BASE } from '../lib/api';
import { applyTheme, getStoredTheme } from '../lib/theme';

type Action = {
  id: string;
  label: string;
  hint?: string;
  perform: () => void;
  group: string;
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const autoTradeEnabled = useMarketStore((s) => s.autoTradeEnabled);
  const setAutoTradeEnabled = useMarketStore((s) => s.setAutoTradeEnabled);

  // Global hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const runAndClose = useCallback((fn: () => void) => {
    fn();
    setOpen(false);
  }, []);

  const toggleKillSwitch = async () => {
    try {
      const endpoint = autoTradeEnabled ? '/api/kill-switch' : '/api/kill-switch/restore';
      const r = await fetch(`${API_BASE}${endpoint}`, { method: 'POST' });
      if (r.ok) setAutoTradeEnabled(!autoTradeEnabled);
    } catch {}
  };

  const toggleTheme = () => {
    const cur = getStoredTheme();
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  };

  const actions: Action[] = [
    // Navigation
    { id: 'nav-dashboard', label: 'Dashboard', hint: 'Home + activity feed', group: 'Navigate', perform: () => navigate('/') },
    { id: 'nav-quant', label: 'Quant Screener', hint: 'Triple Screen states', group: 'Navigate', perform: () => navigate('/quant') },
    { id: 'nav-execution', label: 'Execution Desk', hint: 'Manual trade + position monitor', group: 'Navigate', perform: () => navigate('/execution') },
    { id: 'nav-journal', label: 'Trade Journal', hint: 'Closed trades + filters', group: 'Navigate', perform: () => navigate('/journal') },
    { id: 'nav-equity', label: 'Equity Curve', hint: 'Account growth + DD', group: 'Navigate', perform: () => navigate('/equity') },
    { id: 'nav-backtest-run', label: 'Backtest Run', hint: 'Single configuration', group: 'Navigate', perform: () => navigate('/backtest/run') },
    { id: 'nav-backtest-opt', label: 'Backtest Optimize', hint: 'Grid search + walk-forward', group: 'Navigate', perform: () => navigate('/backtest/optimize') },
    { id: 'nav-backtest-data', label: 'Backtest Data Status', hint: 'Ingest status + deep backfill', group: 'Navigate', perform: () => navigate('/backtest/data') },
    { id: 'nav-system', label: 'System Health', hint: 'Scheduler + MT5 + DB', group: 'Navigate', perform: () => navigate('/system/health') },
    { id: 'nav-settings', label: 'Settings', hint: 'PIN, params, kill switch', group: 'Navigate', perform: () => navigate('/settings') },
    // Actions
    { id: 'act-kill', label: autoTradeEnabled ? 'STOP Auto-Trade' : 'RESUME Auto-Trade', hint: 'Kill switch toggle', group: 'Action', perform: toggleKillSwitch },
    { id: 'act-theme', label: 'Toggle Theme (Dark / Light)', group: 'Action', perform: toggleTheme },
    { id: 'act-reload', label: 'Reload Page', group: 'Action', perform: () => window.location.reload() },
    { id: 'act-auto-opt', label: 'Trigger Auto-Optimize Now', hint: 'Manual run of monthly cron', group: 'Action', perform: () => {
      fetch(`${API_BASE}/api/optimize/auto-refresh`, { method: 'POST' });
    }},
  ];

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-32 bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-surface border border-surfaceLight rounded-xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" className="text-text">
          <Command.Input
            autoFocus
            placeholder="Search pages, actions..."
            className="w-full bg-transparent text-text px-4 py-3 border-b border-surfaceLight outline-none placeholder:text-textMuted"
          />
          <Command.List className="max-h-96 overflow-y-auto p-2">
            <Command.Empty className="p-4 text-textMuted text-sm text-center">
              No results.
            </Command.Empty>
            {['Navigate', 'Action'].map((group) => (
              <Command.Group key={group} heading={group} className="text-xs text-textMuted uppercase font-semibold px-2 py-1">
                {actions.filter((a) => a.group === group).map((a) => (
                  <Command.Item
                    key={a.id}
                    value={`${a.label} ${a.hint || ''}`}
                    onSelect={() => runAndClose(a.perform)}
                    className="flex items-center justify-between px-3 py-2 rounded cursor-pointer aria-selected:bg-surfaceLight text-text"
                  >
                    <span>{a.label}</span>
                    {a.hint && <span className="text-xs text-textMuted ml-3">{a.hint}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
          <div className="px-4 py-2 border-t border-surfaceLight text-xs text-textMuted flex items-center justify-between">
            <span>Cmd+K to open</span>
            <span>Esc to close</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
