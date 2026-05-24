import React from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { Globe, Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react';

const Dashboard = () => {
  const macro = useMarketStore(state => state.macro);
  const risk = useMarketStore(state => state.risk);
  const accountStatus = useMarketStore(state => state.accountStatus);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">Hedge Fund Dashboard</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Account Status Card */}
        <div className="bg-surface rounded-lg p-6 border border-surfaceLight shadow-sm">
          <div className="flex items-center gap-2 mb-4 border-b border-surfaceLight pb-2">
            <Activity className="text-primary" size={20} />
            <h3 className="text-lg font-semibold">Account Status</h3>
          </div>
          {accountStatus?.account ? (
            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <div>
                  <div className="text-textMuted text-sm mb-1">Balance</div>
                  <div className="text-xl font-bold">${accountStatus.account.balance.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-textMuted text-sm mb-1">Equity</div>
                  <div className="text-xl font-bold">${accountStatus.account.equity.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-textMuted text-sm mb-1">Free Margin</div>
                  <div className="text-xl font-bold text-success">${accountStatus.account.margin_free.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-textMuted text-sm mb-1">Margin Level</div>
                  <div className="text-xl font-bold">{accountStatus.account.margin_level.toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-textMuted text-sm mb-1">Current Profit</div>
                  <div className={`text-xl font-bold ${accountStatus.account.profit >= 0 ? 'text-success' : 'text-danger'}`}>
                    ${accountStatus.account.profit.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* Scrollable History */}
              {accountStatus.recent_history && accountStatus.recent_history.length > 0 && (
                <div className="mt-2 border-t border-surfaceLight pt-4">
                  <h4 className="text-sm font-semibold text-textMuted mb-2">Recent Trade History</h4>
                  <div className="max-h-40 overflow-y-auto custom-scrollbar pr-2">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-surface">
                        <tr className="text-textMuted border-b border-surfaceLight">
                          <th className="py-2 font-normal">Asset</th>
                          <th className="py-2 font-normal">Type</th>
                          <th className="py-2 font-normal">Volume</th>
                          <th className="py-2 font-normal text-right">Profit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {accountStatus.recent_history.map((trade: any, idx: number) => (
                          <tr key={idx} className="border-b border-surfaceLight hover:bg-surfaceLight/30 transition-colors">
                            <td className="py-2 font-medium">{trade.symbol}</td>
                            <td className={`py-2 font-bold ${trade.type === 'BUY' ? 'text-success' : 'text-danger'}`}>{trade.type}</td>
                            <td className="py-2">{trade.volume}</td>
                            <td className={`py-2 text-right font-bold ${trade.profit >= 0 ? 'text-success' : 'text-danger'}`}>
                              ${trade.profit.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : <div className="text-textMuted text-center py-4">Loading Account Data...</div>}
        </div>

        {/* Risk Flow Card */}
        <div className="bg-surface rounded-lg p-6 border border-surfaceLight shadow-sm">
          <div className="flex items-center gap-2 mb-4 border-b border-surfaceLight pb-2">
            <Globe className="text-warning" size={20} />
            <h3 className="text-lg font-semibold">Intermarket Flow (4-Pillars)</h3>
          </div>
          <div className="text-center py-4">
            <div className={`text-xl font-bold mb-6 ${
              risk?.sentiment?.includes('Risk-On') || risk?.sentiment?.includes('Growth') ? 'text-success' : 
              risk?.sentiment?.includes('Risk-Off') || risk?.sentiment?.includes('Fear') || risk?.sentiment?.includes('Crunch') ? 'text-danger' : 
              'text-warning'
            }`}>
              {risk?.sentiment || 'Analyzing...'}
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
              <div className="flex flex-col items-center bg-background p-3 rounded-lg border border-surfaceLight">
                <span className="text-textMuted mb-1 text-xs uppercase font-bold">US30 (Equities)</span>
                <span className={`text-lg font-bold ${risk?.us30_daily_change > 0 ? 'text-success' : 'text-danger'}`}>
                  {risk?.us30_daily_change > 0 ? '+' : ''}{risk?.us30_daily_change}%
                </span>
              </div>
              <div className="flex flex-col items-center bg-background p-3 rounded-lg border border-surfaceLight">
                <span className="text-textMuted mb-1 text-xs uppercase font-bold">XAUUSD (Safe Haven)</span>
                <span className={`text-lg font-bold ${risk?.xau_daily_change > 0 ? 'text-success' : 'text-danger'}`}>
                  {risk?.xau_daily_change > 0 ? '+' : ''}{risk?.xau_daily_change}%
                </span>
              </div>
              <div className="flex flex-col items-center bg-background p-3 rounded-lg border border-surfaceLight">
                <span className="text-textMuted mb-1 text-xs uppercase font-bold">DXY (Liquidity)</span>
                <span className={`text-lg font-bold ${risk?.dxy_daily_change > 0 ? 'text-success' : 'text-danger'}`}>
                  {risk?.dxy_daily_change > 0 ? '+' : ''}{risk?.dxy_daily_change || '0.00'}%
                </span>
              </div>
              <div className="flex flex-col items-center bg-background p-3 rounded-lg border border-surfaceLight">
                <span className="text-textMuted mb-1 text-xs uppercase font-bold">USOIL (Energy)</span>
                <span className={`text-lg font-bold ${risk?.usoil_daily_change > 0 ? 'text-success' : 'text-danger'}`}>
                  {risk?.usoil_daily_change > 0 ? '+' : ''}{risk?.usoil_daily_change || '0.00'}%
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* AI Macro Briefing */}
      <div className="bg-surface rounded-lg p-6 border border-surfaceLight shadow-sm">
        <div className="flex items-center gap-2 mb-4 border-b border-surfaceLight pb-2">
          <Globe className="text-primary" size={20} />
          <h3 className="text-lg font-semibold">AI Morning Briefing</h3>
        </div>
        
        {macro?.ai_briefing ? (
          typeof macro.ai_briefing === 'object' ? (
            <div className="flex flex-col gap-6">
              
              {/* Top Summary Metrics */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-background border border-surfaceLight p-4 rounded-lg flex flex-col items-center text-center">
                  <span className="text-xs text-textMuted uppercase font-bold mb-1">Macro Bias</span>
                  <span className={`text-lg font-bold ${
                    macro.ai_briefing.bias?.includes('Risk-On') ? 'text-success' : 
                    macro.ai_briefing.bias?.includes('Risk-Off') ? 'text-danger' : 
                    'text-warning'
                  }`}>
                    {macro.ai_briefing.bias || 'Unknown'}
                  </span>
                </div>
                <div className="bg-background border border-surfaceLight p-4 rounded-lg flex flex-col items-center text-center">
                  <span className="text-xs text-textMuted uppercase font-bold mb-1">Sentiment Shift</span>
                  <span className="text-sm font-semibold">{macro.ai_briefing.sentiment_shift || 'No Change'}</span>
                </div>
                <div className="bg-background border border-surfaceLight p-4 rounded-lg flex flex-col items-center text-center">
                  <span className="text-xs text-textMuted uppercase font-bold mb-1">Confidence</span>
                  <span className={`text-lg font-bold ${
                    String(macro.ai_briefing.confidence_score).includes('High') ? 'text-success' : 
                    String(macro.ai_briefing.confidence_score).includes('Low') ? 'text-danger' : 
                    'text-warning'
                  }`}>
                    {macro.ai_briefing.confidence_score || 'Medium'}
                  </span>
                </div>
                <div className="bg-background border border-surfaceLight p-4 rounded-lg flex flex-col items-center text-center">
                  <span className="text-xs text-textMuted uppercase font-bold mb-1">Volatility Exp.</span>
                  <span className={`text-lg font-bold ${
                    String(macro.ai_briefing.volatility).includes('Extreme') ? 'text-danger animate-pulse' : 
                    String(macro.ai_briefing.volatility).includes('Moderate') ? 'text-warning' : 
                    'text-success'
                  }`}>
                    {macro.ai_briefing.volatility || 'Low'}
                  </span>
                </div>
              </div>

              {/* Summary Text */}
              <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg text-sm leading-relaxed text-text">
                <span className="font-bold text-primary mr-2">Summary:</span>
                {macro.ai_briefing.summary}
              </div>

              {/* Event Timeline */}
              {macro.ai_briefing.events_timeline && macro.ai_briefing.events_timeline.length > 0 && (
                <div>
                  <h4 className="text-sm font-bold text-textMuted uppercase mb-3 border-b border-surfaceLight pb-2">Key Events Today</h4>
                  <div className="flex flex-wrap gap-3">
                    {macro.ai_briefing.events_timeline.map((ev: any, idx: number) => (
                      <div key={idx} className="flex items-center gap-2 bg-background border border-surfaceLight px-3 py-1.5 rounded-full text-xs font-semibold">
                        <span className="text-primary">{ev.time}</span>
                        <span>|</span>
                        <span>{ev.event}</span>
                        <span className={`ml-1 px-1.5 rounded ${ev.impact?.includes('High') ? 'bg-danger/20 text-danger' : 'bg-warning/20 text-warning'}`}>
                          {ev.impact}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Impacts Data Table */}
              {macro.ai_briefing.impacts && Object.keys(macro.ai_briefing.impacts).length > 0 && (
                <div>
                  <h4 className="text-sm font-bold text-textMuted uppercase mb-3 border-b border-surfaceLight pb-2">Asset Impact Analysis</h4>
                  <div className="overflow-x-auto custom-scrollbar border border-surfaceLight rounded-lg">
                    <table className="w-full text-left text-sm border-collapse">
                      <thead>
                        <tr className="bg-background text-textMuted uppercase tracking-wider">
                          <th className="py-3 px-4 border-b border-surfaceLight font-semibold w-24">Asset</th>
                          <th className="py-3 px-4 border-b border-surfaceLight font-semibold w-32">Impact</th>
                          <th className="py-3 px-4 border-b border-surfaceLight font-semibold">Reasoning</th>
                          <th className="py-3 px-4 border-b border-surfaceLight font-semibold">Trade Idea</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(macro.ai_briefing.impacts).map(([asset, info]: [string, any]) => (
                          <tr key={asset} className="border-b border-surfaceLight hover:bg-background/50 transition-colors">
                            <td className="py-3 px-4 font-bold text-primary">{asset}</td>
                            <td className="py-3 px-4">
                              <span className={`px-2 py-1 rounded-md text-xs font-bold whitespace-nowrap ${
                                String(info?.badge).includes('Good') ? 'bg-success/20 text-success border border-success/30' :
                                String(info?.badge).includes('Bad') ? 'bg-danger/20 text-danger border border-danger/30' :
                                'bg-warning/20 text-warning border border-warning/30'
                              }`}>
                                {info?.badge || 'Neutral'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-textMuted leading-relaxed">{info?.reasoning || String(info)}</td>
                            <td className="py-3 px-4 text-text leading-relaxed font-medium">{info?.trade_idea || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-background rounded p-4 text-sm leading-relaxed border border-surfaceLight text-textMuted whitespace-pre-wrap">
              {macro.ai_briefing}
            </div>
          )
        ) : (
          <div className="text-textMuted text-sm">Waiting for AI analysis...</div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
