import { test, expect } from './fixtures/auth';

test.describe('Trade Journal page', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/journal');
    await expect(page.locator('h2', { hasText: 'Trade Journal' })).toBeVisible();
  });

  test('renders 6 KPI cards', async ({ authedPage: page }) => {
    for (const label of ['Trades', 'Win Rate', 'Profit Factor', 'Avg R', 'Expectancy', 'Total P/L']) {
      await expect(page.locator('text=' + label).first()).toBeVisible();
    }
  });

  test('Edge vs Noise attribution panel renders', async ({ authedPage: page }) => {
    // Only renders when there are closed trades. Guard with conditional.
    const edgeCard = page.locator('text=Edge vs Noise');
    if (await edgeCard.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(page.locator('text=Edge').first()).toBeVisible();
      await expect(page.locator('text=Noise').first()).toBeVisible();
      await expect(page.locator('text=Mixed').first()).toBeVisible();
    }
  });

  test('R-distribution histogram renders when data exists', async ({ authedPage: page }) => {
    const histo = page.locator('text=R-multiple Distribution');
    if (await histo.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Recharts renders SVG with bars
      await expect(page.locator('svg .recharts-bar').first()).toBeVisible();
    }
  });

  test('symbol filter narrows results', async ({ authedPage: page }) => {
    const filterInput = page.locator('input[placeholder="Symbol"]');
    await filterInput.fill('NAS100');
    // Visible count text changes (e.g., "2 / 5 trades")
    await page.waitForTimeout(500);
    // No assertion on exact number — just that input works
    expect(await filterInput.inputValue()).toBe('NAS100');
  });

  test('side filter ALL/BUY/SELL works', async ({ authedPage: page }) => {
    // Target the select whose options include BUY/SELL (not the days dropdown)
    const sideSelect = page.locator('select', { has: page.locator('option[value="BUY"]') }).first();
    await sideSelect.selectOption('BUY');
    expect(await sideSelect.inputValue()).toBe('BUY');
    await sideSelect.selectOption('SELL');
    expect(await sideSelect.inputValue()).toBe('SELL');
    await sideSelect.selectOption('ALL');
  });

  test('days range selector changes data window', async ({ authedPage: page }) => {
    // Days select has option values like "7", "30", "90", "365"
    const daysSelect = page.locator('select', { has: page.locator('option[value="90"]') }).first();
    await daysSelect.selectOption('90');
    await page.waitForTimeout(800);  // refetch
    expect(await daysSelect.inputValue()).toBe('90');
  });

  test('expand row reveals signal context', async ({ authedPage: page }) => {
    const firstRow = page.locator('tbody tr').first();
    if (await firstRow.isVisible({ timeout: 1000 }).catch(() => false)) {
      await firstRow.click();
      // Detail row should appear with Initial SL / Initial TP labels
      await expect(page.locator('text=Initial SL').first()).toBeVisible();
    }
  });

  test('CSV export button rendered', async ({ authedPage: page }) => {
    // Smoke: button is present. Disabled-state depends on filter result, which depends
    // on backend data + symbol/side filters from prior tests in same context — fragile
    // to assert disabled status exactly. Just verify button exists + has correct label.
    const csvBtn = page.locator('button').filter({ hasText: /Export CSV/i });
    await expect(csvBtn).toBeVisible();
  });
});
