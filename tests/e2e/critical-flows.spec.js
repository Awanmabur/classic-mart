import { test, expect } from './browser-fixture.js';

const recoveryCodes = name => (process.env[name] || '').split(',').map(value => value.trim()).filter(Boolean);
const sellerAccount = {
  email: process.env.E2E_SELLER_EMAIL || '',
  password: process.env.E2E_SELLER_PASSWORD || '',
  recoveryCodes: recoveryCodes('E2E_SELLER_MFA_RECOVERY_CODES'),
  recoveryCodesVariable: 'E2E_SELLER_MFA_RECOVERY_CODES',
  path: '/seller/products', workspace: 'seller', label: 'Seller', heading: 'My Products',
};
const moderatorAccount = {
  email: process.env.E2E_MODERATOR_EMAIL || '',
  password: process.env.E2E_MODERATOR_PASSWORD || '',
  recoveryCodes: recoveryCodes('E2E_MODERATOR_MFA_RECOVERY_CODES'),
  recoveryCodesVariable: 'E2E_MODERATOR_MFA_RECOVERY_CODES',
  path: '/moderation/products', workspace: 'moderator', label: 'Moderator', heading: 'Product Moderation',
};

async function signIn(page, testInfo, account) {
  await page.goto('/login?next=' + encodeURIComponent(account.path));
  await page.getByLabel('Email address', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith('/login')),
    page.getByRole('button', { name: /Sign In to Classic Mart/i }).click(),
  ]);
  if (new URL(page.url()).pathname === '/mfa') {
    // Seller desktop smoke and mobile cards use separate one-time codes. Each
    // retry gets its own pair; Moderator has a separate account and code pool.
    const codeIndex = testInfo.retry * 2 + (testInfo.project.name.startsWith('mobile') ? 1 : 0);
    const recoveryCode = account.recoveryCodes[codeIndex];
    if (!recoveryCode) throw new Error(`Set ${account.recoveryCodesVariable} with unused recovery codes for the dedicated ${account.label} browser account.`);
    await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(recoveryCode);
    await Promise.all([
      page.waitForURL(url => url.pathname !== '/mfa'),
      page.getByRole('button', { name: 'Continue securely', exact: true }).click(),
    ]);
  }
  await expect(page).toHaveURL(url => url.pathname === account.path && !url.hash);
  await expect(page.locator('body')).toHaveAttribute('data-dashboard-workspace', account.workspace);
  await expect(page.locator('#profileButton small')).toHaveText(account.label);
  await expect(page.getByRole('heading', { name: account.heading, exact: true })).toBeVisible();
  await expect(page.locator('#roleSwitcher')).toHaveCount(0);
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

test('dedicated Seller signs in to its catalogue and cannot enter Moderation', async ({ page }, testInfo) => {
  test.skip(!sellerAccount.email || !sellerAccount.password, 'E2E_SELLER_EMAIL and E2E_SELLER_PASSWORD are required for Seller browser coverage.');
  test.skip(testInfo.project.name.startsWith('mobile'), 'Seller catalogue controls run once on desktop; the phone-card journey runs on mobile.');
  const failures = monitorBrowserFailures(page);
  await signIn(page, testInfo, sellerAccount);
  await expect(page.locator('#sidebar a[href="/seller/products"]')).toHaveText('Products');
  await expect(page.locator('#sidebar a[href^="/moderation/"]')).toHaveCount(0);
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
  const denied = await page.request.get('/moderation/products', { headers: { accept: 'application/json' } });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe('MODERATION_FORBIDDEN');
  await expect(page.locator('body')).toHaveAttribute('data-dashboard-workspace', 'seller');
  expect(failures).toEqual([]);
});

test('dedicated Moderator signs in to its catalogue and cannot enter the Seller workspace', async ({ page }, testInfo) => {
  test.skip(!moderatorAccount.email || !moderatorAccount.password, 'E2E_MODERATOR_EMAIL and E2E_MODERATOR_PASSWORD are required for Moderation browser coverage.');
  test.skip(testInfo.project.name.startsWith('mobile'), 'Authenticated Moderation catalogue smoke runs once on desktop.');
  const failures = monitorBrowserFailures(page);
  await signIn(page, testInfo, moderatorAccount);
  await expect(page.locator('#sidebar nav').getByRole('link', { name: 'Product Queue', exact: true })).toHaveAttribute('href', '/moderation/products');
  await expect(page.locator('#sidebar a[href^="/seller/"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Product review queue', exact: true })).toBeVisible();
  const denied = await page.request.get('/seller/products', { headers: { accept: 'application/json' } });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe('DASHBOARD_FORBIDDEN');
  await expect(page.locator('body')).toHaveAttribute('data-dashboard-workspace', 'moderator');
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

test('homepage search dropdown fills its panel with aligned results and keeps keyboard selection', async ({ page }, testInfo) => {
  const widths = testInfo.project.name.startsWith('mobile') ? [390, 320] : [1366];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/', { waitUntil: 'networkidle' });
    const search = page.getByRole('combobox', { name: 'Search products', exact: true });
    await search.fill('Classic');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    const options = list.getByRole('option');
    await expect(options.nth(1)).toBeVisible();
    const layout = await list.evaluate(node => {
      const panel = node.parentElement, box = node.getBoundingClientRect(), panelBox = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return { width: box.width, expectedWidth: panelBox.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
        boxes: [...node.querySelectorAll('[role="option"]')].map(option => {
          const rect = option.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, right: rect.right };
        }), left: box.left, right: box.right, overflow: panel.scrollWidth - panel.clientWidth };
    });
    expect(Math.abs(layout.width - layout.expectedWidth), `${width}px list fills the available panel`).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.boxes[0].y - layout.boxes[1].y), `${width}px results share a row`).toBeLessThanOrEqual(1);
    expect(layout.boxes[1].x).toBeGreaterThan(layout.boxes[0].right);
    for (const box of layout.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(layout.left - 1);
      expect(box.right).toBeLessThanOrEqual(layout.right + 1);
    }
    expect(layout.overflow).toBeLessThanOrEqual(1);
    await search.press('ArrowDown');
    await expect(search).toBeFocused();
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    const productName = await options.first().locator('strong').innerText();
    await search.press('Enter');
    await expect(page.getByRole('dialog', { name: productName, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(search).toBeFocused();
    await search.fill('no-matching-product-' + 'x'.repeat(90));
    await expect(page.locator('.no-suggestions')).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(0);
    const summaryOverflow = await page.locator('#searchSuggestions').evaluate(panel => panel.scrollWidth - panel.clientWidth);
    expect(summaryOverflow, `${width}px long empty-query summary stays inside the panel`).toBeLessThanOrEqual(1);
    await search.press('Escape');
    await expect(page.locator('#searchSuggestions')).not.toBeVisible();
  }
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
  test.skip(!sellerAccount.email || !sellerAccount.password, 'E2E_SELLER_EMAIL and E2E_SELLER_PASSWORD are required for Seller browser coverage.');
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Operational phone-card assertion runs in the mobile project.');
  await signIn(page, testInfo, sellerAccount);
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
  const remove = cartItem.getByRole('button', { name: `Remove ${productName} from cart`, exact: true });
  await remove.click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm deletion', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(cartItem).toBeVisible();
  await expect(remove).toBeFocused();
  const cancelled = await page.request.get('/api/v1/cart');
  expect(cancelled.status()).toBe(200);
  expect((await cancelled.json()).cart.items).toEqual(cart.items);
  await remove.click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(confirmation).toBeHidden();
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
