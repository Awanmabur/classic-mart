import { test, expect } from './browser-fixture.js';

async function freezeClock(page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
}

async function expectCenteredFlash(flash) {
  const geometry = await flash.evaluate(element => {
    const box = element.getBoundingClientRect();
    return {
      position: getComputedStyle(element).position,
      horizontal: Math.abs((box.left + box.right) / 2 - document.documentElement.clientWidth / 2),
      vertical: Math.abs((box.top + box.bottom) / 2 - document.documentElement.clientHeight / 2),
      top: box.top,
      bottom: box.bottom,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(geometry.position).toBe('fixed');
  expect(geometry.horizontal).toBeLessThanOrEqual(1);
  expect(geometry.vertical).toBeLessThanOrEqual(1);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
}

test('shared flash safely replaces successive messages, keeps one container and supports dismissal', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response.status()).toBe(200);
  await freezeClock(page);
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const existing = document.querySelector('[data-platform-flash-toast]');
    if (!existing) throw new Error('The shared flash must initialize its page placeholder.');
    const card = document.createElement('div');
    card.style.cssText = 'position:absolute;left:5px;top:5px;width:120px;height:80px;transform:translateZ(0);overflow:hidden';
    document.body.append(card);
    card.append(existing);
    const duplicate = document.createElement('div');
    duplicate.id = 'catalogToast';
    document.body.append(duplicate);
    // A fresh call must use the original singleton even if unrelated content
    // attempts to introduce a second toast placeholder.
    window.ClassicMartFlash.show('Added to cart');
  });
  await page.clock.fastForward(4000);
  await page.evaluate(() => {
    window.ClassicMartFlash.show('<img src=x onerror=alert(1)>', { type: 'error', duration: 0 });
  });
  const flash = page.locator('[data-platform-flash-toast]');
  await expect(flash).toHaveCount(1);
  expect(await flash.evaluate(element => element.parentElement === document.body)).toBe(true);
  await expect(page.locator('#catalogToast')).toHaveCount(0);
  await expect(flash).toBeVisible();
  await expectCenteredFlash(flash);
  await expect(flash).toHaveAttribute('role', 'alert');
  await expect(flash.locator('.platform-flash-content')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(flash.locator('img')).toHaveCount(0);
  // The previous message's expiry cannot close a more recent message.
  await page.clock.fastForward(1000);
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
  await freezeClock(page);
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
  await expect(message.getByRole('button', { name: 'Dismiss message' })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(4999);
  await expect(message).toBeVisible();
  await page.clock.fastForward(1);
  await expect(message).toBeHidden();
});

test('client flashes expire after five seconds even when an old caller requests an indefinite duration', async ({ page }) => {
  await page.goto('/login');
  await freezeClock(page);
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.ClassicMartFlash.show('Saved successfully', { duration: 0 }));
  const flash = page.locator('[data-platform-flash-toast]');
  await expect(flash).toBeVisible();
  await page.clock.fastForward(4999);
  await expect(flash).toBeVisible();
  await page.clock.fastForward(1);
  await expect(flash).toBeHidden();
});

test('dynamic inline messages can be dismissed and reused after expiry without hiding persistent notices', async ({ page }) => {
  await page.goto('/login');
  await freezeClock(page);
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    document.querySelector('#authMessage').textContent = 'The service is temporarily unavailable.';
    const notice = document.createElement('aside');
    notice.id = 'persistentFlashCheck';
    notice.className = 'platform-flash';
    notice.dataset.flashPersistent = '';
    notice.textContent = 'Your verification is still awaiting review.';
    document.querySelector('main').prepend(notice);
  });
  const message = page.locator('#authMessage');
  await expect(message).toBeVisible();
  await expect(message.getByRole('button', { name: 'Dismiss message' })).toBeVisible();
  await page.clock.fastForward(5000);
  await expect(message).toBeHidden();
  await expect(page.locator('#persistentFlashCheck')).toBeVisible();
  await expect(page.locator('#persistentFlashCheck button')).toHaveCount(0);
  // Existing page scripts replace the status text rather than calling an API.
  // The same message after another request must reveal a fresh close control.
  await page.evaluate(() => { document.querySelector('#authMessage').textContent = 'The service is temporarily unavailable.'; });
  await expect(message).toBeVisible();
  const email = page.getByLabel('Email address', { exact: true });
  await email.focus();
  await message.getByRole('button', { name: 'Dismiss message' }).focus();
  await page.keyboard.press('Enter');
  await expect(message).toBeHidden();
  await expect(email).toBeFocused();
});

