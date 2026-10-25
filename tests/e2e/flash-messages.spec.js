import { test, expect } from './browser-fixture.js';

test('shared flash safely replaces successive messages, keeps one container and supports dismissal', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response.status()).toBe(200);
  await page.evaluate(() => {
    const duplicate = document.createElement('div');
    duplicate.id = 'catalogToast';
    document.body.append(duplicate);
    // A fresh call must use the original singleton even if unrelated content
    // attempts to introduce a second toast placeholder.
    window.ClassicMartFlash.show('Added to cart', { duration: 1000 });
    window.ClassicMartFlash.show('<img src=x onerror=alert(1)>', { type: 'error', duration: 0 });
  });
  const flash = page.locator('[data-platform-flash-toast]');
  await expect(flash).toHaveCount(1);
  await expect(page.locator('#catalogToast')).toHaveCount(0);
  await expect(flash).toBeVisible();
  await expect(flash).toHaveAttribute('role', 'alert');
  await expect(flash.locator('.platform-flash-content')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(flash.locator('img')).toHaveCount(0);
  // The previous message's expiry cannot close a more recent message.
  await page.waitForTimeout(1150);
  await expect(flash).toBeVisible();
  const borders = await flash.evaluate(element => {
    const style = getComputedStyle(element);
    return ['Top', 'Right', 'Bottom', 'Left'].map(side => [style[`border${side}Width`], style[`border${side}Color`]]);
  });
  expect(borders.every(border => border[0] === '1px' && border[1] === borders[0][1])).toBe(true);
  await flash.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(flash).toBeHidden();
});

test('server login errors use the same primary border and no empty flash occupies space', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response.status()).toBe(200);
  await expect(page.locator('#authMessage')).toBeHidden();
  await page.getByLabel('Email address', { exact: true }).fill('flash-check-invalid@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Wrong-password-fixture-123');
  await Promise.all([
    page.waitForURL(url => url.pathname === '/login', { waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: /Sign In to Classic Mart/i }).click(),
  ]);
  const message = page.locator('#authMessage');
  await expect(message).toBeVisible();
  await expect(message).not.toBeEmpty();
  const shared = await message.evaluate(element => {
    const style = getComputedStyle(element);
    return element.classList.contains('platform-flash') && style.borderTopWidth === '1px'
      && style.borderLeftWidth === '1px' && style.borderLeftColor === style.borderTopColor;
  });
  expect(shared).toBe(true);
});

test('real cart success and failed API responses use one flash without narrow-screen overflow', async ({ page }, testInfo) => {
  if (testInfo.project.name.startsWith('mobile')) await page.setViewportSize({ width: 320, height: 800 });
  const response = await page.goto('/products', { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  const add = page.locator('[data-catalog-add]:not([disabled])').first();
  await expect(add).toBeVisible();
  const productName = await add.locator('xpath=ancestor::article').locator('h3').innerText();
  await add.click();
  const flash = page.locator('[data-platform-flash-toast]');
  await expect(flash).toBeVisible();
  await expect(flash.locator('.platform-flash-content')).toHaveText(`${productName} added to cart`);
  await expect(page.locator('#cartCount')).toHaveText('1');
  // A real server write must have occurred before the later error is simulated.
  const cart = await page.request.get('/api/v1/cart');
  expect(cart.status()).toBe(200);
  expect((await cart.json()).cart.items[0].quantity).toBe(1);
  const successBorders = await flash.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
      style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
  });
  const attack = '<img src=x onerror=alert(1)>' + 'x'.repeat(300);
  await page.route('**/api/v1/cart/items', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: attack } }),
  }));
  await expect(add).toBeEnabled();
  await add.click();
  await expect(flash).toHaveAttribute('role', 'alert');
  await expect(flash.locator('.platform-flash-content')).toHaveText(attack);
  await expect(flash.locator('img')).toHaveCount(0);
  await expect(page.locator('[data-platform-flash-toast]')).toHaveCount(1);
  await expect(page.locator('#catalogToast')).toHaveClass(/platform-flash/);
  const errorLayout = await flash.evaluate(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return { borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
      style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
      left: box.left, right: box.right, viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(errorLayout.borders).toEqual(successBorders);
  expect(errorLayout.borders.slice(0, 4)).toEqual(['1px', '1px', '1px', '1px']);
  expect(errorLayout.left).toBeGreaterThanOrEqual(0);
  expect(errorLayout.right).toBeLessThanOrEqual(errorLayout.viewport);
  expect(errorLayout.overflow).toBeLessThanOrEqual(1);
  await flash.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(flash).toBeHidden();
});

test('keyboard focus pauses flash expiry without moving focus from the action', async ({ page }) => {
  await page.goto('/login');
  const email = page.getByLabel('Email address', { exact: true });
  await email.focus();
  await page.evaluate(() => window.ClassicMartFlash.show('Read this message', { duration: 1000 }));
  await expect(email).toBeFocused();
  const flash = page.locator('[data-platform-flash-toast]');
  await flash.getByRole('button', { name: 'Dismiss message' }).focus();
  await page.waitForTimeout(1150);
  await expect(flash).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(flash).toBeHidden();
});

test('error-page Marketplace button text is centered inside its button', async ({ page }) => {
  const response = await page.goto('/flash-check-page-does-not-exist');
  expect(response.status()).toBe(404);
  const action = page.getByRole('link', { name: 'Marketplace', exact: true });
  await expect(action).toBeVisible();
  const alignment = await action.evaluate(element => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return { horizontal: Math.abs((box.left + box.right) / 2 - (text.left + text.right) / 2),
      vertical: Math.abs((box.top + box.bottom) / 2 - (text.top + text.bottom) / 2) };
  });
  expect(alignment.horizontal).toBeLessThanOrEqual(2);
  expect(alignment.vertical).toBeLessThanOrEqual(3);
});
