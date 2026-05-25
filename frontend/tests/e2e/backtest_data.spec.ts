import { test, expect } from './fixtures/auth';

test.describe('Backtest Data Status', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/backtest/data');
    // Page uses h1 for title — not h2
    await expect(page.locator('h1', { hasText: 'Backtest Data Status' })).toBeVisible();
  });

  test('renders 3 stat cards', async ({ authedPage: page }) => {
    // DOM text is lowercase ('Symbols tracked'); CSS uppercases it for display
    for (const label of [/Symbols tracked/i, /Timeframe slots filled/i, /Total candles/i]) {
      await expect(page.locator(`text=${label.source}`).first()).toBeVisible();
    }
  });

  test('action buttons present', async ({ authedPage: page }) => {
    await expect(page.locator('button').filter({ hasText: /Refresh/i }).first()).toBeVisible();
    await expect(page.locator('button').filter({ hasText: /Incremental Sync/i })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: /Deep Backfill/i })).toBeVisible();
  });

  test('per-symbol table shows D1/H4/H1 columns', async ({ authedPage: page }) => {
    await expect(page.locator('th').filter({ hasText: /^D1$/ }).first()).toBeVisible();
    await expect(page.locator('th').filter({ hasText: /^H4$/ }).first()).toBeVisible();
    await expect(page.locator('th').filter({ hasText: /^H1$/ }).first()).toBeVisible();
  });

  test('Refresh button triggers reload (no error)', async ({ authedPage: page }) => {
    await page.locator('button').filter({ hasText: /Refresh/i }).first().click();
    // No crash + page header still visible
    await expect(page.locator('h1, h2').filter({ hasText: 'Backtest Data Status' })).toBeVisible();
  });
});
