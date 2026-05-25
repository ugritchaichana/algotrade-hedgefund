import { test, expect } from './fixtures/auth';

test.describe('Dark/Light theme', () => {
  test('default theme is dark (data-theme attribute)', async ({ authedPage: page }) => {
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('dark');
  });

  test('clicking sun/moon toggle flips theme + persists', async ({ authedPage: page }) => {
    // Find theme toggle button (next to STOP AUTO-TRADE button)
    const toggle = page.locator('button[title*="light mode"], button[title*="dark mode"]').first();
    await expect(toggle).toBeVisible();

    // Initial: dark
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');

    // Flip to light
    await toggle.click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');

    // localStorage persisted
    const stored = await page.evaluate(() => window.localStorage.getItem('algotrade_theme'));
    expect(stored).toBe('light');

    // Flip back
    await toggle.click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
  });

  test('background color changes between modes (visual smoke)', async ({ authedPage: page }) => {
    const body = page.locator('body');
    const darkBg = await body.evaluate((el) => window.getComputedStyle(el).backgroundColor);

    await page.locator('button[title*="light mode"]').first().click();
    const lightBg = await body.evaluate((el) => window.getComputedStyle(el).backgroundColor);

    expect(darkBg).not.toBe(lightBg);

    // Restore dark
    await page.locator('button[title*="dark mode"]').first().click();
  });
});
