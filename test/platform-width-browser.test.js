import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const styleNames = ['styles.css', 'storefront-pages.css', 'classic-ai.css', 'platform-polish.css'];
const css = new Map(await Promise.all(styleNames.map(async name => [name, await fs.readFile(new URL('../public/' + name, import.meta.url), 'utf8')])));
test('Cart and Classic AI match the storefront grid on desktop and phones and location input is a capsule', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const width of [1600, 1366, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('https://width.example/**', route => {
        const pathname = new URL(route.request().url()).pathname.slice(1);
        if (css.has(pathname)) return route.fulfill({ contentType: 'text/css', body: css.get(pathname) });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width">${styleNames.map(name => `<link rel="stylesheet" href="/${name}">`).join('')}</head><body class="classic-ai-page storefront-page"><header><div class="container">Marketplace header</div></header><main class="checkout-main page-shell">Cart</main><main class="classic-ai-shell">Classic AI</main><form id="locationForm"><input id="locationInput" aria-label="Delivery city"></form></body></html>` });
      });
      await page.goto('https://width.example/');
      const boxes = await page.locator('header .container, main').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }));
      for (const box of boxes) {
        assert.ok(Math.abs(box.width - boxes[0].width) <= 1, `${width}px shared widths`);
        assert.ok(Math.abs(box.left - boxes[0].left) <= 1, `${width}px shared gutters`);
        assert.ok(box.left >= 0 && box.right <= width, `${width}px within viewport`);
      }
      assert.equal(await page.locator('#locationInput').evaluate(element => getComputedStyle(element).borderRadius), '999px');
      await page.close();
    }
  } finally { await browser.close(); }
});
