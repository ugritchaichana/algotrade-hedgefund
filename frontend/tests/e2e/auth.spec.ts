import { test, expect } from '@playwright/test';

/**
 * PIN authentication tests — these intentionally do NOT use the auth fixture
 * (they need to drive the login UI manually).
 */

test.describe('PIN Authentication', () => {
  test.beforeEach(async ({ page, context }) => {
    // Clear any stored PIN to force login screen
    await context.addInitScript(() => {
      try {
        window.localStorage.removeItem('algo_pin');
      } catch {}
    });
  });

  test('shows PIN overlay when not authenticated', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=AlgoTrade Command Center')).toBeVisible();
    await expect(page.locator('input[type="password"][placeholder="Enter PIN"]')).toBeVisible();
  });

  test('correct PIN unlocks dashboard', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('input[type="password"][placeholder="Enter PIN"]');
    await input.fill('130944');
    await page.click('button:has-text("Unlock")');
    // Should navigate past overlay
    await expect(page.locator('header h1', { hasText: 'AlgoTrade' })).toBeVisible({ timeout: 10000 });
  });

  test('wrong PIN shows error', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('input[type="password"][placeholder="Enter PIN"]');
    await input.fill('00000');
    await page.click('button:has-text("Unlock")');
    await expect(page.locator('text=Invalid PIN')).toBeVisible({ timeout: 5000 });
  });

  test('Unlock button disabled when PIN empty', async ({ page }) => {
    await page.goto('/');
    const unlock = page.locator('button:has-text("Unlock")');
    await expect(unlock).toBeDisabled();
  });

  test('PIN persisted via localStorage after unlock', async ({ page, context }) => {
    await page.goto('/');
    await page.locator('input[type="password"]').fill('130944');
    await page.click('button:has-text("Unlock")');
    await expect(page.locator('header h1', { hasText: 'AlgoTrade' })).toBeVisible();

    const pin = await page.evaluate(() => window.localStorage.getItem('algo_pin'));
    expect(pin).toBe('130944');
  });
});
