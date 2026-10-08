import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base = process.env.CLASSIC_MART_LIVE_BASE_URL;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
test('signup phone dropdown shows library country codes in the approved rounded control on desktop and mobile', { skip: !base || !executablePath }, async () => {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal((await page.goto(base + '/signup')).status(), 200);
      const selector = page.locator('[name="phoneCountry"]');
      assert.ok(await selector.locator('option').count() > 200);
      await selector.selectOption('US'); assert.match(await selector.locator('option:checked').textContent(), /^\+1/);
      await selector.selectOption('UG'); assert.match(await selector.locator('option:checked').textContent(), /^\+256/);
      assert.equal(await selector.evaluate(el => getComputedStyle(el.parentElement).borderRadius), '28px');
      assert.ok(await selector.evaluate(el => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight) >= 80));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  } finally { await browser.close(); }
});
