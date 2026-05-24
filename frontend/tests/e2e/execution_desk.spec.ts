import { test, expect } from '@playwright/test';

test.describe('Execution Desk', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/execution');
  });

  test('should render Open Positions table', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'Execution Desk' })).toBeVisible();
    await expect(page.locator('h3', { hasText: 'Active Orders (MT5)' })).toBeVisible();
    
    // Since it might be empty or full, we check for either "No active orders" or the layout
    const activeOrdersArea = page.locator('.bg-surface', { hasText: 'Active Orders (MT5)' });
    await expect(activeOrdersArea).toBeVisible();
  });

  test('should render Trade History table', async ({ page }) => {
    await expect(page.locator('h3', { hasText: 'Recent Closed Deals' })).toBeVisible();
    
    const historyArea = page.locator('.bg-surface', { hasText: 'Recent Closed Deals' });
    await expect(historyArea).toBeVisible();
  });
});
