/**
 * Centralized API base URL + helpers.
 *
 * Resolution order:
 *   1. VITE_API_URL env var — explicit override (e.g. VITE_API_URL=http://192.168.1.42:8000)
 *   2. Cloudflare tunnel / HTTPS remote — empty string (relative URLs → Vite proxy forwards)
 *   3. Local Vite dev (port 5173 on localhost) — absolute http://127.0.0.1:8000
 *   4. Anything else — empty (same-origin)
 *
 * The relative-URL branch is what makes the Cloudflare quick tunnel
 * (`cloudflared tunnel --url http://localhost:5173`) work without leaking backend port.
 * Vite proxy in vite.config.ts forwards /api + /api/ws to the backend.
 */
function resolveApiBase(): string {
  const envVar = import.meta.env.VITE_API_URL as string | undefined;
  if (envVar) return envVar;
  if (typeof window === 'undefined') return '';
  const loc = window.location;
  // Remote access via HTTPS (Cloudflare tunnel, Tailscale Funnel, etc.) → relative
  if (loc.protocol === 'https:') return '';
  // Local Vite dev on default port → backend on 8000
  if (loc.port === '5173' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) {
    return 'http://127.0.0.1:8000';
  }
  // LAN access via http://<LAN-IP>:5173 → same hostname, port 8000
  if (loc.port === '5173') return `http://${loc.hostname}:8000`;
  return '';
}

export const API_BASE = resolveApiBase();

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
