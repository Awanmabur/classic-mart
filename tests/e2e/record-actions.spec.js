import { randomUUID, randomInt } from 'node:crypto';
import { test, expect } from './browser-fixture.js';

const previewPath = '/seller/products/record_modal_fixture';
const previewHtml = (title = 'Current product', version = '3') => `<!doctype html><html><body><main id="pageHost"><section data-record-detail>
  <h1>Authorized product details</h1><p>Additional server data</p>
  <form method="post" action="${previewPath}/update"><input type="hidden" name="_csrf" value="fixture-csrf"><input type="hidden" name="version" value="${version}">
    <input type="hidden" name="action" value="update"><input type="hidden" name="method" value="manual"><input type="hidden" name="enctype" value="preserved">
    <label for="recordTitle">Product title</label><input id="recordTitle" name="title" value="${title}" required>
    <button type="submit">Save product</button></form></section></main></body></html>`;

async function addPreviewLink(page) {
  await page.evaluate(path => {
    const table = document.createElement('table');
    table.innerHTML = '<tbody><tr><td>Selected product</td><td data-label="Action"><a class="role-row-menu" aria-label="View selected product" data-record-title="Selected product"></a></td></tr></tbody>';
    table.querySelector('a').href = path;
    document.querySelector('main').prepend(table);
    window.ClassicMartRecordActions.enhance(table);
  }, previewPath);
  const link = page.getByRole('link', { name: 'View selected product', exact: true });
  await expect(link.locator('svg')).toHaveCount(1);
  return link;
}

async function registerCustomer(page) {
  await page.goto('/signup');
  const suffix = randomUUID();
  await page.locator('#signUpName').fill('Record Actions Customer');
  await page.locator('#signUpEmail').fill(`record-actions-${suffix}@example.test`);
  await page.getByLabel('Phone country code').selectOption('UG');
  await page.locator('#signUpPhone').fill(`77${randomInt(1000000, 9999999)}`);
  await page.locator('#signUpPassword').fill(`RecordActions7-${suffix}`);
  await page.locator('#signUpConfirmPassword').fill(`RecordActions7-${suffix}`);
  await page.locator('#acceptTerms').check();
  await page.getByRole('button', { name: 'Create My Account', exact: true }).click();
  await expect(page).not.toHaveURL(url => url.pathname === '/signup');
  if (new URL(page.url()).pathname === '/verify-email') {
    const code = (await page.locator('body').innerText()).match(/Development verification code:\s*(\d{6})/)?.[1];
    expect(code, 'The owned test fixture must expose its development email code.').toBeTruthy();
    await page.getByLabel('Verification code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Verify My Email', exact: true }).click();
  }
  if (new URL(page.url()).pathname === '/onboarding') {
    await page.locator('input[name="role"][value="customer"]').check();
    await page.getByRole('button', { name: 'Complete Secure Setup', exact: true }).click();
  }
  await expect(page).toHaveURL(url => url.pathname === '/dashboard');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect.poll(() => page.evaluate(() => Boolean(window.ClassicMartRecordActions))).toBe(true);
});

test('record previews use current server data, preserve edit fields and save a real modal form response', async ({ page }) => {
  let saved = null;
  await page.route(`**${previewPath}`, route => route.fulfill({ contentType: 'text/html', body: previewHtml() }));
  await page.route(`**${previewPath}/update`, async route => {
    const request = route.request();
    saved = new URLSearchParams(request.postData());
    await route.fulfill({ contentType: 'text/html', body: previewHtml('Updated product', '4') });
  });
  const opener = await addPreviewLink(page);
  await opener.click();
  const modal = page.locator('.record-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAccessibleName('Selected product');
  await expect(page).toHaveURL(url => url.pathname === previewPath);
  await expect(modal).toContainText('Additional server data');
  const field = modal.getByLabel('Product title', { exact: true });
  await expect(field).toHaveValue('Current product');
  await expect(field).not.toBeEditable();
  expect(await field.getAttribute('id')).toMatch(/^record-\d+-recordTitle$/);
  await modal.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(field).toBeEditable();
  await field.fill('Updated product');
  await modal.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(modal.getByLabel('Product title', { exact: true })).toHaveValue('Updated product');
  expect(saved.get('_csrf')).toBe('fixture-csrf');
  expect(saved.get('version')).toBe('3');
  expect(saved.get('title')).toBe('Updated product');
  expect(saved.get('action')).toBe('update');
  expect(saved.get('method')).toBe('manual');
  expect(saved.get('enctype')).toBe('preserved');
  await Promise.all([
    page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === '/'),
    page.goBack(),
  ]);
  await expect(page).toHaveURL(url => url.pathname === '/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('record preview sanitization excludes active content and restores background focus on close', async ({ page }) => {
  const malicious = previewHtml().replace('</section>', `
    <script>window.recordPreviewInjected=true</script><iframe src="https://record-actions-attacker.invalid/frame"></iframe>
    <img src="https://record-actions-attacker.invalid/pixel" onerror="window.recordPreviewInjected=true">
    <a href="javascript:window.recordPreviewInjected=true">Unsafe link</a>
    <form action="https://record-actions-attacker.invalid/save" method="post"><input name="private" value="fixture-only"></form>
    </section>`);
  let external = 0;
  await page.route('https://record-actions-attacker.invalid/**', route => { external++; return route.abort(); });
  await page.route(`**${previewPath}`, route => route.fulfill({ contentType: 'text/html', body: malicious }));
  const opener = await addPreviewLink(page);
  await opener.click();
  const modal = page.locator('.record-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('script, iframe, [onerror], [href^="javascript:"], [action^="https://record-actions-attacker.invalid"]')).toHaveCount(0);
  await expect(modal.locator('img')).not.toHaveAttribute('src');
  expect(await page.evaluate(() => window.recordPreviewInjected)).toBeUndefined();
  expect(external).toBe(0);
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
  await expect(page).toHaveURL(url => url.pathname === '/');
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.querySelector('main').inert)).toBe(false);
  expect(await page.evaluate(() => window.ClassicMartRecordActions.open('https://record-actions-attacker.invalid/seller/products/foreign'))).toBe(false);
});

