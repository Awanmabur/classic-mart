import { test, expect } from '@playwright/test';

const adminEmail = process.env.ADMIN_EMAIL || 'admin@classicmart.local';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminRecoveryCodes = (process.env.E2E_ADMIN_MFA_RECOVERY_CODES || '').split(',').map(value => value.trim()).filter(Boolean);

async function signIn(page, testInfo) {
  await page.goto('/login?next=%2Fseller%2Fproducts');
  await page.getByLabel('Email address', { exact: true }).fill(adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(adminPassword);
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith('/login')),
    page.getByRole('button', { name: /Sign In to Classic Mart/i }).click(),
  ]);
  if (new URL(page.url()).pathname === '/mfa') {
    // Each project/retry consumes a different code from the ephemeral browser fixture.
    const codeIndex = testInfo.retry * 2 + (testInfo.project.name.startsWith('mobile') ? 1 : 0);
    const recoveryCode = adminRecoveryCodes[codeIndex];
    if (!recoveryCode) throw new Error('Set E2E_ADMIN_MFA_RECOVERY_CODES with unused recovery codes for the seeded browser account.');
    await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(recoveryCode);
    await Promise.all([
      page.waitForURL(url => url.pathname !== '/mfa'),
      page.getByRole('button', { name: 'Continue securely', exact: true }).click(),
    ]);
  }
  await expect(page).toHaveURL(/\/seller\/products$/);
  await expect(page.getByRole('heading', { name: 'My Products', exact: true })).toBeVisible();
}

function monitorBrowserFailures(page) {
  const failures = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  return failures;
}

async function holdProductDetail(page, productId) {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const pathname = `/api/v1/storefront/products/${encodeURIComponent(productId)}`;
  await page.route(url => url.pathname === pathname, async route => {
    try {
      const response = await route.fetch();
      ready.resolve(response.status());
      await release.promise;
      await route.fulfill({ response });
    } catch (error) {
      ready.reject(error);
      throw error;
    }
  });
  return { ready: ready.promise, release: () => release.resolve() };
}

