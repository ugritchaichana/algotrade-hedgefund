import { test, expect } from './fixtures/auth';

/**
 * Kill switch test — TOGGLES LIVE STATE. Each test ends with auto-trade ENABLED.
 * Wrapped in afterEach to guarantee restoration even on failure.
 */

test.describe('Kill Switch button', () => {
  test.afterEach(async ({ authedPage: page }) => {
    // Always restore auto-trade enabled
    const pin = await page.evaluate(() => window.localStorage.getItem('algo_pin'));
    await page.evaluate(async (pinValue) => {
      try {
        await fetch('http://127.0.0.1:8000/api/kill-switch/restore', {
          method: 'POST',
          headers: { 'x-pin': pinValue || '' },
        });
      } catch {}
    }, pin);
  });

  test('header shows STOP AUTO-TRADE button when enabled', async ({ authedPage: page }) => {
    const stopBtn = page.locator('button:has-text("STOP AUTO-TRADE")');
    await expect(stopBtn).toBeVisible();
  });

  test('clicking STOP shows confirmation prompt', async ({ authedPage: page }) => {
    await page.locator('button:has-text("STOP AUTO-TRADE")').click();
    await expect(page.locator('text=Confirm stop?')).toBeVisible();
    await expect(page.locator('button:has-text("YES, STOP")')).toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test('Cancel returns to STOP state without disabling', async ({ authedPage: page }) => {
    await page.locator('button:has-text("STOP AUTO-TRADE")').click();
    await page.locator('button:has-text("Cancel")').click();
    await expect(page.locator('button:has-text("STOP AUTO-TRADE")')).toBeVisible();
  });

  test('Confirm STOP disables auto-trade', async ({ authedPage: page }) => {
    await page.locator('button:has-text("STOP AUTO-TRADE")').click();
    await page.locator('button:has-text("YES, STOP")').click();
    // After stop, button changes to RESUME
    await expect(page.locator('button:has-text("AUTO-TRADE OFF")')).toBeVisible({ timeout: 5000 });
  });

  test('Resume restores enabled state', async ({ authedPage: page }) => {
    // First disable
    await page.locator('button:has-text("STOP AUTO-TRADE")').click();
    await page.locator('button:has-text("YES, STOP")').click();
    await expect(page.locator('button:has-text("AUTO-TRADE OFF")')).toBeVisible({ timeout: 8000 });

    // Then resume — backend POST + WS settle take time
    await page.locator('button:has-text("AUTO-TRADE OFF")').click();
    await expect(page.locator('button:has-text("STOP AUTO-TRADE")')).toBeVisible({ timeout: 10000 });
  });
});
