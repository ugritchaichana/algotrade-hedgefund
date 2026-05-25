/**
 * Auth fixture — handles PIN overlay before tests start.
 *
 * Usage:
 *   import { test, expect } from './fixtures/auth';
 *   test('my test', async ({ page }) => { ... });  // page is already authenticated
 *
 * The fixture pre-injects the PIN into localStorage so the PinOverlay never appears.
 * Falls back to UI input if needed.
 */

import { test as base, expect, type Page } from '@playwright/test';

const DEFAULT_PIN = process.env.ALGOTRADE_TEST_PIN || '130944';
const BACKEND_URL = process.env.ALGOTRADE_TEST_URL || 'http://127.0.0.1:8000';

type AuthFixtures = {
  authedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page, context }, use) => {
    // Pre-seed PIN + theme into localStorage so PinOverlay's checkPin() succeeds AND
    // tests get a deterministic theme baseline (not affected by host OS pref).
    await context.addInitScript((pin) => {
      try {
        window.localStorage.setItem('algo_pin', pin);
        window.localStorage.setItem('algotrade_theme', 'dark');
      } catch {}
    }, DEFAULT_PIN);

    await page.goto('/');

    // Wait for the dashboard header to be visible (signals app is past PinOverlay)
    await expect(page.locator('header h1', { hasText: 'AlgoTrade' })).toBeVisible({ timeout: 15000 });

    // If PIN was wrong, the overlay would still be there. Fall back to UI input.
    const pinInput = page.locator('input[type="password"][placeholder="Enter PIN"]');
    if (await pinInput.isVisible({ timeout: 500 }).catch(() => false)) {
      await pinInput.fill(DEFAULT_PIN);
      await page.click('button:has-text("Unlock")');
      await expect(page.locator('header h1', { hasText: 'AlgoTrade' })).toBeVisible();
    }

    await use(page);
  },
});

export { expect };

/** Backend probe — fails fast if API is down. Call in globalSetup or beforeAll. */
export async function probeBackend(): Promise<boolean> {
  try {
    const r = await fetch(`${BACKEND_URL}/api/health`, {
      headers: { 'x-pin': DEFAULT_PIN },
    });
    return r.ok;
  } catch {
    return false;
  }
}
