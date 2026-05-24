import { create } from 'zustand';
import { API_BASE, buildWebSocketUrl } from '../lib/api';

interface MarketState {
  assets: string[];
  prices: Record<string, any>;
  macro: any;
  technical: Record<string, any>;
  risk: any;
  orders: any[];
  accountStatus: any;
  loadingProgress: number;
  isFullyLoaded: boolean;
  wsConnected: boolean;
  autoTradeEnabled: boolean;

  setAssets: (assets: string[]) => void;
  updateTickData: (payload: any) => void;
  updateQuantData: (symbol: string, data: any) => void;
  setConnectionStatus: (status: boolean) => void;
  setAutoTradeEnabled: (enabled: boolean) => void;
  initializeWebSocket: () => void;
}

const CACHE_PREFIX = 'hf_v7_';  // bumped from v6 after schema changes; old keys cleaned on init
const CACHE_TTL_MS = 30 * 60 * 1000;
const WS_BACKOFF_BASE_MS = 1000;
const WS_BACKOFF_MAX_MS = 30000;

// Clean any old-version cache keys to avoid stale data after schema bumps
function cleanLegacyCaches() {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^hf_v[1-6]_/.test(k)) stale.push(k);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch {
    // localStorage unavailable — ignore
  }
}
cleanLegacyCaches();

function getLocalCache(key: string): any | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { data, time } = JSON.parse(raw);
    if (Date.now() - time > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function setLocalCache(key: string, data: any): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, time: Date.now() }));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

// Module-level reconnect state — survives store re-creation
let _reconnectAttempts = 0;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _activeWs: WebSocket | null = null;

export const useMarketStore = create<MarketState>((set, get) => ({
  assets: [],
  prices: {},
  macro: getLocalCache('macro'),
  technical: getLocalCache('technical') || {},
  risk: getLocalCache('risk'),
  orders: [],
  accountStatus: null,
  loadingProgress: Object.keys(getLocalCache('technical') || {}).length > 0 ? 100 : 0,
  isFullyLoaded: Object.keys(getLocalCache('technical') || {}).length >= 28,
  wsConnected: false,
  autoTradeEnabled: true,

  setAssets: (assets) => set({ assets }),

  updateTickData: (payload) => set((state) => ({
    prices: payload.prices || state.prices,
    orders: payload.orders || state.orders,
    accountStatus: payload.account || state.accountStatus,
    autoTradeEnabled: typeof payload.auto_trade_enabled === 'boolean'
      ? payload.auto_trade_enabled
      : state.autoTradeEnabled,
  })),

  updateQuantData: (symbol, data) => set((state) => {
    const newTechnical = { ...state.technical, [symbol]: data };
    const loaded = Object.keys(newTechnical).length;
    const total = state.assets.length || 28;
    setLocalCache('technical', newTechnical);
    return {
      technical: newTechnical,
      loadingProgress: Math.round((loaded / total) * 100),
      isFullyLoaded: loaded >= total,
    };
  }),

  setConnectionStatus: (status) => set({ wsConnected: status }),
  setAutoTradeEnabled: (enabled) => set({ autoTradeEnabled: enabled }),

  initializeWebSocket: () => {
    // Already connected — no-op
    if (_activeWs && _activeWs.readyState === WebSocket.OPEN) return;
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    const ws = new WebSocket(buildWebSocketUrl('/api/ws/market'));
    _activeWs = ws;

    ws.onopen = () => {
      _reconnectAttempts = 0;
      get().setConnectionStatus(true);

      // Initial config + snapshot fetches in parallel
      fetch(`${API_BASE}/api/config/assets`)
        .then(r => r.json()).then(d => get().setAssets(d.assets || []))
        .catch(() => {});

      fetch(`${API_BASE}/api/analysis/quant`)
        .then(r => r.json()).then(d => {
          if (Object.keys(d).length > 0) {
            const merged = { ...get().technical, ...d };
            setLocalCache('technical', merged);
            set({
              technical: merged,
              isFullyLoaded: Object.keys(merged).length >= (get().assets.length || 28),
              loadingProgress: 100,
            });
          }
        }).catch(() => {});

      const cachedMacro = getLocalCache('macro');
      if (cachedMacro) {
        set({ macro: cachedMacro });
      } else {
        fetch(`${API_BASE}/api/analysis/macro`)
          .then(r => r.json()).then(d => { set({ macro: d }); setLocalCache('macro', d); })
          .catch(() => {});
      }

      const cachedRisk = getLocalCache('risk');
      if (cachedRisk) {
        set({ risk: cachedRisk });
      } else {
        fetch(`${API_BASE}/api/analysis/risk`)
          .then(r => r.json()).then(d => { set({ risk: d }); setLocalCache('risk', d); })
          .catch(() => {});
      }

      // Sync kill-switch state from /api/health on every fresh connect
      fetch(`${API_BASE}/api/health`)
        .then(r => r.json())
        .then(d => set({ autoTradeEnabled: !!d.auto_trade_enabled }))
        .catch(() => {});
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'TICK_DATA') get().updateTickData(payload);
        else if (payload.type === 'QUANT_UPDATE') get().updateQuantData(payload.symbol, payload.data);
      } catch (e) {
        console.error('WS message parse:', e);
      }
    };

    ws.onclose = () => {
      get().setConnectionStatus(false);
      _activeWs = null;
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      const delay = Math.min(WS_BACKOFF_BASE_MS * Math.pow(2, _reconnectAttempts), WS_BACKOFF_MAX_MS);
      _reconnectAttempts++;
      _reconnectTimer = setTimeout(() => get().initializeWebSocket(), delay);
    };

    ws.onerror = (err) => {
      console.error('WS error:', err);
      ws.close();
    };
  },
}));
