import { test, expect } from '@playwright/test';

test.describe('Navigation and Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should render the top header with AlgoTrade title', async ({ page }) => {
    await expect(page.locator('h1', { hasText: 'AlgoTrade' })).toBeVisible();
    await expect(page.locator('text=Autonomous Hedge Fund Command Center')).toBeVisible();
  });

  test('should render WebSocket connection status', async ({ page }) => {
    // It should render either 'Live' or 'Disconnected' based on backend status
    const statusText = page.locator('header').locator('text=Live').or(page.locator('header').locator('text=Disconnected'));
    await expect(statusText).toBeVisible();
  });

  test('should navigate via Sidebar links', async ({ page }) => {
    // Navigate to Quant Screener
    await page.click('nav >> text=Quant Screener');
    await expect(page).toHaveURL(/.*\/quant/);
    await expect(page.locator('h2', { hasText: 'Quant & Technical Desk' })).toBeVisible();

    // Navigate to Execution Desk
    await page.click('nav >> text=Execution Desk');
    await expect(page).toHaveURL(/.*\/execution/);
    await expect(page.locator('h2', { hasText: 'Execution Desk' })).toBeVisible();

    // Navigate to Settings
    await page.click('nav >> text=Settings');
    await expect(page).toHaveURL(/.*\/settings/);
    await expect(page.locator('h1', { hasText: 'System Settings' })).toBeVisible();

    // Navigate back to Dashboard
    await page.click('nav >> text=Dashboard');
    await expect(page).toHaveURL(/.*\/$/);
    await expect(page.locator('h2', { hasText: 'Hedge Fund Dashboard' })).toBeVisible();
  });
});
