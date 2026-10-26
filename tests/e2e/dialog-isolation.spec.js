import { test, expect } from './browser-fixture.js';

async function openPreview(page, path) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(path, { waitUntil: 'networkidle' });
  const opener = path === '/'
    ? page.locator('#trendingGrid .product-preview-button').first()
    : page.locator('#catalogProductGrid .catalog-product-image').first();
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('#productModal');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Share product', exact: true })).toBeFocused();
  return { dialog, opener };
}

async function expectBackgroundBlocked(page, dialog) {
  await page.locator('#searchInput').evaluate(element => element.focus());
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  expect(await page.locator('#searchInput').evaluate(element => Boolean(element.closest('[inert]')))).toBe(true);
}

for (const path of ['/', '/products']) {
  test(`${path} preview isolates background controls and preserves author inert states and shared announcements`, async ({ page }) => {
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const aside = document.createElement('aside');
        aside.id = 'authorInertFixture';
        aside.setAttribute('inert', 'author-state');
        aside.textContent = 'Previously inactive content';
        document.body.append(aside);
      }, { once: true });
    });
    const { dialog, opener } = await openPreview(page, path);
    await expectBackgroundBlocked(page, dialog);
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.evaluate(() => window.ClassicMartFlash.show('Cart update remains announced', { duration: 0 }));
    const flash = page.locator('[data-platform-flash-toast]');
    await expect(flash).toBeVisible();
    await expect(flash).toHaveAttribute('role', 'status');
    expect(await flash.evaluate(element => Boolean(element.closest('[inert]')))).toBe(false);
    await page.evaluate(() => window.ClassicMartFlash.dismiss());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator('#authorInertFixture')).toHaveAttribute('inert', 'author-state');
    await expect(page.locator('#top')).not.toHaveAttribute('inert');
    await page.locator('#searchInput').focus();
    await expect(page.locator('#searchInput')).toBeFocused();
  });

  test(`${path} share fallback and related previews retain isolation and restore newly added background controls`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } } });
      document.execCommand = () => false;
    });
    const { dialog, opener } = await openPreview(page, path);
    await dialog.getByRole('button', { name: 'Share product', exact: true }).click();
    const fallback = page.locator('#productShareFallback');
    await expect(fallback).toBeVisible();
    await expectBackgroundBlocked(page, dialog);
    await fallback.getByLabel('Share this product link', { exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(fallback).toBeHidden();
    await expect(dialog).toBeVisible();
    const related = dialog.locator('#previewRelatedGrid button[data-product-preview]').first();
    await expect(related).toBeVisible();
    const id = await related.getAttribute('data-product-preview');
    await related.click();
    await expect(page.locator('#productModalShare')).toHaveAttribute('data-share-product', id);
    await expectBackgroundBlocked(page, dialog);
    expect(await page.evaluate(() => {
      const control = document.createElement('button');
      control.id = 'newBackgroundControl';
      control.textContent = 'New background action';
      document.body.append(control);
      control.focus();
      return document.querySelector('#productModal').contains(document.activeElement);
    })).toBe(true);
    await expect(page.locator('#newBackgroundControl')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator('#newBackgroundControl')).not.toHaveAttribute('inert');
    await page.locator('#newBackgroundControl').focus();
    await expect(page.locator('#newBackgroundControl')).toBeFocused();
  });
}

test('homepage filter drawer isolates the background until Escape restores its keyboard opener', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/', { waitUntil: 'networkidle' });
  const opener = page.locator('#filterButton');
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Filter Products', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close product filters', exact: true })).toBeFocused();
  await expectBackgroundBlocked(page, dialog);
  await dialog.getByRole('button', { name: 'Reset', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close product filters', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await page.locator('#searchInput').focus();
  await expect(page.locator('#searchInput')).toBeFocused();
});

test('catalogue filters retain desktop semantics and isolate the nested mobile drawer with safe resize restoration', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/products', { waitUntil: 'networkidle' });
  const panel = page.locator('#catalogFilterPanel');
  if (!testInfo.project.name.startsWith('mobile')) {
    await expect(panel).not.toHaveAttribute('role');
    await expect(panel).not.toHaveAttribute('inert');
    await panel.getByLabel('Search within results', { exact: true }).focus();
    await expect(panel.getByLabel('Search within results', { exact: true })).toBeFocused();
    return;
  }
  await expect(panel).toHaveAttribute('inert', '');
  const opener = page.locator('#openCatalogFilters');
  await opener.click();
  await expect(panel).toHaveAttribute('role', 'dialog');
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  const close = panel.getByRole('button', { name: 'Close filters', exact: true });
  await expect(close).toBeFocused();
  await expectBackgroundBlocked(page, panel);
  await panel.getByRole('button', { name: 'Clear all', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveAttribute('inert', '');
  await expect(opener).toBeFocused();
  await page.locator('#searchInput').focus();
  await expect(page.locator('#searchInput')).toBeFocused();
  await opener.click();
  await expect(close).toBeFocused();
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(panel).not.toHaveAttribute('inert');
  await expect(panel).not.toHaveAttribute('role');
  await expect(opener).toBeHidden();
  await page.locator('#searchInput').focus();
  await expect(page.locator('#searchInput')).toBeFocused();
});
