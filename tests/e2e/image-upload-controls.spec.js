import sharp from 'sharp';
import { test, expect } from './browser-fixture.js';

async function imagePayload(name = 'receipt.png') {
  return { name, mimeType: 'image/png', buffer: await sharp({
    create: { width: 320, height: 320, channels: 3, background: '#f5f6f8' },
  }).png().toBuffer() };
}

async function insertForm(page, accept = 'image/png') {
  await page.evaluate(value => {
    const section = document.createElement('section');
    section.id = 'uploadControlsFixture';
    section.style.cssText = 'max-width:320px;margin:24px auto;';
    const form = document.createElement('form');
    form.enctype = 'multipart/form-data';
    const label = document.createElement('label');
    label.textContent = 'Receipt image';
    const input = document.createElement('input');
    input.id = 'uploadReceiptImage';
    input.name = 'document';
    input.type = 'file';
    input.required = true;
    input.accept = value;
    label.append(input);
    const token = document.createElement('input');
    token.type = 'hidden'; token.name = '_csrf'; token.value = 'component-test-token';
    const reset = document.createElement('button');
    reset.type = 'reset'; reset.textContent = 'Reset selection';
    form.append(label, token, reset);
    section.append(form);
    document.querySelector('main').prepend(section);
    form.addEventListener('submit', event => event.preventDefault());
  }, accept);
  const control = page.locator('#uploadControlsFixture [data-image-upload-control]');
  await expect(control).toHaveCount(1);
  return control;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.uploadCreatedUrls = []; window.uploadRevokedUrls = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.uploadCreatedUrls.push(url); return url; };
    URL.revokeObjectURL = url => { window.uploadRevokedUrls.push(url); return revoke(url); };
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect.poll(() => page.evaluate(() => Boolean(window.ClassicMartImageUploads))).toBe(true);
});

test('centered image controls preserve the native label, required validation and original multipart file', async ({ page }) => {
  const control = await insertForm(page);
  const input = page.getByLabel('Receipt image', { exact: true });
  await expect(input).toHaveAttribute('id', 'uploadReceiptImage');
  await expect(input).toHaveAttribute('name', 'document');
  await expect(input).toHaveAttribute('required', '');
  await expect(control.locator('.platform-upload-name')).toHaveText('No image selected');
  expect(await input.evaluate(element => element.reportValidity())).toBe(false);
  await expect(input).toBeFocused();
  await expect(control).toHaveCSS('outline-width', '3px');
  const geometry = await control.evaluate(element => {
    const outer = element.getBoundingClientRect(), icon = element.querySelector('.platform-upload-symbol').getBoundingClientRect();
    const filename = element.querySelector('.platform-upload-name').getBoundingClientRect();
    return { horizontal: Math.abs((icon.left + icon.right - outer.left - outer.right) / 2),
      vertical: Math.abs((icon.top - outer.top) - (outer.bottom - filename.bottom)) };
  });
  expect(geometry.horizontal).toBeLessThanOrEqual(1);
  expect(geometry.vertical).toBeLessThanOrEqual(2);
  const image = await imagePayload('receipt <proof>.png');
  await input.setInputFiles(image);
  await expect(control.locator('.platform-upload-name')).toHaveText(image.name);
  await expect(control.locator('.platform-upload-name > *')).toHaveCount(0);
  await expect(control.locator('.platform-upload-preview')).toBeVisible();
  await expect(control.locator('.platform-upload-preview')).toHaveAttribute('src', /^blob:/);
  expect(await input.evaluate(element => element.checkValidity())).toBe(true);
  expect(await input.evaluate(element => {
    const data = new FormData(element.form), file = data.get('document');
    return { token: data.get('_csrf'), name: file.name, type: file.type, size: file.size };
  })).toEqual({ token: 'component-test-token', name: image.name, type: image.mimeType, size: image.buffer.length });
  await input.evaluate(element => {
    element.form.addEventListener('reset', event => event.preventDefault(), { once: true });
    element.form.reset();
  });
  await expect(control.locator('.platform-upload-name')).toHaveText(image.name);
  await expect(control.locator('.platform-upload-preview')).toBeVisible();
  expect(await input.evaluate(element => element.files.length)).toBe(1);
  await page.getByRole('button', { name: 'Reset selection', exact: true }).click();
  await expect(control.locator('.platform-upload-name')).toHaveText('No image selected');
  await expect(control.locator('.platform-upload-preview')).toBeHidden();
  expect(await input.evaluate(element => element.checkValidity())).toBe(false);
  await expect.poll(() => page.evaluate(() => window.uploadRevokedUrls.length)).toBe(1);
});

