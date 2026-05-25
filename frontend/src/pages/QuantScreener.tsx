import React, { useEffect, useMemo, useState } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { LineChart, Maximize2, Minimize2, TrendingUp, TrendingDown, Minus, Loader2, Search } from 'lucide-react';
import ChartWidget from '../components/ChartWidget';

const Sparkline = ({ data, color }: { data: number[], color: string }) => {
  if (!data || data.length < 2) return <div className="w-16 h-5 flex items-center justify-center"><Minus size={10} className="text-textMuted"/></div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((d, i) => `${(i / (data.length - 1)) * 64},${20 - ((d - min) / range) * 20}`).join(' ');
  return (
    <svg width="64" height="20" viewBox="0 0 64 20" className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

// Timeframes — must match backend tf_map in main.py:mt5_history
const TIMEFRAMES: { id: string; label: string }[] = [
  { id: 'M5', label: 'M5' },
  { id: 'M15', label: 'M15' },
  { id: 'H1', label: 'H1' },
  { id: 'H4', label: 'H4' },
  { id: 'D1', label: 'D' },
  { id: 'W1', label: 'W' },
];

const SELECTED_SYMBOL_KEY = 'algotrade_selected_symbol';
const TIMEFRAME_KEY = 'algotrade_chart_timeframe';

const QuantScreener = () => {
  const assets = useMarketStore(state => state.assets);
  const technical = useMarketStore(state => state.technical);
  const prices = useMarketStore(state => state.prices);
  const orders = useMarketStore(state => state.orders);
  const loadingProgress = useMarketStore(state => state.loadingProgress);
  const isFullyLoaded = useMarketStore(state => state.isFullyLoaded);

  const [isFullScreen, setIsFullScreen] = useState(false);
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState<string>(() => {
    try { return localStorage.getItem(SELECTED_SYMBOL_KEY) || ''; } catch { return ''; }
  });
  const [timeframe, setTimeframe] = useState<string>(() => {
    try { return localStorage.getItem(TIMEFRAME_KEY) || 'H1'; } catch { return 'H1'; }
  });

  // Persist user's choice across sessions
  useEffect(() => {
    if (selectedSymbol) {
      try { localStorage.setItem(SELECTED_SYMBOL_KEY, selectedSymbol); } catch {}
    }
  }, [selectedSymbol]);

  useEffect(() => {
    try { localStorage.setItem(TIMEFRAME_KEY, timeframe); } catch {}
  }, [timeframe]);

  // Auto-select first asset on first load if none stored
  useEffect(() => {
    if (!selectedSymbol && assets.length > 0) {
      setSelectedSymbol(assets[0]);
    }
  }, [assets, selectedSymbol]);

  // === Helpers ===
  const fmt = (val: any, digits = 2) => typeof val === 'number' ? val.toFixed(digits) : (val ?? '—');

  const renderTrendIcon = (regime: string, size = 14) => {
    if (!regime) return <Loader2 className="text-primary animate-spin" size={size} />;
    if (regime === 'Out of Hours') return <Minus className="text-textMuted" size={size} />;
    if (regime.includes('Bullish') || regime.includes('Uptrend')) return <TrendingUp className="text-success" size={size} />;
    if (regime.includes('Bearish') || regime.includes('Downtrend')) return <TrendingDown className="text-danger" size={size} />;
    return <Minus className="text-warning" size={size} />;
  };

  const getBiasColor = (regime: string) => {
    if (!regime) return 'text-textMuted';
    if (regime.includes('Bullish')) return 'text-success';
    if (regime.includes('Bearish')) return 'text-danger';
    return 'text-warning';
  };

  const getSignalColor = (signal: string) => {
    if (!signal) return 'bg-surface text-textMuted';
    if (signal.includes('BUY')) return 'bg-success/20 text-success border-success/50';
    if (signal.includes('SELL')) return 'bg-danger/20 text-danger border-danger/50';
    if (signal.includes('ALERT')) return 'bg-warning/20 text-warning border-warning/50';
    return 'bg-surfaceLight text-textMuted border-surfaceLight';
  };

  const formatSignal = (signal: string) => {
    if (!signal || signal === 'WAITING') return 'Waiting';
    return signal.replace('ENTRY_', '').split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  };

  const getSortPriority = (sym: string) => {
    const data = technical[sym];
    const hasActiveOrder = orders.some(o => o.symbol === sym);
    if (!data) return 99;
    if (data.signal?.includes('ENTRY')) return 1;
    if (hasActiveOrder) return 2;
    if (data.signal?.includes('ALERT')) return 3;
    return 4;
  };

  const filteredAssets = useMemo(() => {
    let list = assets.filter(sym => {
      if (assetFilter === 'ALL') return true;
      const data = technical[sym];
      const hasActiveOrder = orders.some(o => o.symbol === sym);
      if (assetFilter === 'ACTIVE') return hasActiveOrder;
      if (assetFilter === 'SIGNAL') return data?.signal?.includes('ENTRY');
      if (assetFilter === 'WAITING') return !data?.signal?.includes('ENTRY') && !hasActiveOrder;
      return true;
    });
    if (searchQuery.trim()) {
      const q = searchQuery.toUpperCase();
      list = list.filter(s => s.toUpperCase().includes(q));
    }
    list.sort((a, b) => {
      const pA = getSortPriority(a);
      const pB = getSortPriority(b);
      if (pA !== pB) return pA - pB;
      return a.localeCompare(b);
    });
    return list;
  }, [assets, technical, orders, assetFilter, searchQuery]);

  const loadedCount = assets.filter(sym => technical[sym]).length;
  const totalCount = assets.length;

  const data = selectedSymbol ? technical[selectedSymbol] : null;
  const price = selectedSymbol ? prices[selectedSymbol] : null;

  // === Render selected-symbol details (below chart) ===
  const renderDetails = () => {
    if (!selectedSymbol) {
      return (
        <div className="text-textMuted text-center py-12">Select a symbol from the watchlist →</div>
      );
    }
    if (!data) {
      return (
        <div className="text-textMuted text-center py-12 flex items-center justify-center gap-2">
          <Loader2 className="animate-spin" size={18} /> Loading {selectedSymbol} signal...
        </div>
      );
    }

    const isEntry = data.signal?.startsWith('ENTRY');
    const isAlert = data.signal === 'ALERT';
    const trends = data.trends || {};
    const d1Trend = trends.D1 || data.regime?.match(/D1:\s*(\w+)/)?.[1] || '—';
    const h4Trend = trends.H4 || data.regime?.match(/H4:\s*(\w+)/)?.[1] || '—';
    const h1Rsi = trends.H1_rsi ?? data.rsi;
    const aligned = (d1Trend === h4Trend) && (d1Trend === 'Bullish' || d1Trend === 'Bearish');

    let rrRatio = 0;
    if (data.entry && data.sl && data.tp) {
      const risk = Math.abs(data.entry - data.sl);
      const reward = Math.abs(data.tp - data.entry);
      if (risk > 0) rrRatio = reward / risk;
    }

    const trendColor = (t: string) => {
      const v = (t || '').toLowerCase();
      if (v.includes('bull')) return 'text-success bg-success/10 border-success/40';
      if (v.includes('bear')) return 'text-danger bg-danger/10 border-danger/40';
      return 'text-warning bg-warning/10 border-warning/40';
    };
    const trendIcon = (t: string) => {
      const v = (t || '').toLowerCase();
      if (v.includes('bull')) return <TrendingUp size={14} />;
      if (v.includes('bear')) return <TrendingDown size={14} />;
      return <Minus size={14} />;
    };

    const rsiZone =
      h1Rsi < 30 ? { label: 'Oversold', color: 'text-success' } :
      h1Rsi > 70 ? { label: 'Overbought', color: 'text-danger' } :
      h1Rsi >= 40 && h1Rsi <= 55 ? { label: 'Entry Zone (40-55)', color: 'text-warning' } :
      { label: 'Neutral', color: 'text-textMuted' };

    const volMatch = data.action?.match(/H1 volume \(([\d.]+)\) [<>] VMA15 \(([\d.]+)\)/);
    const parsedVol = volMatch ? parseFloat(volMatch[1]) : null;
    const parsedVma = volMatch ? parseFloat(volMatch[2]) : null;
    const parsedRatio = (parsedVol && parsedVma && parsedVma > 0) ? parsedVol / parsedVma : null;

    return (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
        {/* Triple Screen Alignment */}
        <div className="bg-background p-3 rounded-lg border border-surfaceLight lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-textMuted uppercase font-semibold">Triple Screen Alignment</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${aligned ? 'bg-success/20 text-success' : 'bg-textMuted/20 text-textMuted'}`}>
              {aligned ? 'ALIGNED' : 'WAITING'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className={`p-2 rounded border ${trendColor(d1Trend)}`}>
              <div className="text-[10px] uppercase opacity-80 mb-1">D1 Trend</div>
              <div className="flex items-center gap-1.5">
                {trendIcon(d1Trend)}<span className="text-sm font-bold">{d1Trend}</span>
              </div>
              <div className="text-[10px] opacity-70 mt-1">SMA 10/60</div>
            </div>
            <div className={`p-2 rounded border ${trendColor(h4Trend)}`}>
              <div className="text-[10px] uppercase opacity-80 mb-1">H4 Confirm</div>
              <div className="flex items-center gap-1.5">
                {trendIcon(h4Trend)}<span className="text-sm font-bold">{h4Trend}</span>
              </div>
              <div className="text-[10px] opacity-70 mt-1">SMA 10/60</div>
            </div>
            <div className={`p-2 rounded border ${rsiZone.label.startsWith('Entry') ? 'bg-warning/10 border-warning/40 text-warning' : 'bg-surfaceLight/30 border-surfaceLight text-textMuted'}`}>
              <div className="text-[10px] uppercase opacity-80 mb-1">H1 Trigger</div>
              <div className="text-sm font-bold">RSI {fmt(h1Rsi)}</div>
              <div className="text-[10px] opacity-80 mt-1">{rsiZone.label}</div>
            </div>
          </div>
        </div>

        {/* RSI gauge */}
        <div className="bg-background p-3 rounded-lg border border-surfaceLight">
          <div className="text-xs text-textMuted uppercase font-semibold mb-2">RSI (14) — H1</div>
          <div className="flex items-baseline gap-2 mb-2">
            <span className={`text-2xl font-bold ${rsiZone.color}`}>{fmt(h1Rsi)}</span>
            <span className="text-xs text-textMuted">/ 100</span>
          </div>
          <div className="relative h-2 bg-surfaceLight rounded overflow-hidden">
            <div className="absolute inset-y-0 left-0 w-[30%] bg-success/30" />
            <div className="absolute inset-y-0 left-[40%] w-[15%] bg-warning/40" />
            <div className="absolute inset-y-0 left-[70%] w-[30%] bg-danger/30" />
            <div className="absolute inset-y-0 w-0.5 bg-text" style={{ left: `${Math.min(100, Math.max(0, h1Rsi))}%` }} />
          </div>
          <div className="flex justify-between text-[9px] text-textMuted mt-1 font-mono">
            <span>0</span><span>30</span><span>40-55</span><span>70</span><span>100</span>
          </div>
        </div>

        {/* Volume vs VMA */}
        <div className="bg-background p-3 rounded-lg border border-surfaceLight">
          <div className="text-xs text-textMuted uppercase font-semibold mb-2">Volume vs VMA(15)</div>
          {parsedRatio !== null ? (
            <>
              <div className="flex items-baseline gap-2 mb-2">
                <span className={`text-2xl font-bold ${parsedRatio > 1 ? 'text-success' : 'text-textMuted'}`}>{parsedRatio.toFixed(2)}x</span>
              </div>
              <div className="text-xs text-textMuted mb-1">
                <span className="font-mono">{parsedVol?.toFixed(0)}</span> / <span className="font-mono">{parsedVma?.toFixed(0)}</span>
              </div>
              <div className="bg-surfaceLight rounded h-2 overflow-hidden">
                <div className={`h-full ${parsedRatio > 1 ? 'bg-success' : 'bg-textMuted'}`} style={{ width: `${Math.min(100, parsedRatio * 50)}%` }} />
              </div>
              <div className="text-[10px] text-textMuted mt-1">
                {parsedRatio > 1 ? 'Above VMA — entry confirms' : 'Below VMA — waiting'}
              </div>
            </>
          ) : (
            <div className="text-sm text-textMuted text-center py-3">No volume data</div>
          )}
        </div>

        {/* Execution Plan */}
        <div className={`p-3 rounded-lg border lg:col-span-2 ${isEntry ? 'bg-primary/5 border-primary/40' : 'bg-background border-surfaceLight'}`}>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-textMuted uppercase font-semibold">
              {isEntry ? 'Execution Plan (Ready)' : 'Suggested Levels (No active entry)'}
            </span>
            {isEntry && <span className="text-[10px] bg-primary/30 text-primary font-bold px-2 py-0.5 rounded">AUTO-TRADE ARMED</span>}
          </div>
          {(data.entry && data.sl && data.tp) ? (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="bg-background p-2 rounded text-center">
                  <div className="text-[10px] text-textMuted uppercase">Entry</div>
                  <div className="font-mono font-bold text-primary text-sm">{fmt(data.entry, 5)}</div>
                </div>
                <div className="bg-background p-2 rounded text-center">
                  <div className="text-[10px] text-danger uppercase">Stop Loss</div>
                  <div className="font-mono font-bold text-danger text-sm">{fmt(data.sl, 5)}</div>
                </div>
                <div className="bg-background p-2 rounded text-center">
                  <div className="text-[10px] text-success uppercase">Take Profit</div>
                  <div className="font-mono font-bold text-success text-sm">{fmt(data.tp, 5)}</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center"><div className="text-textMuted">R/R</div><div className="font-bold">1 : {rrRatio.toFixed(2)}</div></div>
                <div className="text-center"><div className="text-textMuted">Lot</div><div className="font-bold">{data.lot_size ?? '—'}</div></div>
                <div className="text-center"><div className="text-textMuted">Risk%</div><div className="font-bold">{data.risk_percent_used ?? 1.0}%</div></div>
              </div>
              {data.entry_atr && (
                <div className="text-[10px] text-textMuted text-center mt-2 pt-2 border-t border-surfaceLight">
                  SL = entry ± 0.25×ATR ({(data.entry_atr * 0.25).toFixed(5)}) · TP = entry ± 4×ATR ({(data.entry_atr * 4).toFixed(5)})
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-textMuted text-center py-4">Waiting for Triple Screen alignment + RSI 40-55 + volume confirm</div>
          )}
        </div>

        {/* Reasoning */}
        <div className="bg-background p-3 rounded-lg border border-surfaceLight lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-textMuted uppercase font-semibold">Reasoning</span>
            <span className="text-[10px] text-textMuted font-mono">ATR(14) = {fmt(data.atr, 4)}</span>
          </div>
          <div className="mb-3">
            <span className="text-[10px] text-primary font-semibold uppercase block mb-1">Technical</span>
            <p className="text-xs text-text whitespace-pre-wrap leading-relaxed">
              {data.reason_technical || data.action || 'No technical reason.'}
            </p>
          </div>
          {data.reason_economic && data.reason_economic !== 'No specific macro data.' && (
            <div className="pt-2 border-t border-surfaceLight">
              <span className="text-[10px] text-primary font-semibold uppercase block mb-1">Macro / Economic</span>
              <p className="text-xs text-text whitespace-pre-wrap leading-relaxed">{data.reason_economic}</p>
              {data.macro_trade_idea && <p className="text-[10px] text-textMuted italic mt-1">{data.macro_trade_idea}</p>}
            </div>
          )}
        </div>
      </div>
    );
  };

  // === Render ===
  return (
    <div className={`flex flex-col gap-3 ${isFullScreen ? 'fixed inset-0 z-50 bg-background p-4' : 'h-full'}`}>
      {/* Top header */}
      <div className="flex items-center justify-between flex-wrap gap-3 bg-surface border border-surfaceLight rounded-lg p-3">
        <div className="flex items-center gap-3">
          <LineChart className="text-primary" size={22} />
          <h2 className="text-lg font-bold">Quant & Technical Desk</h2>
          <span className="text-xs font-bold bg-primary/20 text-primary px-2 py-1 rounded">
            {totalCount} Assets
          </span>
          {!isFullyLoaded && (
            <div className="flex items-center gap-2 text-xs text-textMuted">
              <Loader2 className="animate-spin text-primary" size={14} />
              <span>{loadedCount}/{totalCount} ({loadingProgress}%)</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Timeframe selector */}
          <div className="flex items-center gap-0.5 bg-background border border-surfaceLight rounded p-0.5">
            {TIMEFRAMES.map(tf => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf.id)}
                className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${
                  timeframe === tf.id ? 'bg-primary text-background' : 'text-textMuted hover:bg-surfaceLight'
                }`}
                title={`Switch chart to ${tf.label}`}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsFullScreen(!isFullScreen)}
            className="bg-surfaceLight hover:bg-primary/20 text-text p-2 rounded transition-colors flex items-center gap-2"
            title="Toggle Full Screen"
          >
            {isFullScreen ? <><Minimize2 size={14} /> Exit</> : <><Maximize2 size={14} /> Fullscreen</>}
          </button>
        </div>
      </div>

      {/* Main 2-column layout: chart left + watchlist right */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3 min-h-0">
        {/* LEFT: Chart + details */}
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
          {/* Symbol header above chart */}
          <div className="bg-surface border border-surfaceLight rounded-lg p-3 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <span className="text-xl font-bold">{selectedSymbol || '—'}</span>
              {price && (
                <>
                  <span className="text-sm font-mono text-textMuted">
                    bid <span className="text-success">{fmt(price.bid, 5)}</span>
                    {' / '}ask <span className="text-danger">{fmt(price.ask, 5)}</span>
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${price.is_open !== false ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'}`}>
                    {price.is_open !== false ? 'OPEN' : 'CLOSED'}
                  </span>
                </>
              )}
              {data?.signal && (
                <span className={`text-xs font-bold px-2 py-1 rounded border ${getSignalColor(data.signal)}`}>
                  {formatSignal(data.signal)}
                </span>
              )}
            </div>
            {data?.regime && (
              <span className="text-xs text-textMuted font-mono flex items-center gap-1">
                {renderTrendIcon(data.regime)} {data.regime}
              </span>
            )}
          </div>

          {/* Chart */}
          <div className="bg-surface border border-surfaceLight rounded-lg overflow-hidden flex-1 min-h-[420px]">
            {selectedSymbol ? (
              <ChartWidget
                key={`${selectedSymbol}-${timeframe}`}  // force remount on change
                symbol={selectedSymbol}
                timeframe={timeframe}
                entry={data?.entry}
                sl={data?.sl}
                tp={data?.tp}
                signal={data?.signal}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-textMuted">
                Select a symbol from the watchlist
              </div>
            )}
          </div>

          {/* Detail cards below chart */}
          <div className="bg-surface border border-surfaceLight rounded-lg p-3 overflow-y-auto custom-scrollbar max-h-[40vh]">
            {renderDetails()}
          </div>
        </div>

        {/* RIGHT: Watchlist sidebar (TradingView-style) */}
        <div className="bg-surface border border-surfaceLight rounded-lg flex flex-col min-h-0 overflow-hidden">
          {/* Sticky filter + search */}
          <div className="border-b border-surfaceLight p-2 flex flex-col gap-2 sticky top-0 bg-surface z-10">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-textMuted" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="w-full bg-background border border-surfaceLight text-text text-xs rounded pl-6 pr-2 py-1.5 outline-none focus:border-primary"
              />
            </div>
            <select
              className="bg-background border border-surfaceLight text-text text-xs rounded px-2 py-1.5 outline-none"
              value={assetFilter}
              onChange={e => setAssetFilter(e.target.value)}
            >
              <option value="ALL">All ({totalCount})</option>
              <option value="SIGNAL">Pending Signals</option>
              <option value="ACTIVE">Active Positions</option>
              <option value="WAITING">Waiting</option>
            </select>
            <div className="text-[10px] text-textMuted uppercase font-semibold pl-1">
              Watchlist ({filteredAssets.length})
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {filteredAssets.length === 0 ? (
              <div className="p-6 text-center text-textMuted text-sm">No symbols match.</div>
            ) : (
              filteredAssets.map(sym => {
                const d = technical[sym];
                const p = prices[sym];
                const isSelected = sym === selectedSymbol;
                const isLoaded = !!d;
                const biasStr = (d?.regime || '').split(' ')[0] || '—';
                const isBull = biasStr === 'Bullish';
                const isBear = biasStr === 'Bearish';
                const sparkColor = isBull ? '#4ade80' : isBear ? '#ef4444' : '#eab308';
                const hasOrder = orders.some(o => o.symbol === sym);

                return (
                  <button
                    key={sym}
                    onClick={() => setSelectedSymbol(sym)}
                    className={`w-full text-left border-b border-surfaceLight/40 px-2.5 py-2 transition-colors ${
                      isSelected ? 'bg-primary/10 border-l-2 border-l-primary' : 'hover:bg-surfaceLight/30 border-l-2 border-l-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-bold text-sm truncate">{sym}</span>
                        {hasOrder && <span className="bg-primary text-background text-[8px] font-bold px-1 rounded">POS</span>}
                      </div>
                      {!isLoaded ? (
                        <Loader2 className="animate-spin text-textMuted" size={10} />
                      ) : (
                        renderTrendIcon(d.regime, 12)
                      )}
                    </div>
                    {isLoaded ? (
                      <>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-mono text-[10px] text-textMuted">{p?.bid ? fmt(p.bid, 5) : '—'}</span>
                          <Sparkline data={d.sparkline || []} color={sparkColor} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${getSignalColor(d.signal)}`}>
                            {formatSignal(d.signal)}
                          </span>
                          <span className="text-[10px] font-mono">
                            RSI <span className={d.rsi < 30 ? 'text-success' : d.rsi > 70 ? 'text-danger' : d.rsi >= 40 && d.rsi <= 55 ? 'text-warning' : 'text-textMuted'}>
                              {fmt(d.rsi, 1)}
                            </span>
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="text-[10px] text-textMuted italic">Loading...</div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuantScreener;
