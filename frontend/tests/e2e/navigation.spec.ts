import { test, expect } from './fixtures/auth';

test.describe('Navigation + Layout', () => {
  test('header shows AlgoTrade title + subtitle', async ({ authedPage: page }) => {
    await expect(page.locator('header h1', { hasText: 'AlgoTrade' })).toBeVisible();
    await expect(page.locator('text=Autonomous Hedge Fund Command Center')).toBeVisible();
  });

  test('WebSocket status indicator (Live or Disconnected)', async ({ authedPage: page }) => {
    const live = page.locator('header').locator('text=Live');
    const dis = page.locator('header').locator('text=Disconnected');
    // One of them must be visible
    const liveVisible = await live.isVisible({ timeout: 5000 }).catch(() => false);
    const disVisible = await dis.isVisible({ timeout: 1000 }).catch(() => false);
    expect(liveVisible || disVisible).toBe(true);
  });

  test('sidebar has all 10 navigation entries', async ({ authedPage: page }) => {
    for (const link of [
      'Dashboard',
      'Quant Screener',
      'Execution Desk',
      'Equity Curve',
      'Trade Journal',
      'Data Status',
      'Run Backtest',
      'Optimize',
      'System Health',
      'Settings',
    ]) {
      await expect(page.locator('nav, aside').locator(`text=${link}`).first()).toBeVisible();
    }
  });

  test('navigate via sidebar to each main page', async ({ authedPage: page }) => {
    const routes: [string, RegExp][] = [
      ['Quant Screener', /\/quant/],
      ['Execution Desk', /\/execution/],
      ['Equity Curve', /\/equity/],
      ['Trade Journal', /\/journal/],
      ['Data Status', /\/backtest\/data/],
      ['Run Backtest', /\/backtest\/run/],
      ['Optimize', /\/backtest\/optimize/],
      ['System Health', /\/system\/health/],
      ['Settings', /\/settings/],
      ['Dashboard', /\/$/],
    ];
    for (const [label, urlPattern] of routes) {
      await page.locator('nav, aside').locator(`text=${label}`).first().click();
      await expect(page).toHaveURL(urlPattern);
    }
  });

  test('header shows BACKEND LIVE + AUTO-TRADE ON indicators in sidebar footer', async ({ authedPage: page }) => {
    await expect(page.locator('text=BACKEND LIVE').first()).toBeVisible();
    await expect(page.locator('text=AUTO-TRADE ON').first()).toBeVisible();
  });

  test('UTC+7 timezone label displayed', async ({ authedPage: page }) => {
    await expect(page.locator('text=UTC+7').first()).toBeVisible();
  });
});
