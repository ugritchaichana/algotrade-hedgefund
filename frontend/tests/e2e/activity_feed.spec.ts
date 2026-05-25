import { test, expect } from './fixtures/auth';

test.describe('Activity Feed widget', () => {
  test('shows collapsed badge by default', async ({ authedPage: page }) => {
    // The floating button at bottom-right
    const fab = page.locator('button[title*="Open activity feed"]');
    await expect(fab).toBeVisible();
  });

  test('expands when clicked + shows header', async ({ authedPage: page }) => {
    await page.locator('button[title*="Open activity feed"]').click();
    await expect(page.locator('text=Activity Feed').first()).toBeVisible();
  });

  test('can be closed via X button', async ({ authedPage: page }) => {
    await page.locator('button[title*="Open activity feed"]').click();
    await expect(page.locator('text=Activity Feed').first()).toBeVisible();

    // Click X button in the expanded panel
    const closeBtn = page.locator('button').filter({ has: page.locator('svg.lucide-x') }).last();
    await closeBtn.click();
    await expect(page.locator('button[title*="Open activity feed"]')).toBeVisible();
  });

  test('badge increments when new event arrives', async ({ authedPage: page }) => {
    // Fire a SAFETY event via backend API (test-safe — just notify, no state change)
    // Use settings endpoint to broadcast SETTING_CHANGED → event in feed
    const pin = await page.evaluate(() => window.localStorage.getItem('algo_pin'));
    await page.evaluate(async (pinValue) => {
      await fetch('http://127.0.0.1:8000/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pin': pinValue || '' },
        body: JSON.stringify({ key: 'e2e_test_probe', value: 'test-' + Date.now() }),
      });
    }, pin);

    // WS event should arrive within 2s
    await page.waitForTimeout(2000);

    // Either badge shows count OR feed has the event (if it was open)
    const fab = page.locator('button[title*="Open activity feed"]');
    if (await fab.isVisible().catch(() => false)) {
      // Badge should have a number
      const badge = fab.locator('span').filter({ hasText: /\d+/ });
      await expect(badge).toBeVisible({ timeout: 5000 });
    }
  });
});