test('public catalogue survives search, refresh and browser back navigation', async ({ page }) => {
  const failures = monitorBrowserFailures(page);
  await page.goto('/products', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Browse products/i);
  const firstProduct = page.locator('.catalog-product-card h3').first();
  await expect(firstProduct).toBeVisible();
  const productName = await firstProduct.innerText();
  const search = page.locator('input#searchInput');
  await expect(search).toBeVisible();
  await expect(search).toHaveAccessibleName('Search products');
  await search.fill(productName);
  await search.press('Enter');
  await expect(page).toHaveURL(url => url.searchParams.get('q') === productName);
  await expect(page.locator('.catalog-product-card h3').filter({ hasText: productName }).first()).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.catalog-product-card h3').filter({ hasText: productName }).first()).toBeVisible();
  await page.goto('/login');
  await page.goBack({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/products/);
  await expect(page.locator('input#searchInput')).toHaveValue(productName);
  expect(failures).toEqual([]);
});

test('seeded privileged account can sign in and reach scoped seller and moderation catalogue workspaces', async ({ page }, testInfo) => {
  test.skip(!adminPassword, 'ADMIN_PASSWORD is required for authenticated browser coverage.');
  if (testInfo.project.name.startsWith('mobile')) test.skip(true, 'Authenticated control-plane smoke runs once on desktop.');
  const failures = monitorBrowserFailures(page);
  await signIn(page, testInfo);
  await page.locator('#pageHost').getByRole('link', { name: 'Add Product', exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/products\/new$/);
  await expect(page.getByRole('heading', { name: 'Add a Product', exact: true })).toBeVisible();
  const createForm = page.locator('#pageHost form[action="/seller/products"]');
  await expect(createForm).toBeVisible();
  await expect(createForm.getByLabel('Product name', { exact: true })).toBeVisible();
  const category = createForm.locator('select[name="categoryPublicId"]');
  await expect(category).toBeVisible();
  await expect(category).toHaveAccessibleName('Category');
  expect(await category.locator('option:not([value=""])').count()).toBeGreaterThan(0);
  await expect(createForm.getByRole('button', { name: 'Save Product', exact: true })).toBeVisible();
  const response = await page.goto('/moderation/products', { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Product Review', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Awaiting product review', exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test('mobile storefront does not create horizontal page overflow and exposes mobile search', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Mobile-only layout assertion.');
  await page.goto('/', { waitUntil: 'networkidle' });
  const homepageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(homepageOverflow).toBeLessThanOrEqual(2);
  const search = page.locator('input#searchInput');
  await expect(search).toBeVisible();
  await expect(search).toHaveAccessibleName('Search products');
  await search.fill('Classic');
  await search.press('Enter');
  await expect(page).toHaveURL(url => ['/products', '/search'].includes(url.pathname) && url.searchParams.get('q') === 'Classic');
  await expect(page.locator('#catalogTitle')).toBeVisible();
  await expect(page.locator('#catalogResultCount')).not.toContainText('Loading');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});

test('double activation of navigation does not create duplicate browser errors', async ({ page }) => {
  const failures = monitorBrowserFailures(page);
  await page.goto('/');
  const viewProducts = page.locator('button[data-view-products="trending"]');
  await expect(viewProducts).toBeVisible();
  await viewProducts.dblclick();
  await expect(page).toHaveURL(url => url.pathname === '/products' && url.searchParams.get('view') === 'trending');
  await page.waitForLoadState('domcontentloaded');
  expect(failures).toEqual([]);
});


test('authenticated seller product tables become labelled phone cards without page overflow', async ({ page }, testInfo) => {
  test.skip(!adminPassword, 'ADMIN_PASSWORD is required for authenticated browser coverage.');
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Operational phone-card assertion runs in the mobile project.');
  await signIn(page, testInfo);
  const responsiveCells = page.locator('.seller-product-page .role-table tbody td:not([colspan])');
  await expect(responsiveCells.first()).toBeVisible();
  const labels = await responsiveCells.evaluateAll(cells => cells.map(cell => ({
    label: cell.dataset.label || '',
    display: getComputedStyle(cell).display,
    renderedLabel: getComputedStyle(cell, '::before').content,
  })));
  expect(labels.length).toBeGreaterThan(0);
  for (const cell of labels) {
    expect(cell.label).toMatch(/\S+/);
    expect(cell.renderedLabel).toContain(cell.label);
    expect(cell.display).not.toBe('table-cell');
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});

test('guest cart changes persist on the server across reloads', async ({ page }) => {
  const failures = monitorBrowserFailures(page);
  await page.goto('/products', { waitUntil: 'networkidle' });
  const addButton = page.locator('[data-catalog-add]:not([disabled])').first();
  await expect(addButton).toBeVisible();
  const productName = await addButton.locator('xpath=ancestor::article').locator('h3').innerText();
  await addButton.click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  await page.goto('/cart', { waitUntil: 'networkidle' });
  const cartItem = page.locator('.cart-page-item').filter({ has: page.getByRole('heading', { name: productName, exact: true }) });
  await expect(cartItem).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(cartItem).toBeVisible();
  const persisted = await page.request.get('/api/v1/cart');
  expect(persisted.status()).toBe(200);
  const { cart } = await persisted.json();
  expect(cart.items).toHaveLength(1);
  expect(cart.items[0].name).toBe(productName);
  expect(cart.items[0].quantity).toBe(1);
  await cartItem.getByRole('button', { name: `Remove ${productName} from cart`, exact: true }).click();
  await expect(page.locator('#cartEmptyPage')).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#cartEmptyPage')).toBeVisible();
  const cleared = await page.request.get('/api/v1/cart');
  expect(cleared.status()).toBe(200);
  expect((await cleared.json()).cart.items).toEqual([]);
  expect(failures).toEqual([]);
});

test('closing a pending homepage product preview prevents a delayed response from reopening it', async ({ page }) => {
  const failures = monitorBrowserFailures(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  const preview = page.locator('#trendingGrid .product-preview-button').first();
  const delayed = await holdProductDetail(page, await preview.getAttribute('data-product-preview'));
  try {
    await preview.focus();
    await page.keyboard.press('Enter');
    expect(await delayed.ready).toBe(200);
    await page.keyboard.press('Escape');
    await expect(page.locator('#productModal')).not.toBeVisible();
    delayed.release();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#productModal')).not.toBeVisible();
    await expect(preview).toBeFocused();
    expect(failures).toEqual([]);
  } finally {
    delayed.release();
  }
});

test('a delayed catalogue preview cannot replace the newer product selection', async ({ page }) => {
  const failures = monitorBrowserFailures(page);
  await page.goto('/products', { waitUntil: 'networkidle' });
  const cards = page.locator('.catalog-product-card');
  await expect(cards.nth(1)).toBeVisible();
  const firstId = await cards.first().getAttribute('data-product-id');
  const secondId = await cards.nth(1).getAttribute('data-product-id');
  const secondName = await cards.nth(1).locator('h3').innerText();
  expect(secondId).not.toBe(firstId);
  const delayed = await holdProductDetail(page, firstId);
  try {
    await cards.first().locator('.catalog-product-image').click();
    expect(await delayed.ready).toBe(200);
    await page.keyboard.press('Escape');
    await expect(page.locator('#productModal')).not.toBeVisible();
    await cards.nth(1).locator('.catalog-product-image').click();
    await expect(page.getByRole('dialog', { name: secondName, exact: true })).toBeVisible();
    delayed.release();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('dialog', { name: secondName, exact: true })).toBeVisible();
    await expect(page.locator('#productModal [data-modal-add-cart]')).toHaveAttribute('data-modal-add-cart', secondId);
    expect(failures).toEqual([]);
  } finally {
    delayed.release();
  }
});
