import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const script = await fs.readFile(new URL('../public/loading-feedback.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../public/loading-feedback.css', import.meta.url), 'utf8');
test('first-visit splash follows real document loading, is centered and does not repeat on navigation', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
    let heldImage;
    await context.route('https://splash.example/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/loading.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/loading.css') return route.fulfill({ contentType: 'text/css', body: styles });
      if (url.pathname === '/slow-image') { heldImage = route; return; }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/loading.css"><script defer src="/loading.js"></script></head><body><main><h1>Classic Mart</h1><a href="/next">Next page</a><img src="/slow-image" alt=""></main></body></html>' });
    });
    const page = await context.newPage(); await page.goto('https://splash.example/', { waitUntil: 'domcontentloaded' });
    const splash = page.locator('[data-platform-loading]');
    await expect(splash).toBeVisible();
    await expect(splash).toHaveClass(/platform-loading--splash/);
    const centered = await splash.evaluate(element => { const box = element.getBoundingClientRect(); return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 1 && Math.abs(box.y + box.height / 2 - innerHeight / 2) < 1; });
    assert.equal(centered, true);
    assert.equal(await splash.locator('.platform-loading-spinner').evaluate(element => getComputedStyle(element).animationName), 'none');
    await heldImage.fulfill({ status: 204 });
    await page.waitForLoadState('load'); await expect(splash).toBeHidden();
    heldImage = null;
    await page.goto('https://splash.example/next', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.platform-loading--splash:not([hidden])').count(), 0);
    await heldImage.fulfill({ status: 204 });
    await page.waitForLoadState('load');
    await context.close();
  } finally { await browser.close(); }
});
