import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const motion = await fs.readFile(new URL('../public/platform-motion.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../public/platform-motion.css', import.meta.url), 'utf8');

test('scroll entrances cover storefront and dashboard cards, dynamic content, focus and motion preferences', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const dashboard of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent(`<html><head><style>body{margin:0;overflow-x:hidden}main{padding:20px}article{height:130px;margin:20px 0;padding:16px;background:#eee}button{margin:10px}.spacer{height:900px}${css}</style></head><body ${dashboard ? 'data-dashboard-workspace="customer"' : ''}><main><h1>Marketplace</h1><div class="spacer"></div>${['up','down','left','right','zoom','zoom-out','drop'].map((name, i) => `<article id="card${i}" class="${dashboard ? 'stat-card panel' : 'product-card'}" data-scroll-motion="${name}"><button>Open ${i}</button></article>`).join('')}<section id="closed" hidden><article class="panel" id="unhidden">Later dashboard page</article></section></main></body></html>`);
      await page.mouse.move(380, 5);
      await page.evaluate(() => { window.motionStarts = []; document.addEventListener('animationstart', event => { if (event.animationName.startsWith('cmEntrance')) window.motionStarts.push({ id: event.target.id, name: event.animationName }); }); });
      await page.addScriptTag({ content: motion });
      assert.equal(await page.locator('#card0').evaluate(element => getComputedStyle(element).opacity), '1', 'offscreen content is never pre-hidden');
      await page.locator('#card0').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'card0'))).toBe(true);
      await expect(page.locator('#card0')).not.toHaveClass(/platform-motion-enter/, { timeout: 2000 });
      await page.locator('#card5').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.name === 'cmEntranceZoomOut'))).toBe(true);
      await page.locator('#card6').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'card6'))).toBe(true);
      await page.locator('#card6 button').focus();
      await expect(page.locator('#card6')).not.toHaveClass(/platform-motion-enter/);
      await page.evaluate(() => { document.activeElement.blur(); const card = document.createElement('article'); card.id = 'dynamic'; card.className = 'panel'; card.textContent = 'New live data'; document.querySelector('main').append(card); });
      await page.locator('#dynamic').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'dynamic'))).toBe(true);
      await page.evaluate(() => { document.querySelector('#closed').hidden = false; });
      await page.locator('#unhidden').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'unhidden'))).toBe(true);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.locator('.platform-motion-enter')).toHaveCount(0);
      assert.equal(await page.locator('#unhidden').evaluate(element => getComputedStyle(element).opacity), '1');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'directional effects never introduce horizontal scrolling');
      assert.deepEqual(errors, []);
      await page.close();
    }
    const lowData = await browser.newPage();
    await lowData.setContent(`<html data-low-data="true"><head><style>${css}</style></head><body><main><article class="panel">Visible content</article></main></body></html>`);
    await lowData.addScriptTag({ content: motion });
    assert.equal(await lowData.locator('.platform-motion-enter').count(), 0);
    assert.equal(await lowData.locator('article').evaluate(element => getComputedStyle(element).opacity), '1');
    await lowData.close();
  } finally { await browser.close(); }
});