test('dashboard flashes use compact spacing and remain within the viewport', async ({ page }) => {
  await page.goto('/login');
  await page.mouse.move(0, 0);
  const size = await page.evaluate(() => {
    document.body.dataset.dashboardWorkspace = 'seller';
    const message = document.createElement('p');
    message.id = 'dashboardFlashCheck';
    message.className = 'platform-flash';
    message.textContent = 'Saved seller settings.';
    document.querySelector('main').prepend(message);
    const toast = window.ClassicMartFlash.show('A'.repeat(200));
    const box = toast.getBoundingClientRect();
    const style = getComputedStyle(toast);
    return { width: box.width, left: box.left, right: box.right, viewport: document.documentElement.clientWidth,
      paddingTop: style.paddingTop, paddingRight: style.paddingRight };
  });
  expect(size.width).toBeLessThanOrEqual(Math.min(420, size.viewport - 32));
  expect(size.left).toBeGreaterThanOrEqual(0);
  expect(size.right).toBeLessThanOrEqual(size.viewport);
  expect(size.paddingTop).toBe('10px');
  expect(size.paddingRight).toBe('12px');
  const inline = page.locator('#dashboardFlashCheck');
  await expect(inline.getByRole('button', { name: 'Dismiss message' })).toBeVisible();
  const inlineSize = await inline.evaluate(element => ({ width: element.getBoundingClientRect().width,
    paddingTop: getComputedStyle(element).paddingTop, marginBottom: getComputedStyle(element).marginBottom }));
  expect(inlineSize.width).toBeLessThanOrEqual(560);
  expect(inlineSize.paddingTop).toBe('10px');
  expect(inlineSize.marginBottom).toBe('12px');
});

test('real cart success and failed API responses use one centered flash without narrow-screen overflow', async ({ page }, testInfo) => {
  if (testInfo.project.name.startsWith('mobile')) await page.setViewportSize({ width: 320, height: 800 });
  const response = await page.goto('/products', { waitUntil: 'networkidle' });
  expect(response.status()).toBe(200);
  const add = page.locator('[data-catalog-add]:not([disabled])').first();
  await expect(add).toBeVisible();
  const productName = await add.locator('xpath=ancestor::article').locator('h3').innerText();
  await add.click();
  const flash = page.locator('[data-platform-flash-toast]');
  await expect(flash).toBeVisible();
  await expectCenteredFlash(flash);
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
  await expectCenteredFlash(flash);
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
  await freezeClock(page);
  await page.mouse.move(0, 0);
  const email = page.getByLabel('Email address', { exact: true });
  await email.focus();
  await page.evaluate(() => window.ClassicMartFlash.show('Read this message'));
  await expect(email).toBeFocused();
  const flash = page.locator('[data-platform-flash-toast]');
  await page.clock.fastForward(1000);
  await flash.getByRole('button', { name: 'Dismiss message' }).focus();
  await page.clock.fastForward(5000);
  await expect(flash).toBeVisible();
  await email.focus();
  await page.clock.fastForward(3999);
  await expect(flash).toBeVisible();
  await page.clock.fastForward(1);
  await expect(flash).toBeHidden();
});

test('hover pauses the current reading time and resumes expiry after leaving', async ({ page }) => {
  await page.goto('/login');
  await freezeClock(page);
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.ClassicMartFlash.show('Settings saved.'));
  const flash = page.locator('[data-platform-flash-toast]');
  await page.clock.fastForward(1000);
  await flash.hover();
  await page.clock.fastForward(5000);
  await expect(flash).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(3999);
  await expect(flash).toBeVisible();
  await page.clock.fastForward(1);
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
