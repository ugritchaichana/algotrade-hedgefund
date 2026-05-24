import React from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { Crosshair, Activity, TrendingUp, TrendingDown } from 'lucide-react';

const ExecutionDesk = () => {
  const technical = useMarketStore(state => state.technical);
  const orders = useMarketStore(state => state.orders);
  const accountStatus = useMarketStore(state => state.accountStatus);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">Execution Desk</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Signal Panel */}
        <div className="bg-surface rounded-lg p-6 border border-surfaceLight shadow-sm flex flex-col min-h-[400px]">
          <div className="flex items-center gap-2 mb-4 border-b border-surfaceLight pb-2">
            <Crosshair className="text-success" size={20} />
            <h3 className="text-lg font-semibold">Signal Panel (Dynamic)</h3>
          </div>
          <div className="flex flex-col gap-3 flex-1 overflow-y-auto custom-scrollbar">
            {Object.keys(technical || {}).length === 0 ? (
              <div className="text-textMuted text-center py-4">Waiting for Analysis...</div>
            ) : (
              Object.keys(technical || {}).map(sym => {
                const data = technical[sym];
                if (!data || !data.signal || data.signal === "WAITING" || data.signal === "Out of Hours") return null;
                
                const isEntry = data.signal.startsWith("ENTRY");
                
                return (
                  <div key={sym} className={`p-4 rounded border ${isEntry ? 'bg-primary/10 border-primary' : 'bg-surface border-surfaceLight'}`}>
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-lg">{sym}</span>
                      <span className={`text-xs font-bold px-2 py-1 rounded ${isEntry ? 'bg-primary text-background' : 'bg-surfaceLight text-textMuted'}`}>
                        {data.signal}
                      </span>
                    </div>
                    <div className="text-sm text-textMuted mb-2">{data.action}</div>
                    
                    {data.entry && (
                      <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-surfaceLight/50 text-xs text-center font-mono">
                        <div>
                          <div className="text-textMuted mb-1">ENTRY</div>
                          <div className="font-bold">{data.entry}</div>
                        </div>
                        <div>
                          <div className="text-danger mb-1">SL</div>
                          <div className="font-bold">{data.sl}</div>
                        </div>
                        <div>
                          <div className="text-success mb-1">TP</div>
                          <div className="font-bold">{data.tp}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {/* Active Orders */}
          <div className="bg-surface rounded-lg p-6 border border-surfaceLight shadow-sm flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-4 border-b border-surfaceLight pb-2">
              <Activity className="text-primary" size={20} />
              <h3 className="text-lg font-semibold">Active Orders (MT5)</h3>
              <span className="ml-auto bg-primary/20 text-primary text-xs font-bold px-2 py-1 rounded">
                {orders.length}
              </span>
            </div>
            <div className="flex flex-col gap-3 overflow-y-auto custom-scrollbar flex-1 max-h-[300px]">
              {orders.length === 0 ? (
                <div className="text-textMuted text-center py-4">No active orders</div>
              ) : (
                orders.map(o => (
                  <div key={o.ticket} className="bg-background border border-surfaceLight p-3 rounded text-sm flex flex-col gap-2">
                    <div className="flex justify-between items-center">
                      <span className="font-bold">{o.symbol}</span>
                      <span className={`font-mono font-bold ${o.profit >= 0 ? 'text-success' : 'text-danger'}`}>
                        {o.profit >= 0 ? '+' : ''}${o.profit.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs text-textMuted">
                      <span className="uppercase">{o.type} {o.volume} Lots</span>
                      <span>Open: {o.price_open}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Recent Closed Deals */}
          <div className="bg-surface rounded-lg p-6 border border-surfaceLight shadow-sm flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-4 border-b border-surfaceLight pb-2">
              <Activity className="text-textMuted" size={20} />
              <h3 className="text-lg font-semibold text-textMuted">Recent Closed Deals</h3>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto custom-scrollbar flex-1 max-h-[300px]">
              {accountStatus?.recent_history && accountStatus.recent_history.length > 0 ? (
                accountStatus.recent_history.slice().reverse().slice(0, 10).map(deal => (
                  <div key={deal.ticket} className="flex justify-between items-center text-xs bg-background p-3 rounded border border-surfaceLight">
                    <div>
                      <span className="font-bold text-sm">{deal.symbol}</span>
                      <span className="text-textMuted ml-3">{deal.type} {deal.volume}</span>
                    </div>
                    <span className={`font-mono font-bold ${deal.profit >= 0 ? 'text-success' : 'text-danger'}`}>
                      {deal.profit >= 0 ? '+' : ''}${deal.profit.toFixed(2)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-textMuted text-center py-4">No recent history</div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default ExecutionDesk;
