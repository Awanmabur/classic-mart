import { test, expect } from './browser-fixture.js';

for (const path of ['/', '/products', '/cart']) {
  test(path + ' keeps image fallbacks working without CSP inline-handler violations', async ({ page }) => {
    const violations = [];
    page.on('console', message => {
      if (/script-src-attr|executing inline event handler/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);

    await page.evaluate(() => {
      const image = document.createElement('img');
      image.id = 'csp-fallback-probe';
      image.setAttribute('data-fallback-src', '/assets/product-placeholder.svg');
      image.src = '/__classic_mart_csp_probe_missing__.png';
      document.body.appendChild(image);
    });
    const image = page.locator('#csp-fallback-probe');
    await expect(image).toHaveAttribute('data-classic-mart-image-fallback', 'true');
    await expect(image).toHaveAttribute('src', '/assets/product-placeholder.svg');
    await expect(image).toHaveJSProperty('complete', true);
    expect(violations).toEqual([]);
  });
}
