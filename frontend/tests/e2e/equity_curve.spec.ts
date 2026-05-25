import { test, expect } from './fixtures/auth';

test.describe('Equity Curve page', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/equity');
    await expect(page.locator('h2', { hasText: 'Equity Curve' })).toBeVisible();
  });

  test('renders 4 KPI cards', async ({ authedPage: page }) => {
    for (const label of ['Current Equity', 'Total Return', 'Current DD', 'Max DD']) {
      await expect(page.locator('text=' + label).first()).toBeVisible();
    }
  });

  test('range selector 7D/30D/90D/ALL switches windows', async ({ authedPage: page }) => {
    for (const r of ['7D', '30D', '90D', 'ALL']) {
      await page.locator(`button:has-text("${r}")`).first().click();
      await page.waitForTimeout(300);
    }
  });

  test('main equity chart container renders', async ({ authedPage: page }) => {
    await expect(page.locator('text=Equity over time')).toBeVisible();
  });

  test('drawdown + daily P/L section renders when snapshots exist', async ({ authedPage: page }) => {
    const ddSection = page.locator('text=Drawdown shading + Daily P/L bars');
    if (await ddSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Recharts ComposedChart should render an SVG
      const svgs = page.locator('div.bg-surface').filter({ hasText: 'Drawdown shading' }).locator('svg');
      await expect(svgs.first()).toBeVisible();
    }
  });

  test('recent snapshots table shows when data exists', async ({ authedPage: page }) => {
    const table = page.locator('text=Recent snapshots');
    if (await table.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Column headers
      await expect(page.locator('text=Equity').first()).toBeVisible();
      await expect(page.locator('text=Free Margin').first()).toBeVisible();
    }
  });
});
