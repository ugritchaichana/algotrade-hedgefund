import React, { useState } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { LineChart, Maximize2, Minimize2, TrendingUp, TrendingDown, Minus, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import ChartWidget from '../components/ChartWidget';
import { useAutoAnimate } from '@formkit/auto-animate/react';

const Sparkline = ({ data, color }: { data: number[], color: string }) => {
  if (!data || data.length < 2) return <div className="w-16 h-6 flex items-center justify-center"><Minus size={12} className="text-textMuted"/></div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((d, i) => `${(i / (data.length - 1)) * 64},${24 - ((d - min) / range) * 24}`).join(' ');
  return (
    <svg width="64" height="24" viewBox="0 0 64 24" className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

const QuantScreener = () => {
  const [parent] = useAutoAnimate();
  const assets = useMarketStore(state => state.assets);
  const technical = useMarketStore(state => state.technical);
  const prices = useMarketStore(state => state.prices);
  const orders = useMarketStore(state => state.orders);
  const loadingProgress = useMarketStore(state => state.loadingProgress);
  const isFullyLoaded = useMarketStore(state => state.isFullyLoaded);
  
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const renderTrendIcon = (regime: string) => {
    if (!regime) return <Loader2 className="text-primary animate-spin" size={16} />;
    if (regime === 'Out of Hours') return <Minus className="text-textMuted" size={16} />;
    if (regime.includes('Bullish') || regime.includes('Uptrend')) return <TrendingUp className="text-success" size={16} />;
    if (regime.includes('Bearish') || regime.includes('Downtrend')) return <TrendingDown className="text-danger" size={16} />;
    return <Minus className="text-warning" size={16} />;
  };

  const getBiasColor = (regime: string) => {
    if (!regime) return 'text-textMuted';
    if (regime.includes('Bullish')) return 'text-success';
    if (regime.includes('Bearish')) return 'text-danger';
    return 'text-warning';
  };

  const getSignalColor = (signal: string) => {
    if (!signal) return 'bg-surface text-textMuted';
    if (signal.includes('BUY')) return 'bg-success/20 text-success border border-success/50';
    if (signal.includes('SELL')) return 'bg-danger/20 text-danger border border-danger/50';
    if (signal.includes('ALERT')) return 'bg-warning/20 text-warning border border-warning/50';
    return 'bg-surfaceLight text-textMuted border border-surfaceLight';
  };

  const fmt = (val: any) => typeof val === 'number' ? val.toFixed(2) : val;

  const formatSignal = (signal: string) => {
    if (!signal || signal === 'WAITING') return 'Waiting';
    return signal
      .replace('ENTRY_', '')
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const getSortPriority = (sym: string) => {
    const data = technical[sym];
    const hasActiveOrder = orders.some(o => o.symbol === sym);
    if (!data) return 99; // Not loaded yet
    
    if (data.signal?.includes('ENTRY')) return 1;
    if (hasActiveOrder) return 2;
    if (data.signal?.includes('ALERT')) return 3;
    return 4;
  };

  const filteredAssets = assets.filter(sym => {
    if (assetFilter === 'ALL') return true;
    
    const hasActiveOrder = orders.some(o => o.symbol === sym);
    if (assetFilter === 'ACTIVE') return hasActiveOrder;
    
    const data = technical[sym];
    const signal = data?.signal;
    if (assetFilter === 'SIGNAL') return signal && signal !== 'WAITING';
    if (assetFilter === 'WAITING') return (!signal || signal === 'WAITING') && !hasActiveOrder;
    
    return true;
  }).sort((a, b) => {
    // 1. Confidence Level (descending)
    const confA = technical[a]?.confidence || 0;
    const confB = technical[b]?.confidence || 0;
    if (confA !== confB) return confB - confA;

    // 2. Signal Priority
    const pA = getSortPriority(a);
    const pB = getSortPriority(b);
    if (pA !== pB) return pA - pB;
    
    // 3. Alphabetical
    return a.localeCompare(b);
  });

  const loadedCount = assets.filter(sym => technical[sym]).length;
  const totalCount = assets.length;

  const toggleExpand = (sym: string) => {
    if (expandedSymbol === sym) {
      setExpandedSymbol(null);
    } else {
      setExpandedSymbol(sym);
    }
  };

  const renderExpandedDetails = (sym: string, data: any) => {
    const isEntry = data.signal?.startsWith('ENTRY');
    
    let rrRatio = 0;
    let potentialRisk = "1.00%"; // Base risk per quant_desk.py
    let potentialReward = "0.00%";
    
    if (isEntry && data.entry && data.sl && data.tp) {
      const risk = Math.abs(data.entry - data.sl);
      const reward = Math.abs(data.tp - data.entry);
      if (risk > 0) {
        rrRatio = reward / risk;
        potentialReward = (rrRatio * 1.0).toFixed(2) + "%"; // Approximated from 1% risk
      }
    }

    return (
      <div className="bg-surface p-4 border-b border-surfaceLight">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3">
            <h3 className="text-lg font-bold mb-4">{sym} Live Chart (1H)</h3>
            <div className="border border-surfaceLight rounded overflow-hidden">
              <ChartWidget 
                symbol={sym} 
                entry={data.entry} 
                sl={data.sl} 
                tp={data.tp} 
                signal={data.signal} 
              />
            </div>
          </div>
          
          <div className="flex flex-col gap-4">
            <h3 className="text-lg font-bold">Trade Details</h3>
            
            <div className="bg-background p-3 rounded border border-surfaceLight">
              <div className="text-xs text-textMuted mb-1 uppercase">Technical Status</div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-sm">RSI (14)</span>
                <span className={`text-sm font-bold ${data.rsi < 30 ? 'text-success' : data.rsi > 70 ? 'text-danger' : 'text-primary'}`}>{fmt(data.rsi)}</span>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm">ATR (14)</span>
                <span className="text-sm font-bold">{fmt(data.atr)}</span>
              </div>
            </div>

            <div className="bg-background p-3 rounded border border-surfaceLight">
              <div className="text-xs text-textMuted mb-2 uppercase">Reasoning</div>
              <div className="mb-3">
                <span className="text-xs text-primary font-semibold block mb-1">Technical</span>
                <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">{data.reason_technical || data.action || "No technical reason."}</p>
              </div>
              <div>
                <span className="text-xs text-primary font-semibold block mb-1">Macro / Economic</span>
                <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">{data.reason_economic || "No macro impact."}</p>
              </div>
            </div>

            {isEntry ? (
              <div className="bg-background p-3 rounded border border-surfaceLight">
                <div className="text-xs text-textMuted mb-2 uppercase">Execution Plan</div>
                
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm">Entry</span>
                  <span className="text-sm font-mono text-primary">{fmt(data.entry)}</span>
                </div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm">Stop Loss</span>
                  <span className="text-sm font-mono text-danger">{fmt(data.sl)}</span>
                </div>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm">Take Profit</span>
                  <span className="text-sm font-mono text-success">{fmt(data.tp)}</span>
                </div>
                
                <div className="border-t border-surfaceLight pt-2 mt-2">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-sm">Risk / Reward</span>
                    <span className="text-sm font-bold">1 : {rrRatio.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-sm text-danger">Risk (Est.)</span>
                    <span className="text-sm font-bold text-danger">-{potentialRisk}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-success">Reward (Est.)</span>
                    <span className="text-sm font-bold text-success">+{potentialReward}</span>
                  </div>
                  <div className="flex justify-between items-center mt-2 pt-2 border-t border-surfaceLight">
                    <span className="text-sm text-textMuted">Lot Size</span>
                    <span className="text-sm font-bold">{data.lot_size} Lots</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-background p-3 rounded border border-surfaceLight text-center text-textMuted text-sm flex-1 flex items-center justify-center">
                No active execution plan. Waiting for setup.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`flex flex-col gap-4 ${isFullScreen ? 'fixed inset-0 z-50 bg-background p-6' : 'h-full'}`}>
      <div className={`bg-surface rounded-lg p-5 border border-surfaceLight flex-1 flex flex-col ${isFullScreen ? 'shadow-2xl' : ''} overflow-hidden`}>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4 border-b border-surfaceLight pb-4 sticky top-0 bg-surface z-10">
          <div className="flex items-center gap-2">
            <LineChart className="text-primary" size={24} />
            <h2 className="text-xl font-bold">Quant & Technical Desk</h2>
            <span className="ml-2 text-xs font-bold bg-primary/20 text-primary px-2 py-1 rounded">
              {totalCount} Assets
            </span>
          </div>
          
          <div className="sm:ml-auto flex flex-wrap items-center gap-3">
            {!isFullyLoaded && (
              <div className="flex items-center gap-2 bg-background border border-surfaceLight px-3 py-1 rounded">
                <Loader2 className="animate-spin text-primary" size={16} />
                <span className="text-sm text-textMuted">Loading Data: {loadedCount}/{totalCount} ({loadingProgress}%)</span>
              </div>
            )}

            <select 
              className="bg-background border border-surfaceLight text-text text-sm rounded px-3 py-1.5 outline-none"
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value)}
            >
              <option value="ALL">All Assets ({totalCount})</option>
              <option value="ACTIVE">Active Positions</option>
              <option value="SIGNAL">Pending Signals</option>
              <option value="WAITING">Waiting / Resting</option>
            </select>
            
            <button 
              onClick={() => setIsFullScreen(!isFullScreen)}
              className="bg-surfaceLight hover:bg-primary/20 text-text p-2 rounded transition-colors flex items-center gap-2"
              title="Toggle Full Screen"
            >
              {isFullScreen ? <><Minimize2 size={16} /> Exit Fullscreen</> : <><Maximize2 size={16} /> Fullscreen</>}
            </button>
          </div>
        </div>

        {!isFullyLoaded && (
          <div className="w-full bg-surfaceLight h-2 mb-4 rounded-full overflow-hidden border border-surfaceLight/50">
            <div 
              className="h-full bg-primary transition-all duration-300 ease-out relative" 
              style={{ width: `${loadingProgress}%` }}
            >
              <div className="absolute inset-0 bg-white/20" style={{ backgroundImage: 'linear-gradient(45deg, rgba(255,255,255,.15) 25%, transparent 25%, transparent 50%, rgba(255,255,255,.15) 50%, rgba(255,255,255,.15) 75%, transparent 75%, transparent)', backgroundSize: '1rem 1rem', animation: 'progress-stripes 1s linear infinite' }}></div>
            </div>
          </div>
        )}

        <div className="overflow-x-auto flex-1 custom-scrollbar">
          <table className="w-full text-left border-collapse table-fixed min-w-[1000px]">
            <thead>
              <tr className="border-b border-surfaceLight text-sm text-textMuted uppercase tracking-wider bg-background sticky top-0 z-10">
                <th className="py-3 px-4 font-semibold w-12"></th>
                <th className="py-3 px-4 font-semibold w-[14%]">Symbol</th>
                <th className="py-3 px-4 font-semibold text-center w-[10%]">Status</th>
                <th className="py-3 px-4 font-semibold text-center w-[12%]">Trend (H1)</th>
                <th className="py-3 px-4 font-semibold w-[16%]">Bias (D1)</th>
                <th className="py-3 px-4 font-semibold text-center w-[12%]">Action</th>
                <th className="py-3 px-4 font-semibold text-center w-[12%]">RSI</th>
                <th className="py-3 px-4 font-semibold text-center w-[12%]">ATR</th>
                <th className="py-3 px-4 font-semibold text-center w-[12%]">Confidence</th>
              </tr>
            </thead>
            <tbody ref={parent}>
              {filteredAssets.map(sym => {
                const data = technical[sym];
                const isLoaded = !!data;
                const isExpanded = expandedSymbol === sym;
                
                if (!isLoaded) {
                  return (
                    <tr key={sym} className="border-b border-surfaceLight bg-surface/50">
                      <td className="py-3 px-4 text-center text-textMuted"><Minus size={16} /></td>
                      <td className="py-3 px-4 font-bold flex items-center gap-2">
                        {sym}
                      </td>
                      <td className="py-3 px-4 text-center"><Minus size={16} className="text-textMuted mx-auto" /></td>
                      <td className="py-3 px-4 text-center"><Minus size={16} className="text-textMuted mx-auto" /></td>
                      <td colSpan={6} className="py-3 px-4 text-textMuted italic flex items-center gap-2">
                        <Loader2 className="animate-spin" size={14} /> Analyzing Quant Data...
                      </td>
                    </tr>
                  );
                }

                const priceData = prices[sym];
                const isOpen = priceData?.is_open;
                const biasStr = (data.regime || "").split(' ')[0] || "Unknown";
                const isBull = biasStr === 'Bullish';
                const isBear = biasStr === 'Bearish';
                
                return (
                  <React.Fragment key={sym}>
                    <tr 
                      className={`border-b border-surfaceLight hover:bg-background/80 transition-colors cursor-pointer ${isExpanded ? 'bg-background' : 'bg-surface'}`}
                      onClick={() => toggleExpand(sym)}
                    >
                      <td className="py-4 px-4 text-center">
                        {isExpanded ? <ChevronUp size={18} className="text-primary" /> : <ChevronDown size={18} className="text-textMuted" />}
                      </td>
                      <td className="py-4 px-4 font-bold text-lg">
                        <div className="flex items-center gap-2">
                          {sym}
                        </div>
                        <div className="text-xs text-textMuted font-mono font-normal mt-1">{prices[sym]?.bid ? fmt(prices[sym].bid) : '---.---'}</div>
                      </td>
                      <td className="py-4 px-4 text-center">
                        {isOpen !== undefined ? (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-bold uppercase ${isOpen ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'}`}>
                            {isOpen ? 'Open' : 'Closed'}
                          </span>
                        ) : (
                          <span className="text-textMuted">-</span>
                        )}
                      </td>
                      <td className="py-4 px-4 align-middle">
                        <div className="flex justify-center items-center w-full">
                          <Sparkline data={data.sparkline || []} color={isBull ? '#4ade80' : isBear ? '#ef4444' : '#eab308'} />
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-2">
                          {renderTrendIcon(data.regime)}
                          <span className={`font-semibold ${getBiasColor(data.regime)}`}>{biasStr}</span>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <span className={`text-xs font-bold px-3 py-1 rounded-full ${getSignalColor(data.signal)}`}>
                          {formatSignal(data.signal)}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <span className={`font-mono font-semibold ${data.rsi < 30 ? 'text-success' : data.rsi > 70 ? 'text-danger' : 'text-primary'}`}>
                          {fmt(data.rsi) || '-'}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <span className="font-mono text-textMuted">{fmt(data.atr) || '-'}</span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-16 bg-surfaceLight rounded-full h-1.5 overflow-hidden">
                            <div 
                              className={`h-full ${data.confidence > 75 ? 'bg-success' : data.confidence > 60 ? 'bg-primary' : 'bg-warning'}`} 
                              style={{ width: `${data.confidence || 0}%` }}
                            ></div>
                          </div>
                          <span className="text-xs font-bold w-8">{data.confidence || 0}%</span>
                        </div>
                      </td>
                    </tr>
                    
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} className="p-0 border-b border-surfaceLight bg-surface">
                          <div className="animate-in slide-in-from-top-2 duration-200">
                            {renderExpandedDetails(sym, data)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              
              {filteredAssets.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-20 text-center text-textMuted">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <LineChart size={48} className="opacity-20" />
                      <p>No assets match the current filter.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default QuantScreener;
