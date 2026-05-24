import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useMarketStore } from './store/useMarketStore';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import QuantScreener from './pages/QuantScreener';
import ExecutionDesk from './pages/ExecutionDesk';
import Settings from './pages/Settings';
import BacktestDataStatus from './pages/BacktestDataStatus';
import BacktestRun from './pages/BacktestRun';
import BacktestOptimize from './pages/BacktestOptimize';
import EquityCurve from './pages/EquityCurve';
import TradeJournal from './pages/TradeJournal';
import SystemHealth from './pages/SystemHealth';
import { ToastProvider } from './lib/toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { API_BASE } from './lib/api';
import { Power, AlertTriangle } from 'lucide-react';

function KillSwitchButton() {
  const autoTradeEnabled = useMarketStore(state => state.autoTradeEnabled);
  const setAutoTradeEnabled = useMarketStore(state => state.setAutoTradeEnabled);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const stop = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/kill-switch`, { method: 'POST' });
      if (r.ok) setAutoTradeEnabled(false);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/kill-switch/restore`, { method: 'POST' });
      if (r.ok) setAutoTradeEnabled(true);
    } finally {
      setBusy(false);
    }
  };

  if (!autoTradeEnabled) {
    return (
      <button
        onClick={resume}
        disabled={busy}
        className="flex items-center gap-2 px-4 py-2 bg-warning/20 border border-warning/50 text-warning rounded-lg font-semibold hover:bg-warning/30 transition-colors disabled:opacity-50"
        title="Auto-trade is currently OFF. Click to resume."
      >
        <Power size={16} />
        {busy ? 'Resuming...' : 'AUTO-TRADE OFF — Resume?'}
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-warning">Confirm stop?</span>
        <button
          onClick={stop}
          disabled={busy}
          className="px-3 py-2 bg-danger text-white rounded font-bold text-sm hover:bg-red-700 transition-colors disabled:opacity-50"
        >
          {busy ? 'Stopping...' : 'YES, STOP'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-3 py-2 bg-surfaceLight text-textMuted rounded text-sm hover:bg-surface transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="flex items-center gap-2 px-4 py-2 bg-danger/10 border border-danger/40 text-danger rounded-lg font-semibold hover:bg-danger/20 transition-colors"
      title="Emergency stop — disables auto-trade immediately"
    >
      <AlertTriangle size={16} />
      STOP AUTO-TRADE
    </button>
  );
}

function AppContent() {
  const initializeWebSocket = useMarketStore(state => state.initializeWebSocket);
  const wsConnected = useMarketStore(state => state.wsConnected);

  React.useEffect(() => {
    initializeWebSocket();
  }, [initializeWebSocket]);

  return (
    <div className="flex bg-background min-h-screen text-text font-sans">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6 h-screen custom-scrollbar">
        <header className="mb-8 flex items-center justify-between border-b border-surfaceLight pb-4 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-primary">AlgoTrade</h1>
            <p className="text-textMuted text-sm mt-1">Autonomous Hedge Fund Command Center</p>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <KillSwitchButton />
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-success animate-pulse' : 'bg-danger'}`}></span>
              <span className="text-xs text-textMuted uppercase font-semibold">{wsConnected ? 'Live' : 'Disconnected'}</span>
            </div>
            <span className="text-sm font-mono text-textMuted">UTC+7</span>
          </div>
        </header>

        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/quant" element={<QuantScreener />} />
          <Route path="/execution" element={<ExecutionDesk />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/backtest/data" element={<BacktestDataStatus />} />
          <Route path="/backtest/run" element={<BacktestRun />} />
          <Route path="/backtest/optimize" element={<BacktestOptimize />} />
          <Route path="/equity" element={<EquityCurve />} />
          <Route path="/journal" element={<TradeJournal />} />
          <Route path="/system/health" element={<SystemHealth />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <Router>
          <AppContent />
        </Router>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App;
