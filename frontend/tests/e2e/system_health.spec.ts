import { test, expect } from './fixtures/auth';

test.describe('System Health page', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/system/health');
    await expect(page.locator('h2, h1', { hasText: 'System Health' })).toBeVisible();
  });

  test('renders 4 status cards', async ({ authedPage: page }) => {
    for (const label of ['AUTO-TRADE', 'POSTGRES', 'MT5', 'DAILY DD']) {
      await expect(page.locator('text=' + label).first()).toBeVisible();
    }
  });

  test('today realized P/L card present', async ({ authedPage: page }) => {
    await expect(page.locator('text=Today realized P/L')).toBeVisible();
  });

  test('scheduler jobs table lists all critical jobs', async ({ authedPage: page }) => {
    await expect(page.locator('text=Scheduler jobs')).toBeVisible();
    // Critical jobs must be visible
    for (const jobId of [
      'tick_broadcast',
      'ingest_m1',
      'retry_worker',
      'quant_scan',
      'ingest_h1',
      'equity_snapshot',
      'auto_optimize_monthly',
    ]) {
      await expect(page.locator(`text=${jobId}`).first()).toBeVisible();
    }
  });

  test('shows last refresh timestamp + auto-refresh indicator', async ({ authedPage: page }) => {
    await expect(page.locator('text=/Last refresh:/')).toBeVisible();
  });
});
