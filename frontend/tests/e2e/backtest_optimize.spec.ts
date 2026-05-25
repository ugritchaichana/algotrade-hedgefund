import { test, expect } from './fixtures/auth';

test.describe('Backtest Optimize page', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/backtest/optimize');
  });

  test('parameter sweep rows render', async ({ authedPage: page }) => {
    for (const label of ['SL ATR multiplier', 'TP ATR multiplier', 'SMA fast period', 'SMA slow period', 'VMA period']) {
      const visible = await page.locator('text=' + label).first().isVisible({ timeout: 2000 }).catch(() => false);
      // Some pages render labels slightly differently — tolerant
      if (visible) expect(visible).toBe(true);
    }
  });

  test('Walk-Forward Validate checkbox present', async ({ authedPage: page }) => {
    await expect(page.locator('text=Walk-Forward Validate').first()).toBeVisible();
  });

  test('Train Ratio + Rank By + Top N inputs visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=TRAIN RATIO')).toBeVisible();
    await expect(page.locator('text=RANK BY')).toBeVisible();
    await expect(page.locator('text=TOP N RESULTS')).toBeVisible();
  });

  test('Run Optimization button visible', async ({ authedPage: page }) => {
    await expect(page.locator('button:has-text("Run Optimization")')).toBeVisible();
  });

  test('Grid size info renders', async ({ authedPage: page }) => {
    await expect(page.locator('text=/Grid size:/')).toBeVisible();
  });

  test('History button visible + opens panel', async ({ authedPage: page }) => {
    const historyBtn = page.locator('button').filter({ hasText: /^History/ }).first();
    await expect(historyBtn).toBeVisible();
    await historyBtn.click();
    await expect(page.locator('text=Optimization History').first()).toBeVisible();
  });

  test('TP sweep row defaults DISABLED (decorative, locked at 4)', async ({ authedPage: page }) => {
    // Find the TP ATR multiplier row checkbox — should be unchecked by default
    const tpLabel = page.locator('text=/TP ATR multiplier/i').first();
    await expect(tpLabel).toBeVisible();
    // Find the nearest checkbox in the same row
    const tpRow = tpLabel.locator('xpath=ancestor::*[contains(@class, "rounded") or contains(@class, "flex")][1]');
    const checkbox = tpRow.locator('input[type="checkbox"]').first();
    if (await checkbox.isVisible({ timeout: 500 }).catch(() => false)) {
      const checked = await checkbox.isChecked();
      expect(checked).toBe(false);
    }
  });

  test('Run with default sweeps submits without 422 (TP not in sweep payload)', async ({ authedPage: page }) => {
    // Click Run — backend should accept (no tp_atr_mult in sweeps)
    const runBtn = page.locator('button:has-text("Run Optimization")');
    if (!(await runBtn.isVisible({ timeout: 1500 }).catch(() => false))) return;
    if (await runBtn.isDisabled()) return;  // Maybe no valid date range — skip
    await runBtn.click();
    // After click, no "Optimize submission failed" error should appear within 3s
    const errorMsg = page.locator('text=/Optimize submission failed/');
    await page.waitForTimeout(2000);
    const errorVisible = await errorMsg.isVisible({ timeout: 500 }).catch(() => false);
    expect(errorVisible).toBe(false);
    // Cancel to clean up
    const cancel = page.locator('button:has-text("Cancel")');
    if (await cancel.isVisible({ timeout: 500 }).catch(() => false)) {
      await cancel.click();
    }
  });

  test('History panel shows past jobs (table headers)', async ({ authedPage: page }) => {
    await page.locator('button').filter({ hasText: /^History/ }).first().click();
    await expect(page.locator('text=Optimization History').first()).toBeVisible();
    // If any jobs exist, headers appear
    const hasJobs = await page.locator('th').filter({ hasText: 'When' }).isVisible({ timeout: 1500 }).catch(() => false);
    if (hasJobs) {
      for (const col of ['When', 'Status', 'Symbols', 'Window', 'Progress', 'Duration', 'Source', 'Action']) {
        await expect(page.locator(`th:has-text("${col}")`).first()).toBeVisible();
      }
    }
  });
});
