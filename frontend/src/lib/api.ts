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
export const API_BASE = (import.meta.env.VITE_API_URL as string) || 'http://127.0.0.1:8000';

export async function apiGet<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { ...init, method: 'GET' });
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`POST ${path} failed: ${r.status}`);
  return r.json();
}

export function buildWebSocketUrl(path: string): string {
  const base = API_BASE.replace(/^http/, 'ws');
  return `${base}${path}`;
}
