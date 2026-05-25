import { create } from 'zustand';
import { API_BASE, buildWebSocketUrl } from '../lib/api';

export interface ActivityEvent {
  id: string;          // local UUID for React key
  type: string;        // TRADE_OPENED | TRADE_CLOSED | TRADE_STATE_CHANGE | SAFETY_EVENT | EQUITY_SNAPSHOT | OPTIMIZE_PROGRESS | OPTIMIZE_DONE | INGEST_TICK | HEALTH_DELTA | SETTING_CHANGED
  data: any;
  ts: string;
}

export interface OptimizeProgress {
  job_id: string;
  combos_done: number;
  combos_total: number;
  runs_done: number;
  runs_total: number;
  pct: number;
}

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

  // Real-time event streams (Phase F)
  recentEvents: ActivityEvent[];          // ring buffer, capped at 100
  positionStates: Record<number, any>;     // by ticket (TRADE_STATE_CHANGE)
  optimizeProgress: Record<string, OptimizeProgress>; // by job_id
  recentSafetyEvents: ActivityEvent[];     // last 20 safety events
  equitySeries: Array<{recorded_at: string, equity: number, daily_pnl: number}>;
  healthDeltas: Record<string, {last_status: string, last_run?: string, last_error?: string}>;

  setAssets: (assets: string[]) => void;
  updateTickData: (payload: any) => void;
  updateQuantData: (symbol: string, data: any) => void;
  setConnectionStatus: (status: boolean) => void;
  setAutoTradeEnabled: (enabled: boolean) => void;
  initializeWebSocket: () => void;
  pushEvent: (ev: ActivityEvent) => void;
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

  recentEvents: [],
  positionStates: {},
  optimizeProgress: {},
  recentSafetyEvents: [],
  equitySeries: [],
  healthDeltas: {},

  pushEvent: (ev) => set((state) => ({
    recentEvents: [ev, ...state.recentEvents].slice(0, 100),
    recentSafetyEvents: ev.type === 'SAFETY_EVENT'
      ? [ev, ...state.recentSafetyEvents].slice(0, 20)
      : state.recentSafetyEvents,
  })),

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
        const t = payload.type;
        if (t === 'TICK_DATA') {
          get().updateTickData(payload);
          return;
        }
        if (t === 'QUANT_UPDATE') {
          get().updateQuantData(payload.symbol, payload.data);
          return;
        }
        // Activity events (Phase F)
        const evId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ev: ActivityEvent = { id: evId, type: t, data: payload.data || {}, ts: payload.ts || new Date().toISOString() };
        if (t === 'OPTIMIZE_PROGRESS') {
          const d = payload.data || {};
          if (d.job_id) {
            set((state) => ({
              optimizeProgress: { ...state.optimizeProgress, [d.job_id]: d },
            }));
          }
          return; // don't pile into activity feed (too noisy)
        }
        if (t === 'EQUITY_SNAPSHOT') {
          const d = payload.data || {};
          set((state) => ({
            equitySeries: [...state.equitySeries, {
              recorded_at: d.recorded_at,
              equity: d.equity,
              daily_pnl: d.daily_pnl,
            }].slice(-500),
          }));
        }
        if (t === 'TRADE_STATE_CHANGE') {
          const d = payload.data || {};
          if (d.ticket) {
            set((state) => ({
              positionStates: { ...state.positionStates, [d.ticket]: d },
            }));
          }
        }
        if (t === 'HEALTH_DELTA') {
          const d = payload.data || {};
          if (d.job_id) {
            set((state) => ({
              healthDeltas: { ...state.healthDeltas, [d.job_id]: { last_status: d.last_status, last_run: d.last_run, last_error: d.last_error } },
            }));
          }
        }
        if (t === 'SETTING_CHANGED') {
          // Trigger a refetch trigger by emitting event — components subscribe via selector
        }
        // Always push into activity feed (except OPTIMIZE_PROGRESS handled above)
        get().pushEvent(ev);
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
