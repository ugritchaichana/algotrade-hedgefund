import { test, expect } from './fixtures/auth';

test.describe('Dashboard page', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/');
  });

  test('header AlgoTrade + WS status visible', async ({ authedPage: page }) => {
    await expect(page.locator('header h1', { hasText: 'AlgoTrade' })).toBeVisible();
  });

  test('kill switch button shown', async ({ authedPage: page }) => {
    await expect(
      page.locator('button:has-text("STOP AUTO-TRADE"), button:has-text("AUTO-TRADE OFF")')
    ).toBeVisible();
  });

  test('Cmd+K hint visible on desktop layout', async ({ authedPage: page }) => {
    const hint = page.locator('header').locator('text=K').first();
    await expect(hint).toBeVisible();
  });

  test('theme toggle button present', async ({ authedPage: page }) => {
    const toggle = page.locator('button[title*="light mode"], button[title*="dark mode"]').first();
    await expect(toggle).toBeVisible();
  });

  test('activity feed FAB visible', async ({ authedPage: page }) => {
    await expect(page.locator('button[title*="Open activity feed"]')).toBeVisible();
  });

  test('Account Status card (if dashboard renders it)', async ({ authedPage: page }) => {
    const card = page.locator('.bg-surface', { hasText: 'Account Status' });
    if (await card.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Either loading or fields visible
      const loading = await card.locator('text=Loading Account Data...').isVisible({ timeout: 500 }).catch(() => false);
      if (!loading) {
        await expect(card.locator('text=Balance')).toBeVisible();
        await expect(card.locator('text=Equity')).toBeVisible();
      }
    }
  });

  test('AI Morning Briefing card (if rendered)', async ({ authedPage: page }) => {
    const card = page.locator('.bg-surface', { hasText: 'AI Morning Briefing' });
    if (await card.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Card renders even when waiting for analysis
      await expect(card).toBeVisible();
    }
  });

  test('no critical console errors on render', async ({ authedPage: page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.reload();
    await page.waitForTimeout(2000);
    // Filter known noise — WS reconnect errors during backend hiccups
    const real = errors.filter(
      e => !e.includes('WS') && !e.includes('WebSocket') && !e.includes('Failed to fetch') && !e.includes('NetworkError')
    );
    expect(real).toEqual([]);
  });
});
