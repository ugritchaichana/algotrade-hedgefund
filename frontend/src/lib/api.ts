/**
 * Centralized API base URL + helpers.
 *
 * Env var: VITE_API_URL (set in .env.local or .env)
 * Default: http://127.0.0.1:8000 (local dev)
 *
 * For LAN remote access, set VITE_API_URL to backend's LAN IP:
 *   VITE_API_URL=http://192.168.1.42:8000
 *
 * For future Tailscale: VITE_API_URL=http://booth-pc.tailnet:8000
 */
export const API_BASE = (import.meta.env.VITE_API_URL as string) || (typeof window !== 'undefined' && window.location.port === '5173' ? 'http://127.0.0.1:8000' : '');

export function getPin() {
  return localStorage.getItem('algo_pin') || '';
}

export function setPin(pin: string) {
  localStorage.setItem('algo_pin', pin);
}

// Globally intercept fetch to attach x-pin header to all API requests
if (typeof window !== 'undefined') {
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const pin = getPin();
    if (pin) {
      if (typeof input === 'string' && input.includes('/api/')) {
        init = init || {};
        init.headers = { ...init.headers, 'x-pin': pin };
      }
    }
    return originalFetch.apply(this, [input, init as RequestInit]);
  };
}

export async function apiGet<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    method: 'GET',
    headers: { 'x-pin': getPin(), ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pin': getPin(), ...(init?.headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`POST ${path} failed: ${r.status}`);
  return r.json();
}

export function buildWebSocketUrl(path: string): string {
  let url = '';
  if (!API_BASE) {
    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    url = `${protocol}//${loc.host}${path}`;
  } else {
    const base = API_BASE.replace(/^http/, 'ws');
    url = `${base}${path}`;
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}pin=${getPin()}`;
}