test('dynamic upload forms are initialized once and file removal releases private preview objects', async ({ page }) => {
  const control = await insertForm(page);
  await page.evaluate(() => {
    const root = document.getElementById('uploadControlsFixture');
    document.dispatchEvent(new CustomEvent('classicmart:content-ready', { detail: { root } }));
    window.ClassicMartImageUploads.initialize(root);
    window.ClassicMartImageUploads.initialize(root);
  });
  await expect(control).toHaveCount(1);
  await page.locator('#uploadReceiptImage').setInputFiles(await imagePayload());
  await expect(control.locator('.platform-upload-preview')).toBeVisible();
  const url = await control.locator('.platform-upload-preview').getAttribute('src');
  await page.locator('#uploadControlsFixture').evaluate(element => element.remove());
  await expect.poll(() => page.evaluate(value => window.uploadRevokedUrls.includes(value), url)).toBe(true);
  const csv = await insertForm(page, '.csv,text/csv');
  await expect(csv.locator('.platform-upload-label')).toHaveText('Choose file');
  await page.locator('#uploadReceiptImage').setInputFiles({ name: 'purchasing.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,quantity\nitem,1\n') });
  await expect(csv.locator('.platform-upload-name')).toHaveText('purchasing.csv');
  await expect(csv.locator('.platform-upload-preview')).toBeHidden();
  await expect(csv.locator('.platform-upload-preview')).not.toHaveAttribute('src');
  const search = page.locator('[data-image-search-input]');
  await expect(search).toHaveCount(1);
  await expect(search).toHaveClass(/sr-only/);
  expect(await search.evaluate(element => element.closest('[data-image-upload-control]'))).toBe(null);
});

test('preview lifecycles handle file clearing, disabled controls and persisted page restoration', async ({ page }) => {
  const control = await insertForm(page);
  const input = page.locator('#uploadReceiptImage');
  await input.setInputFiles(await imagePayload());
  await expect(control.locator('.platform-upload-preview')).toBeVisible();
  const original = await control.locator('.platform-upload-preview').getAttribute('src');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(control.locator('.platform-upload-preview')).toBeVisible();
  await expect(control.locator('.platform-upload-preview')).not.toHaveAttribute('src', original);
  expect(await page.evaluate(value => window.uploadRevokedUrls.includes(value), original)).toBe(true);
  await input.evaluate(element => { element.disabled = true; });
  await expect(control).toHaveAttribute('aria-disabled', 'true');
  await input.evaluate(element => { element.disabled = false; element.value = ''; element.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(control.locator('.platform-upload-name')).toHaveText('No image selected');
  await expect(control.locator('.platform-upload-preview')).toBeHidden();
});

test('moving native inputs keeps one control and oversized files are not decoded as previews', async ({ page }) => {
  await insertForm(page);
  await page.evaluate(() => {
    const input = document.getElementById('uploadReceiptImage');
    input.form.append(input);
  });
  const control = page.locator('#uploadControlsFixture [data-image-upload-control]');
  await expect(control).toHaveCount(1);
  await expect(control.locator('#uploadReceiptImage')).toHaveCount(1);
  const input = page.locator('#uploadReceiptImage');
  await input.setInputFiles({ name: 'oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) });
  await expect(control.locator('.platform-upload-name')).toHaveText('oversized.png');
  await expect(control.locator('.platform-upload-preview')).toBeHidden();
  expect(await page.evaluate(() => window.uploadCreatedUrls.length)).toBe(0);
  expect(await input.evaluate(element => element.files[0].size)).toBe(8 * 1024 * 1024 + 1);
  await input.evaluate(element => { element.hidden = true; });
  await expect(control).toHaveCount(0);
  await expect(input).toBeHidden();
  await input.evaluate(element => { element.hidden = false; });
  await expect(control).toHaveCount(1);
});

test('without JavaScript the original required file field remains visible and usable', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.setContent('<link rel="stylesheet" href="/image-upload-controls.css"><form enctype="multipart/form-data"><label>Receipt image<input type="file" name="document" accept="image/png" required></label></form>');
    const input = page.getByLabel('Receipt image', { exact: true });
    await expect(input).toBeVisible();
    await expect(input).toHaveCSS('opacity', '1');
    await expect(input).not.toHaveClass(/platform-upload-input/);
    expect(await input.evaluate(element => element.checkValidity())).toBe(false);
    await input.setInputFiles(await imagePayload());
    expect(await input.evaluate(element => element.checkValidity())).toBe(true);
  } finally { await context.close(); }
});
