import { test, expect } from './fixtures/auth';

test.describe('Command Palette (Cmd+K)', () => {
  test('opens with Ctrl+K and closes with Escape', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+K');
    await expect(page.locator('input[placeholder*="Search pages"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('input[placeholder*="Search pages"]')).not.toBeVisible();
  });

  test('typing filters results', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+K');
    const input = page.locator('input[placeholder*="Search pages"]');
    await input.fill('journal');
    // Should show "Trade Journal" navigation item
    await expect(page.locator('[role="option"], [cmdk-item]', { hasText: /Trade Journal/i })).toBeVisible();
  });

  test('navigates to Trade Journal via palette', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+K');
    await page.locator('input[placeholder*="Search pages"]').fill('Trade Journal');
    // Click first result
    await page.locator('[cmdk-item], [role="option"]').filter({ hasText: /Trade Journal/i }).first().click();
    await expect(page).toHaveURL(/\/journal/);
  });

  test('toggle theme action works from palette', async ({ authedPage: page }) => {
    const before = await page.locator('html').getAttribute('data-theme');
    await page.keyboard.press('Control+K');
    await page.locator('input[placeholder*="Search pages"]').fill('toggle theme');
    await page.locator('[cmdk-item], [role="option"]').filter({ hasText: /Toggle Theme/i }).first().click();
    await page.waitForTimeout(200);
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);
  });

  test('clicking backdrop closes palette', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+K');
    await expect(page.locator('input[placeholder*="Search pages"]')).toBeVisible();
    // Click the backdrop (the overlay container)
    await page.locator('div.fixed.inset-0').first().click({ position: { x: 10, y: 10 } });
    await expect(page.locator('input[placeholder*="Search pages"]')).not.toBeVisible();
  });
});
