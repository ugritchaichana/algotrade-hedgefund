import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Bot, Loader2, Activity, Bell, Shield, RotateCcw } from 'lucide-react';
import { useMarketStore } from '../store/useMarketStore';
import { API_BASE } from '../lib/api';

const Settings = () => {
  const [allSymbols, setAllSymbols] = useState<any[]>([]);
  const [loadingSymbols, setLoadingSymbols] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [search, setSearch] = useState('');

  const assets = useMarketStore(state => state.assets);
  const setAssets = useMarketStore(state => state.setAssets);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [discordWebhook, setDiscordWebhook] = useState('');
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(true);
  const [riskTolerance, setRiskTolerance] = useState('Balanced');
  const [maxOpenPositions, setMaxOpenPositions] = useState('5');
  const [maxDailyDdPct, setMaxDailyDdPct] = useState('3.0');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // One-time fetch of symbols + existing settings
  useEffect(() => {
    fetch(`${API_BASE}/api/mt5/symbols`)
      .then(r => r.json())
      .then(d => {
        setAllSymbols(d.symbols || []);
        setLoadingSymbols(false);
      })
      .catch(() => setLoadingSymbols(false));

    fetch(`${API_BASE}/api/settings`)
      .then(r => r.json())
      .then(d => {
        if (d.discord_webhook) setDiscordWebhook(d.discord_webhook);
        if (d.auto_trade_enabled) setAutoTradeEnabled(d.auto_trade_enabled === 'true');
        if (d.risk_tolerance) setRiskTolerance(d.risk_tolerance);
        if (d.max_open_positions) setMaxOpenPositions(d.max_open_positions);
        if (d.max_daily_drawdown_pct) setMaxDailyDdPct(d.max_daily_drawdown_pct);
      });
  }, []);

  // Sync selectedAssets when store updates
  useEffect(() => {
    setSelectedAssets(assets);
  }, [assets]);

  const toggleAsset = (sym: string) => {
    setSelectedAssets(prev => (prev.includes(sym) ? prev.filter(a => a !== sym) : [...prev, sym]));
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleAISuggest = async () => {
    setSuggesting(true);
    try {
      const r = await fetch(`${API_BASE}/api/analysis/recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: allSymbols.map(s => s.name) }),
      });
      const d = await r.json();
      if (d.recommended_assets) setSelectedAssets(d.recommended_assets);
    } catch {
      showToast('AI suggest failed', 'error');
    }
    setSuggesting(false);
  };

  const saveSettings = async () => {
    try {
      const items = [
        { key: 'core_assets', value: JSON.stringify(selectedAssets) },
        { key: 'discord_webhook', value: discordWebhook },
        { key: 'auto_trade_enabled', value: autoTradeEnabled ? 'true' : 'false' },
        { key: 'risk_tolerance', value: riskTolerance },
        { key: 'max_open_positions', value: maxOpenPositions },
        { key: 'max_daily_drawdown_pct', value: maxDailyDdPct },
      ];
      for (const s of items) {
        const r = await fetch(`${API_BASE}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(s),
        });
        if (!r.ok) throw new Error('save failed');
      }
      setAssets(selectedAssets);
      showToast('Settings saved', 'success');
    } catch {
      showToast('Failed to save', 'error');
    }
  };

  const resetAssets = async () => {
    if (!confirm('Reset asset universe to defaults? This replaces your current selection.')) return;
    try {
      const r = await fetch(`${API_BASE}/api/settings/reset-assets`, { method: 'POST' });
      const d = await r.json();
      if (d.status === 'success') {
        setSelectedAssets(d.assets);
        setAssets(d.assets);
        showToast('Asset universe reset to defaults', 'success');
      }
    } catch {
      showToast('Reset failed', 'error');
    }
  };

  const filtered = allSymbols.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-text flex items-center gap-3">
            <SettingsIcon className="w-8 h-8 text-primary" />
            System Settings
          </h1>
          <p className="text-textMuted mt-2">Configure asset universe, risk gates, and AI execution</p>
        </div>
        <button
          onClick={saveSettings}
          className="bg-primary hover:bg-primary/80 text-white px-6 py-3 rounded-lg font-semibold flex items-center gap-2 transition-colors shadow-lg"
        >
          <Save className="w-5 h-5" />
          Save Changes
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-surface border border-surfaceLight rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <Activity className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-text">Asset Universe (MT5)</h2>
                  <p className="text-sm text-textMuted">{selectedAssets.length} assets selected for scanning</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={resetAssets}
                  className="bg-surfaceLight hover:bg-surface text-textMuted border border-surfaceLight px-3 py-2 rounded-lg font-medium flex items-center gap-2 transition-all text-sm"
                  title="Reset to DEFAULT_30_ASSETS"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </button>
                <button
                  onClick={handleAISuggest}
                  disabled={suggesting || loadingSymbols}
                  className="bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 border border-purple-500/30 px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-all"
                >
                  {suggesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
                  {suggesting ? 'Analyzing...' : 'AI Suggest'}
                </button>
              </div>
            </div>

            <input
              type="text"
              placeholder="Search MT5 symbols..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-background border border-surfaceLight rounded-lg px-4 py-3 text-text mb-4 focus:outline-none focus:border-primary transition-colors"
            />

            <div className="h-[400px] overflow-y-auto pr-2 custom-scrollbar border border-surfaceLight rounded-lg bg-background/50 p-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {loadingSymbols ? (
                <div className="col-span-full flex flex-col items-center justify-center h-full text-textMuted">
                  <Loader2 className="w-8 h-8 animate-spin mb-2" />
                  <p>Loading MT5 symbols...</p>
                </div>
              ) : (
                filtered.map(sym => {
                  const isSelected = selectedAssets.includes(sym.name);
                  return (
                    <div
                      key={sym.name}
                      onClick={() => toggleAsset(sym.name)}
                      className={`cursor-pointer border rounded-lg p-3 flex flex-col gap-1 transition-all ${
                        isSelected
                          ? 'bg-primary/20 border-primary text-text'
                          : 'bg-surface border-surfaceLight text-textMuted hover:border-textMuted/50'
                      }`}
                    >
                      <span className="font-bold">{sym.name}</span>
                      <span className="text-xs opacity-70 truncate" title={sym.description}>{sym.description || '—'}</span>
                      <span className="text-xs font-mono mt-1 opacity-50">Spread: {sym.spread}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-surface border border-surfaceLight rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-blue-500/10 rounded-lg">
                <Bell className="w-6 h-6 text-blue-400" />
              </div>
              <h2 className="text-xl font-bold text-text">Notifications</h2>
            </div>
            <label className="text-sm font-medium text-textMuted block mb-2">Discord Webhook URL</label>
            <input
              type="text"
              value={discordWebhook}
              onChange={e => setDiscordWebhook(e.target.value)}
              placeholder="https://discord.com/api/webhooks/..."
              className="w-full bg-background border border-surfaceLight rounded-lg px-4 py-3 text-text focus:outline-none focus:border-blue-400 transition-colors"
            />
          </div>

          <div className="bg-surface border border-surfaceLight rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-orange-500/10 rounded-lg">
                <Shield className="w-6 h-6 text-orange-400" />
              </div>
              <h2 className="text-xl font-bold text-text">Risk & Execution</h2>
            </div>

            <div className="space-y-5">
              <div>
                <label className="text-sm font-medium text-textMuted block mb-2">Risk Tolerance (% per trade)</label>
                <select
                  value={riskTolerance}
                  onChange={e => setRiskTolerance(e.target.value)}
                  className="w-full bg-background border border-surfaceLight rounded-lg px-4 py-3 text-text focus:outline-none focus:border-orange-400 transition-colors"
                >
                  <option value="Conservative">Conservative (0.5%)</option>
                  <option value="Balanced">Balanced (1.0%)</option>
                  <option value="Aggressive">Aggressive (2.0%)</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-textMuted block mb-2">Max Open Positions</label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxOpenPositions}
                  onChange={e => setMaxOpenPositions(e.target.value)}
                  className="w-full bg-background border border-surfaceLight rounded-lg px-4 py-3 text-text"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-textMuted block mb-2">Daily Drawdown Limit (%)</label>
                <input
                  type="number"
                  step="0.1"
                  min={0.5}
                  max={50}
                  value={maxDailyDdPct}
                  onChange={e => setMaxDailyDdPct(e.target.value)}
                  className="w-full bg-background border border-surfaceLight rounded-lg px-4 py-3 text-text"
                />
                <p className="text-xs text-textMuted mt-1">Auto-trade halts for the day if today's realized loss exceeds this percent of equity.</p>
              </div>

              <div className="flex items-center justify-between p-4 bg-background border border-surfaceLight rounded-lg">
                <div>
                  <h3 className="font-semibold text-text">Auto Trade</h3>
                  <p className="text-xs text-textMuted mt-1">Allow the bot to send real MT5 orders on ENTRY signals.</p>
                </div>
                <button
                  onClick={() => setAutoTradeEnabled(!autoTradeEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    autoTradeEnabled ? 'bg-success' : 'bg-surfaceLight'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    autoTradeEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 px-6 py-3 rounded-lg shadow-xl flex items-center gap-3 z-50 ${
          toast.type === 'success'
            ? 'bg-success/20 border border-success/50 text-success'
            : 'bg-danger/20 border border-danger/50 text-danger'
        }`}>
          <div className={`w-2 h-2 rounded-full ${toast.type === 'success' ? 'bg-success' : 'bg-danger'}`}></div>
          <span className="font-semibold">{toast.message}</span>
        </div>
      )}
    </div>
  );
};

export default Settings;
