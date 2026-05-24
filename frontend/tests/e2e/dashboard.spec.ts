import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should render Account Status with metrics', async ({ page }) => {
    const accountCard = page.locator('.bg-surface', { hasText: 'Account Status' });
    await expect(accountCard).toBeVisible();
    
    // Check if it's either rendering data or the loading state
    const isLoading = await accountCard.locator('text=Loading Account Data...').isVisible();
    if (!isLoading) {
      await expect(accountCard.locator('text=Balance')).toBeVisible();
      await expect(accountCard.locator('text=Equity')).toBeVisible();
      await expect(accountCard.locator('text=Free Margin')).toBeVisible();
      await expect(accountCard.locator('text=Margin Level')).toBeVisible();
    }
  });

  test('should render Intermarket Flow component', async ({ page }) => {
    const flowCard = page.locator('.bg-surface', { hasText: 'Intermarket Flow' });
    await expect(flowCard).toBeVisible();
    await expect(flowCard.locator('text=US30 (Equities)')).toBeVisible();
    await expect(flowCard.locator('text=XAUUSD (Safe Haven)')).toBeVisible();
  });

  test('should render AI Morning Briefing', async ({ page }) => {
    const aiCard = page.locator('.bg-surface', { hasText: 'AI Morning Briefing' });
    await expect(aiCard).toBeVisible();
    
    // Check if it's waiting for analysis or rendering results
    const isWaiting = await aiCard.locator('text=Waiting for AI analysis...').isVisible();
    if (!isWaiting) {
      // Expect some bias badge
      await expect(aiCard.locator('span', { hasText: /(Risk-On|Risk-Off|Neutral|Unknown)/i }).first()).toBeVisible();
    }
  });
});
