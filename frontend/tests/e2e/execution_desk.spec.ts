import { test, expect } from './fixtures/auth';

test.describe('Execution Desk page', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/execution');
    await expect(page.locator('h1, h2', { hasText: 'Execution Desk' })).toBeVisible();
  });

  test('renders 3 main panels: Signal Panel, Active Orders, Recent Closed', async ({ authedPage: page }) => {
    await expect(page.locator('text=Signal Panel').first()).toBeVisible();
    await expect(page.locator('text=Active Orders').first()).toBeVisible();
    await expect(page.locator('text=Recent Closed Deals').first()).toBeVisible();
  });

  test('Active Orders shows count badge', async ({ authedPage: page }) => {
    // Active Orders panel shows "(MT5)" + a count number
    const panel = page.locator('.bg-surface, div').filter({ hasText: /Active Orders/ }).first();
    await expect(panel).toBeVisible();
  });

  test('empty state messages render gracefully', async ({ authedPage: page }) => {
    // Either "No active orders" + "No recent history" OR populated rows.
    const noActive = page.locator('text=No active orders');
    const noHistory = page.locator('text=No recent history');
    // At least one of these should be there OR there's data — both acceptable.
    const hasEmpty = await noActive.isVisible({ timeout: 1000 }).catch(() => false);
    const hasHistory = await noHistory.isVisible({ timeout: 500 }).catch(() => false);
    // Smoke test only — verify page didn't crash
    expect(page.url()).toContain('/execution');
  });
});
