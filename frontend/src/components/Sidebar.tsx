import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, LineChart, ShieldAlert, Settings as SettingsIcon, Database, Play, Zap, TrendingUp, BookOpen, Activity } from 'lucide-react';
import { useMarketStore } from '../store/useMarketStore';

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 px-3 py-2.5 rounded transition-colors ${
    isActive
      ? 'bg-primary/10 text-primary font-semibold'
      : 'text-textMuted hover:bg-surfaceLight hover:text-text'
  }`;

const Sidebar = () => {
  const wsConnected = useMarketStore(state => state.wsConnected);
  const autoTradeEnabled = useMarketStore(state => state.autoTradeEnabled);

  return (
    <div className="w-64 bg-surface border-r border-surfaceLight min-h-screen p-4 flex flex-col gap-6 shadow-xl">
      <div className="flex items-center gap-3 px-2">
        <div className="bg-primary/20 p-2 rounded">
          <ShieldAlert className="text-primary" size={24} />
        </div>
        <h1 className="text-xl font-bold tracking-tight text-text">
          AlgoTrade
          <br />
          <span className="text-sm text-textMuted font-normal">Hedge Fund System</span>
        </h1>
      </div>

      <nav className="flex flex-col gap-1 mt-2">
        <NavLink to="/" end className={navItemClass}>
          <LayoutDashboard size={18} />
          <span>Dashboard</span>
        </NavLink>
        <NavLink to="/quant" className={navItemClass}>
          <LineChart size={18} />
          <span>Quant Screener</span>
        </NavLink>
        <NavLink to="/execution" className={navItemClass}>
          <ShieldAlert size={18} />
          <span>Execution Desk</span>
        </NavLink>

        <div className="text-xs text-textMuted uppercase mt-4 mb-1 px-3 font-semibold">Performance</div>
        <NavLink to="/equity" className={navItemClass}>
          <TrendingUp size={18} />
          <span>Equity Curve</span>
        </NavLink>
        <NavLink to="/journal" className={navItemClass}>
          <BookOpen size={18} />
          <span>Trade Journal</span>
        </NavLink>

        <div className="text-xs text-textMuted uppercase mt-4 mb-1 px-3 font-semibold">Backtest</div>
        <NavLink to="/backtest/data" className={navItemClass}>
          <Database size={18} />
          <span>Data Status</span>
        </NavLink>
        <NavLink to="/backtest/run" className={navItemClass}>
          <Play size={18} />
          <span>Run Backtest</span>
        </NavLink>
        <NavLink to="/backtest/optimize" className={navItemClass}>
          <Zap size={18} />
          <span>Optimize</span>
        </NavLink>

        <div className="text-xs text-textMuted uppercase mt-4 mb-1 px-3 font-semibold">System</div>
        <NavLink to="/system/health" className={navItemClass}>
          <Activity size={18} />
          <span>System Health</span>
        </NavLink>
        <NavLink to="/settings" className={navItemClass}>
          <SettingsIcon size={18} />
          <span>Settings</span>
        </NavLink>
      </nav>

      <div className="mt-auto pt-4 border-t border-surfaceLight space-y-2">
        <div className="flex items-center gap-2 px-2">
          <span className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-success animate-pulse' : 'bg-danger'}`}></span>
          <span className="text-xs text-textMuted uppercase font-semibold">{wsConnected ? 'Backend Live' : 'Backend Down'}</span>
        </div>
        <div className="flex items-center gap-2 px-2">
          <span className={`w-2.5 h-2.5 rounded-full ${autoTradeEnabled ? 'bg-success' : 'bg-warning animate-pulse'}`}></span>
          <span className="text-xs text-textMuted uppercase font-semibold">{autoTradeEnabled ? 'Auto-Trade ON' : 'Auto-Trade OFF'}</span>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
