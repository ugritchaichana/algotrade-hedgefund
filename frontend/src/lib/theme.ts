/**
 * Theme system — toggles data-theme attribute on <html> + persists choice.
 *
 * Defaults to "dark" (trading-desk convention). Respects system preference
 * on first visit if no localStorage entry exists.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'algotrade_theme';

export function getStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === 'dark' || t === 'light') return t;
  } catch {}
  // First visit — respect system preference, defaulting to dark
  if (typeof window !== 'undefined' && window.matchMedia) {
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }
  return 'dark';
}

export function applyTheme(theme: Theme): void {
  try {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {}
}

// Apply on first import (before React renders) to avoid FOUC
if (typeof document !== 'undefined') {
  applyTheme(getStoredTheme());
}
