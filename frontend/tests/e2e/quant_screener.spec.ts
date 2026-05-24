import { test, expect } from '@playwright/test';

test.describe('Quant Screener', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/quant');
  });

  test('should render Table headers', async ({ page }) => {
    await expect(page.locator('th', { hasText: 'Symbol' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Bias (D1)' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Action' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'RSI' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Confidence' })).toBeVisible();
  });

  test('should filter by dropdown', async ({ page }) => {
    const filterSelect = page.locator('select');
    await expect(filterSelect).toBeVisible();

    // Select Pending Signals
    await filterSelect.selectOption('SIGNAL');
    await expect(filterSelect).toHaveValue('SIGNAL');

    // Select Active Positions
    await filterSelect.selectOption('ACTIVE');
    await expect(filterSelect).toHaveValue('ACTIVE');
  });
});
