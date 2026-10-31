import { randomUUID, randomInt } from 'node:crypto';
import { test, expect } from './browser-fixture.js';

// These checks observe network requests and shopping controls. A server-rendered
// snapshot is a display optimization; opening a preview still needs fresh data.
function catalogueRequests(page) {
  const calls = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/storefront/catalogue' || url.pathname === '/api/v1/storefront/state') {
      calls.push(url.pathname + url.search);
    }
  });
  return calls;
}

async function openStorefront(page, path) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  const snapshot = await page.locator('#initialStorefrontData').evaluate(node => JSON.parse(node.textContent));
  expect(snapshot.country.code).toBeTruthy();
  expect(Array.isArray(snapshot.products)).toBe(true);
  expect(snapshot.products.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  return snapshot;
}

for (const path of ['/', '/products', '/categories', '/categories/electronics']) {
  test(`guest ${path} reuses the server catalogue without downloading it or personal state again`, async ({ page }) => {
    const calls = catalogueRequests(page);
    const snapshot = await openStorefront(page, path);
    const grid = path === '/' ? '#trendingGrid .product-card' : '#catalogProductGrid .catalog-product-card';
    await expect(page.locator(grid).first()).toBeVisible();
    expect(await page.locator(grid).count()).toBeGreaterThan(0);
    await expect(page.locator(grid).first()).toContainText(snapshot.products[0].name);
    expect(calls, 'the browser already received the public catalogue in this document').toEqual([]);
  });
}

test('homepage product titles are crawlable links and retain the approved product preview', async ({ page }) => {
  await openStorefront(page, '/');
  const link = page.locator('#trendingGrid .product-preview-button').first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/products\/[A-Za-z0-9_-]+\?country=[A-Z]{2}$/);
  await link.click();
  await expect(page.locator('#productModal')).toBeVisible();
  await expect(page.locator('#productModal [data-modal-add-cart]')).toBeVisible();
});

for (const path of ['/', '/products']) {
  test(`a valid empty catalogue on ${path} stays empty without retrying a full catalogue request`, async ({ page }) => {
    const calls = catalogueRequests(page);
    await page.route(url => url.pathname === path, async route => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      const html = await response.text();
      let replaced = false;
      const body = html.replace(/(<script\b[^>]*\bid="initialStorefrontData"[^>]*>)([\s\S]*?)(<\/script>)/, (_match, opening, json, closing) => {
        const snapshot = JSON.parse(json);
        snapshot.products = [];
        snapshot.categories = snapshot.categories.map(category => ({ ...category, count: 0 }));
        replaced = true;
        return opening + JSON.stringify(snapshot).replace(/</g, '\\u003c') + closing;
      });
      expect(replaced, 'this fixture changes only the public catalogue snapshot').toBe(true);
      await route.fulfill({ response, body });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response.status()).toBe(200);
    if (path === '/') {
      await expect(page.locator('#trendingGrid .product-card')).toHaveCount(0);
    } else {
      await expect(page.locator('#catalogEmpty')).toBeVisible();
      await expect(page.locator('#catalogResultCount')).toHaveText('0 products found');
    }
    expect(calls, 'zero products is a valid response, not a missing snapshot').toEqual([]);
  });
}

// Inline status regions can coexist with the shared transient toast. Assert
// the actual visible toast, rather than matching every flash-content span.
async function expectTransientToast(page, message) {
  const toast = page.locator('[data-platform-flash-toast]');
  await expect(toast).toHaveCount(1);
  await expect(toast).toBeVisible();
  await expect(toast.locator('.platform-flash-content')).toHaveText(message);
}

const previewTarget = (page, path) => path === '/'
  ? page.locator('#trendingGrid .product-preview-button').first()
  : page.locator('#catalogProductGrid .catalog-product-image').first();

for (const path of ['/', '/products']) {
  test(`${path} preview waits for fresh product details and displays the current price and stock`, async ({ page }) => {
    const calls = catalogueRequests(page);
    const snapshot = await openStorefront(page, path);
    let release;
    const waitForRelease = new Promise(resolve => { release = resolve; });
    let reportRequest;
    const requestReceived = new Promise(resolve => { reportRequest = resolve; });
    let freshProduct;
    await page.route('**/api/v1/storefront/products/*', async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const payload = await response.json();
      freshProduct = { ...payload.product, price: 12345, oldPrice: 12345, stock: 3,
        variants: payload.product.variants.map(variant => ({ ...variant, price: 12345, oldPrice: 12345, stock: 3 })) };
      reportRequest();
      await waitForRelease;
      await route.fulfill({ response, json: { ...payload, product: freshProduct } });
    });
    try {
      await previewTarget(page, path).click();
      await requestReceived;
      await expect(page.locator('#productModal [data-modal-add-cart]')).not.toBeVisible();
      release();
      await expect(page.locator('#productModal')).toBeVisible();
      const currentPrice = new Intl.NumberFormat(snapshot.country.locale, { style: 'currency', currency: freshProduct.currency }).format(12345);
      await expect(page.locator('#previewUnitPrice')).toHaveText(currentPrice);
      await expect(page.locator('#previewStockCount')).toHaveText('3 units ready to order');
      await expect(page.locator('#productModal [data-modal-add-cart]')).toBeEnabled();
      expect(calls, 'opening a preview does not refetch the complete catalogue').toEqual([]);
    } finally { release(); }
  });

  test(`${path} preview closes when fresh product details report that a listing was withdrawn`, async ({ page }) => {
    const calls = catalogueRequests(page);
    await openStorefront(page, path);
    let detailRequests = 0;
    await page.route('**/api/v1/storefront/products/*', async route => {
      detailRequests++;
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'PRODUCT_NOT_FOUND', message: 'This product is no longer available.',
      } }) });
    });
    await previewTarget(page, path).click();
    await expectTransientToast(page, 'This product is no longer available.');
    expect(detailRequests).toBe(1);
    await expect(page.locator('#productModal')).not.toBeVisible();
    await expect(page.locator('#productModal [data-modal-add-cart]')).not.toBeVisible();
    expect(calls).toEqual([]);
  });
}