test('unaccepted and oversized record responses never display private or partial details', async ({ page }) => {
  let status = 403;
  await page.route(`**${previewPath}`, route => route.fulfill({ status, contentType: 'text/html', body: status === 403
    ? '<main id="pageHost">PRIVATE_OTHER_ACCOUNT_VALUE</main>' : previewHtml() + 'x'.repeat(2_100_000) }));
  const opener = await addPreviewLink(page);
  await opener.click();
  const modal = page.locator('.record-modal');
  await expect(modal.getByRole('alert')).toContainText('no longer have access');
  await expect(modal).not.toContainText('PRIVATE_OTHER_ACCOUNT_VALUE');
  await modal.getByRole('button', { name: 'Close record', exact: true }).click();
  status = 200;
  await opener.click();
  await expect(modal.getByRole('alert')).toContainText('too large');
  await expect(modal.getByLabel('Product title', { exact: true })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Close record', exact: true }).click();
});

test('real cart removal requires confirmation, cancellation leaves state intact and Continue mutates once', async ({ page }) => {
  await page.goto('/products', { waitUntil: 'networkidle' });
  await page.locator('[data-catalog-add]:not([disabled])').first().click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  await page.goto('/cart', { waitUntil: 'networkidle' });
  const remove = page.locator('[data-remove-item]').first();
  await expect(remove).toBeVisible();
  let removals = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && /\/api\/v1\/cart\/items\//.test(request.url())) removals++; });
  await remove.click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm deletion', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(removals).toBe(0);
  expect((await (await page.request.get('/api/v1/cart')).json()).cart.items).toHaveLength(1);
  await expect(remove).toBeFocused();
  await remove.click();
  await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('[data-remove-item]')).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/cart')).json()).cart.items).toHaveLength(0);
  expect(removals).toBe(1);
});

test('a changed deletion target is not submitted using an earlier confirmation', async ({ page }) => {
  await page.evaluate(() => {
    const form = document.createElement('form'); form.method = 'post'; form.action = '/addresses/fixture-address/archive';
    form.id = 'recordDeleteFixture';
    form.innerHTML = '<input name="version" type="hidden" value="1"><button type="submit">Delete fixture</button>';
    document.querySelector('main').append(form);
    window.recordDeleteSubmits = 0;
    form.addEventListener('submit', event => { event.preventDefault(); window.recordDeleteSubmits++; });
  });
  const button = page.getByRole('button', { name: 'Delete fixture', exact: true });
  await button.click();
  await page.locator('#recordDeleteFixture input[name="version"]').evaluate(element => { element.value = '2'; });
  const confirmation = page.getByRole('dialog', { name: 'Confirm deletion', exact: true });
  await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(await page.evaluate(() => window.recordDeleteSubmits)).toBe(0);
  await button.click();
  await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(await page.evaluate(() => window.recordDeleteSubmits)).toBe(1);
});

test('reused deletion buttons require a new confirmation for the current item', async ({ page }) => {
  await page.evaluate(() => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.removeItem = 'old-line';
    button.textContent = 'Remove selected line'; button.id = 'recordClickDeleteFixture';
    document.querySelector('main').append(button);
    window.recordDeleteClicks = [];
    button.addEventListener('click', () => window.recordDeleteClicks.push(button.dataset.removeItem));
  });
  const button = page.getByRole('button', { name: 'Remove selected line', exact: true });
  await button.click();
  await button.evaluate(element => { element.dataset.removeItem = 'new-line'; });
  const confirmation = page.getByRole('dialog', { name: 'Confirm deletion', exact: true });
  await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(await page.evaluate(() => window.recordDeleteClicks)).toEqual([]);
  await button.click();
  await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(await page.evaluate(() => window.recordDeleteClicks)).toEqual(['new-line']);
});

