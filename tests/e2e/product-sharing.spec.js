import { test, expect } from './browser-fixture.js';

async function openPreview(page, path) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  const target = path === '/'
    ? page.locator('#trendingGrid .product-preview-button').first()
    : page.locator('#catalogProductGrid .catalog-product-image').first();
  await target.click();
  await expect(page.locator('#productModal')).toBeVisible();
  const share = page.getByRole('button', { name: 'Share product', exact: true });
  await expect(share).toBeEnabled();
  return share;
}

for (const path of ['/', '/products']) {
  test(`${path} preview opens real native sharing with the current canonical product link`, async ({ page }) => {
    await page.addInitScript(() => {
      window.sharedProducts = [];
      Object.defineProperty(navigator, 'share', { configurable: true,
        value: async data => { window.sharedProducts.push(data); } });
    });
    const share = await openPreview(page, path);
    const id = await share.getAttribute('data-share-product');
    const country = await page.locator('#productModal').getAttribute('data-share-country');
    await share.click();
    await expect.poll(() => page.evaluate(() => window.sharedProducts.length)).toBe(1);
    const data = await page.evaluate(() => window.sharedProducts[0]);
    const expected = new URL(`/products/${encodeURIComponent(id)}`, page.url());
    expected.searchParams.set('country', country);
    expect(data.url).toBe(expected.href);
    expect(data.title).toBeTruthy();
    expect(new URL(data.url).hash).toBe('');
    await expect(page.locator('#productShareFallback')).toBeHidden();
    await expect(share).toBeEnabled();
  });

  test(`${path} preview copies a shareable product link when native sharing is unsupported`, async ({ page }) => {
    await page.addInitScript(() => {
      window.copiedProductLinks = [];
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async value => { window.copiedProductLinks.push(value); } } });
    });
    const share = await openPreview(page, path);
    const id = await share.getAttribute('data-share-product');
    await share.click();
    await expect.poll(() => page.evaluate(() => window.copiedProductLinks.length)).toBe(1);
    const copied = await page.evaluate(() => window.copiedProductLinks[0]);
    expect(new URL(copied).pathname).toBe(`/products/${id}`);
    await expect(page.locator('[data-platform-flash-toast]')).toContainText('Product link copied');
    await expect(page.locator('#productShareFallback')).toBeHidden();
  });

  test(`${path} price-drop action has a clear gap below the question form`, async ({ page }) => {
    await openPreview(page, path);
    const watch = page.getByRole('button', { name: 'Watch price drops', exact: true });
    await watch.scrollIntoViewIfNeeded();
    const geometry = await page.locator('.preview-alert-actions').evaluate(actions => ({
      top: actions.getBoundingClientRect().top,
      formBottom: actions.previousElementSibling.getBoundingClientRect().bottom,
    }));
    expect(geometry.top - geometry.formBottom).toBeGreaterThanOrEqual(12);
  });
}

test('a direct server-rendered product page shares its product and market without tracking or preview parameters', async ({ page }) => {
  await page.addInitScript(() => {
    window.sharedProducts = [];
    Object.defineProperty(navigator, 'share', { configurable: true,
      value: async data => { window.sharedProducts.push(data); } });
  });
  const initialShare = await openPreview(page, '/products');
  const id = await initialShare.getAttribute('data-share-product');
  const country = await page.locator('#productModal').getAttribute('data-share-country');
  const path = `/products/${encodeURIComponent(id)}?country=${country}`;
  await page.goto(path + '&utm_source=sharing-regression#preview', { waitUntil: 'networkidle' });
  const share = page.getByRole('button', { name: 'Share product', exact: true });
  await expect(share).toBeEnabled();
  await share.click();
  await expect.poll(() => page.evaluate(() => window.sharedProducts.length)).toBe(1);
  const data = await page.evaluate(() => window.sharedProducts[0]);
  expect(data.url).toBe(new URL(path, page.url()).href);
});

test('cancelling native sharing does not copy, open a fallback or display a false success', async ({ page }) => {
  await page.addInitScript(() => {
    window.clipboardWrites = 0;
    Object.defineProperty(navigator, 'share', { configurable: true,
      value: async () => { throw new DOMException('User cancelled sharing', 'AbortError'); } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { window.clipboardWrites += 1; } } });
  });
  const share = await openPreview(page, '/products');
  await share.click();
  await expect(share).toBeEnabled();
  expect(await page.evaluate(() => window.clipboardWrites)).toBe(0);
  await expect(page.locator('#productShareFallback')).toBeHidden();
  await expect(page.locator('[data-platform-flash-toast]')).toBeHidden();
});

test('denied copying exposes a selectable link with working close and focus return', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } } });
    document.execCommand = () => false;
  });
  const share = await openPreview(page, '/products');
  const id = await share.getAttribute('data-share-product');
  await share.click();
  const fallback = page.locator('#productShareFallback');
  await expect(fallback).toBeVisible();
  const input = fallback.getByLabel('Share this product link', { exact: true });
  await expect(input).toBeFocused();
  expect(new URL(await input.inputValue()).pathname).toBe(`/products/${id}`);
  await expect(page.locator('[data-platform-flash-toast]')).toBeHidden();
  await input.press('Escape');
  await expect(fallback).toBeHidden();
  await expect(page.locator('#productModal')).toBeVisible();
  await expect(share).toBeFocused();
});

test('an old pending manual copy cannot close or refocus the next product share panel', async ({ page }) => {
  await page.addInitScript(() => {
    window.clipboardRequests = 0;
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: () => {
        window.clipboardRequests += 1;
        if (window.clipboardRequests === 2) return new Promise(resolve => { window.completeOldCopy = resolve; });
        return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      } } });
    document.execCommand = () => false;
  });
  const share = await openPreview(page, '/products');
  await share.click();
  const fallback = page.locator('#productShareFallback');
  await expect(fallback).toBeVisible();
  await fallback.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.clipboardRequests)).toBe(2);
  const related = page.locator('#previewRelatedGrid button[data-product-preview]').first();
  const nextId = await related.getAttribute('data-product-preview');
  await related.click();
  await expect(share).toHaveAttribute('data-share-product', nextId);
  await expect(share).toBeEnabled();
  await share.click();
  await expect(fallback).toBeVisible();
  const input = fallback.getByLabel('Share this product link', { exact: true });
  await expect(input).toBeFocused();
  const nextLink = await input.inputValue();
  expect(new URL(nextLink).pathname).toBe(`/products/${nextId}`);
  await page.evaluate(() => window.completeOldCopy());
  await expect(fallback).toBeVisible();
  await expect(input).toHaveValue(nextLink);
  await expect(input).toBeFocused();
  await expect(page.locator('[data-platform-flash-toast]')).toBeHidden();
});