test('signed-in catalogue hydration requests one lightweight saved-state response without a second product catalogue', async ({ page }) => {
  test.skip(process.env.E2E_IMAGE_SIGNUP !== 'true', 'Requires the owned simple-login browser fixture.');
  const identity = randomUUID(), password = `CatalogueState7-${identity}`;
  await page.goto('/signup');
  await page.locator('#signUpName').fill('Catalogue Hydration Customer');
  await page.locator('#signUpEmail').fill(`catalogue-hydration-${identity}@example.test`);
  await page.getByLabel('Phone country code').selectOption('UG');
  await page.locator('#signUpPhone').fill(`77${randomInt(1000000, 9999999)}`);
  await page.locator('#signUpPassword').fill(password);
  await page.locator('#signUpConfirmPassword').fill(password);
  await page.locator('#acceptTerms').check();
  await page.getByRole('button', { name: 'Create My Account', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const calls = catalogueRequests(page);
  const personalResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/storefront/state');
  await openStorefront(page, '/products');
  const response = await personalResponse;
  expect(response.status()).toBe(200);
  const personal = await response.json();
  expect(personal.state.wishlist).toEqual([]);
  expect(personal.products).toBeUndefined();
  expect(personal.recommendations).toBeUndefined();
  expect(calls).toEqual(['/api/v1/storefront/state?summary=1']);
});

test('guest cart and its shared header use one catalogue request while preserving a real cart item', async ({ page }) => {
  await openStorefront(page, '/products');
  const add = page.locator('[data-catalog-add]:not([disabled])').first();
  const productName = await add.locator('xpath=ancestor::article').locator('h3').textContent();
  await add.click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  const calls = catalogueRequests(page);
  const response = await page.goto('/cart', { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  await expect(page.locator('.cart-page-item')).toHaveCount(1);
  await expect(page.locator('.cart-page-item')).toContainText(productName);
  expect(calls).toEqual(['/api/v1/storefront/catalogue']);
});

test('switching an open homepage preview removes old purchase controls until the related product is refreshed', async ({ page }) => {
  await openStorefront(page, '/');
  await previewTarget(page, '/').click();
  await expect(page.locator('#productModal [data-modal-add-cart]')).toBeVisible();
  const related = page.locator('#productModal .preview-related-card .product-preview-button').first();
  await expect(related).toBeVisible();
  let release, received;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { received = resolve; });
  await page.route('**/api/v1/storefront/products/*', async route => {
    received();
    await pending;
    await route.fulfill({ status: 404, contentType: 'application/json', json: { error: { message: 'Related listing was withdrawn.' } } });
  });
  try {
    await related.click();
    await started;
    await expect(page.locator('#productModal [data-modal-add-cart]')).not.toBeVisible();
    await expect(page.locator('#productModalShare')).toBeDisabled();
    await expect(page.locator('#productModalWishlist')).toBeDisabled();
    await expect(page.locator('#productModal [role="status"]')).toContainText('Loading product preview');
    release();
    await expectTransientToast(page, 'Related listing was withdrawn.');
    await expect(page.locator('#productModal')).not.toBeVisible();
  } finally { release(); }
});

test('a late failed homepage preview cannot close or replace a newer successful preview', async ({ page }) => {
  await openStorefront(page, '/');
  const buttons = page.locator('#trendingGrid .product-preview-button');
  const oldId = await buttons.nth(0).getAttribute('data-product-preview');
  const currentId = await buttons.nth(1).getAttribute('data-product-preview');
  const currentName = await buttons.nth(1).textContent();
  expect(currentId).not.toBe(oldId);
  let release, received;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { received = resolve; });
  await page.route('**/api/v1/storefront/products/*', async route => {
    if (!new URL(route.request().url()).pathname.endsWith('/' + oldId)) return route.continue();
    received();
    await pending;
    await route.fulfill({ status: 404, contentType: 'application/json', json: { error: { message: 'Superseded preview failed.' } } });
  });
  try {
    await buttons.nth(0).click();
    await started;
    await expect(page.locator('#productModal [role="status"]')).toContainText('Loading product preview');
    await page.keyboard.press('Escape');
    await expect(page.locator('#productModal')).not.toBeVisible();
    await buttons.nth(1).click();
    await expect(page.locator('#productModalTitle')).toHaveText(currentName);
    await expect(page.locator('#productModal [data-modal-add-cart]')).toHaveAttribute('data-modal-add-cart', currentId);
    const settled = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/' + oldId) && response.status() === 404);
    release();
    await settled;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#productModalTitle')).toHaveText(currentName);
    await expect(page.locator('#productModal')).toBeVisible();
    await expect(page.locator('#productModal [data-modal-add-cart]')).toBeEnabled();
    await expect(page.locator('.platform-flash-content').filter({ hasText: 'Superseded preview failed.' })).toHaveCount(0);
  } finally { release(); }
});