test('one shared flash remains centered and dismissible above nested native dialogs', async ({ page }) => {
  await page.route(`**${previewPath}`, route => route.fulfill({ contentType: 'text/html', body: previewHtml() }));
  await (await addPreviewLink(page)).click();
  const modal = page.locator('.record-modal');
  await expect(modal).toBeVisible();
  await page.evaluate(() => window.ClassicMartFlash.show('Preview error', { type: 'error', duration: 0 }));
  const flash = page.locator('[data-platform-flash-toast]');
  await expect(flash).toHaveCount(1);
  expect(await flash.evaluate(element => element.parentElement.classList.contains('record-modal'))).toBe(true);
  const box = await flash.boundingBox();
  const viewport = page.viewportSize();
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
  await flash.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  await expect(flash).toBeHidden();
  await page.evaluate(() => {
    window.recordNestedConfirmation = window.ClassicMartRecordActions.confirm({ opener: document.querySelector('.record-modal-edit') });
  });
  const confirmation = page.locator('.record-confirm-modal');
  await expect(confirmation).toBeVisible();
  await page.evaluate(() => window.ClassicMartFlash.show('Confirmation error', { type: 'error', duration: 0 }));
  expect(await flash.evaluate(element => element.parentElement.classList.contains('record-confirm-modal'))).toBe(true);
  await flash.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await flash.evaluate(element => element.parentElement.classList.contains('record-modal'))).toBe(true);
  await modal.getByRole('button', { name: 'Close record', exact: true }).click();
  expect(await flash.evaluate(element => element.parentElement === document.body)).toBe(true);
  await expect(flash).toHaveCount(1);
});

test('persisted page transitions close native dialogs without restoring an inert closed surface', async ({ page }) => {
  const authorInert = await page.evaluate(() => {
    const aside = document.createElement('aside'); aside.id = 'recordAuthorInert'; aside.inert = true;
    document.body.append(aside);
    return [...document.body.children].filter(node => node.inert).map(node => node.id);
  });
  await page.route(`**${previewPath}`, route => route.fulfill({ contentType: 'text/html', body: previewHtml() }));
  await (await addPreviewLink(page)).click();
  await expect(page.locator('.record-modal')).toBeVisible();
  await page.evaluate(() => {
    window.recordPersistedAnswer = null;
    window.ClassicMartRecordActions.confirm().then(value => { window.recordPersistedAnswer = value; });
  });
  await expect(page.locator('.record-confirm-modal')).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.locator('.record-modal')).not.toBeVisible();
  await expect(page.locator('.record-confirm-modal')).not.toBeVisible();
  expect(await page.evaluate(() => window.recordPersistedAnswer)).toBe(false);
  expect(await page.evaluate(() => [...document.body.children].filter(node => node.inert).map(node => node.id))).toEqual(authorInert);
  expect(await page.locator('[data-platform-flash-toast]').evaluate(node => node.parentElement === document.body)).toBe(true);
});

test('owned delivery addresses preview and edit real data, while deletion supports Cancel and Continue', async ({ page, baseURL }) => {
  test.skip(process.env.NODE_ENV !== 'test' || process.env.MAIL_MODE !== 'log'
    || !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'Requires the owned loopback fixture with development email delivery.');
  await registerCustomer(page);
  await page.goto('/addresses', { waitUntil: 'networkidle' });
  const form = page.locator('#addressForm');
  await form.getByLabel('Full name', { exact: true }).fill('Modal Address Customer');
  await form.getByLabel('Phone number', { exact: true }).fill('+256770112233');
  await form.getByLabel('Street address', { exact: true }).fill('12 Record Preview Road');
  await form.getByLabel('City', { exact: true }).fill('Kampala');
  const country = form.getByRole('combobox', { name: 'Country', exact: true });
  await country.selectOption('UG');
  await expect(country).toHaveValue('UG');
  await form.getByRole('button', { name: 'Save Address', exact: true }).click();
  const card = page.locator('.address-card').filter({ hasText: 'Modal Address Customer' });
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: 'View Modal Address Customer address', exact: true }).click();
  const modal = page.locator('.record-modal');
  await expect(modal.getByLabel('Street address', { exact: true })).toHaveValue('12 Record Preview Road');
  await expect(modal.getByLabel('City', { exact: true })).not.toBeEditable();
  await modal.getByRole('button', { name: 'Edit', exact: true }).click();
  await modal.getByLabel('City', { exact: true }).fill('Entebbe');
  await modal.getByRole('button', { name: 'Save Address', exact: true }).click();
  await expect(modal).toContainText('Address updated.');
  await modal.getByRole('button', { name: 'Close record', exact: true }).click();
  await expect(card).toContainText('Entebbe');
  let archives = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/addresses\/[^/]+\/archive$/.test(new URL(request.url()).pathname)) archives++; });
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete address?', exact: true });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(archives).toBe(0);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(archives).toBe(1);
});
