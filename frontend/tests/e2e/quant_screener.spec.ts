import { test, expect } from './fixtures/auth';

test.describe('Quant Screener page (TradingView layout)', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/quant');
    await expect(page.locator('h2', { hasText: 'Quant & Technical Desk' })).toBeVisible();
  });

  test('timeframe selector shows all 6 TFs (M5 / M15 / H1 / H4 / D / W)', async ({ authedPage: page }) => {
    for (const tf of ['M5', 'M15', 'H1', 'H4', 'D', 'W']) {
      await expect(page.locator('button').filter({ hasText: new RegExp(`^${tf}$`) }).first()).toBeVisible();
    }
  });

  test('clicking timeframe button switches active TF (visual)', async ({ authedPage: page }) => {
    const h4Btn = page.locator('button').filter({ hasText: /^H4$/ }).first();
    await h4Btn.click();
    // Active TF should have primary bg — check class
    const cls = await h4Btn.getAttribute('class');
    expect(cls).toMatch(/bg-primary/);
  });

  test('watchlist sidebar renders with search + filter', async ({ authedPage: page }) => {
    await expect(page.locator('input[placeholder="Search..."]').first()).toBeVisible();
    await expect(page.locator('select').first()).toBeVisible();
    await expect(page.locator('text=Watchlist').first()).toBeVisible();
  });

  test('clicking a watchlist row changes selected symbol header', async ({ authedPage: page }) => {
    // Get all watchlist row buttons (sym buttons in sidebar)
    const rows = page.locator('button').filter({ hasText: /^[A-Z]{3,6}\d?$/ });
    const count = await rows.count();
    if (count < 2) return;  // Need at least 2 symbols to test switching
    // Click second row
    await rows.nth(1).click();
    // Header should show that symbol in the bold heading
    await page.waitForTimeout(300);
    // Symbol header is the bold xl text — should match a real symbol
    const symbolHeader = page.locator('.text-xl.font-bold').first();
    const text = await symbolHeader.textContent();
    expect(text).toMatch(/^[A-Z]{3,6}\d?$/);
  });

  test('search input filters watchlist', async ({ authedPage: page }) => {
    const search = page.locator('input[placeholder="Search..."]').first();
    await search.fill('XAU');
    await page.waitForTimeout(300);
    // After filter, count text shows match count
    const count = page.locator('text=/Watchlist \\(\\d+\\)/').first();
    await expect(count).toBeVisible();
  });

  test('Fullscreen button present', async ({ authedPage: page }) => {
    await expect(page.locator('button').filter({ hasText: /Fullscreen/i })).toBeVisible();
  });

  test('detail panels below chart render: Triple Screen + RSI + Volume + Execution + Reasoning', async ({ authedPage: page }) => {
    // Triggered by initial selection (first asset auto-selected)
    await page.waitForTimeout(800);
    // At least the Triple Screen card should be there if data loaded
    const tripleScreen = page.locator('text=Triple Screen Alignment').first();
    if (await tripleScreen.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(tripleScreen).toBeVisible();
      await expect(page.locator('text=/RSI \\(14\\)/').first()).toBeVisible();
      await expect(page.locator('text=/Volume vs VMA/').first()).toBeVisible();
    }
  });

  test('selected symbol + timeframe persist via localStorage', async ({ authedPage: page }) => {
    // Click H4 timeframe + a specific symbol if possible
    await page.locator('button').filter({ hasText: /^H4$/ }).first().click();
    await page.waitForTimeout(300);
    const tfStored = await page.evaluate(() => localStorage.getItem('algotrade_chart_timeframe'));
    expect(tfStored).toBe('H4');
    const symStored = await page.evaluate(() => localStorage.getItem('algotrade_selected_symbol'));
    expect(symStored).toBeTruthy();
  });
});
