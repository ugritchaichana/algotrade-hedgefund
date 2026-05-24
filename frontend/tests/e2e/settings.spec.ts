import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
  });

  test('should test Asset Universe section', async ({ page }) => {
    // Check if the search input is visible
    const searchInput = page.getByPlaceholder(/Search MT5 symbols/i);
    await expect(searchInput).toBeVisible();
    
    // Check AI Suggest button
    const suggestBtn = page.locator('button', { hasText: /AI Suggest/i });
    await expect(suggestBtn).toBeVisible();
  });

  test('should input Discord Webhook URL', async ({ page }) => {
    const webhookInput = page.getByPlaceholder('https://discord.com/api/webhooks/...');
    await expect(webhookInput).toBeVisible();
    
    await webhookInput.fill('https://discord.com/api/webhooks/test-1234');
    await expect(webhookInput).toHaveValue('https://discord.com/api/webhooks/test-1234');
  });

  test('should toggle Auto Execution switch', async ({ page }) => {
    const autoExecBtn = page.locator('h3', { hasText: 'Auto Execution' }).locator('xpath=../..').locator('button');
    await expect(autoExecBtn).toBeVisible();
    
    // It starts off false (bg-surfaceLight) or true (bg-success)
    const isSuccess = await autoExecBtn.evaluate((el) => el.classList.contains('bg-success'));
    await autoExecBtn.click();
    
    if (isSuccess) {
      await expect(autoExecBtn).toHaveClass(/bg-surfaceLight/);
    } else {
      await expect(autoExecBtn).toHaveClass(/bg-success/);
    }
  });

  test('should show Toast notification on Save', async ({ page }) => {
    const saveBtn = page.locator('button', { hasText: 'Save Changes' });
    await expect(saveBtn).toBeVisible();
    
    await saveBtn.click();
    
    // Verify toast appears
    const toast = page.locator('text=Settings Saved Successfully');
    await expect(toast).toBeVisible();
    // Wait for it to disappear
    await expect(toast).toBeHidden({ timeout: 5000 });
  });
});
