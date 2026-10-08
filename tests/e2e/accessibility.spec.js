import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const publicPages = [
  ['home', '/', 'Shop verified products with confidence'],
  ['products', '/products', 'Browse products'],
  ['search', '/search?q=Classic', 'Search results for “Classic”'],
  ['categories', '/categories', 'All Categories'],
  ['sign in', '/login', 'Welcome back to Classic Mart.'],
  ['sign up', '/signup', 'Your shopping, made simpler.'],
  ['privacy', '/privacy', 'Privacy Policy'],
  ['terms', '/terms', 'Terms of Service'],
];

async function assertWcag(page, label) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const compact = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 5).map((node) => node.target),
  }));
  expect(compact, `${label} WCAG violations`).toEqual([]);
}

for (const [label, path, heading] of publicPages) {
  test(`${label} has no automated WCAG A/AA violations`, async ({ page }) => {
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response.status(), `${label} page must load successfully`).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', /\S+/);
    await assertWcag(page, label);
  });
}

test('keyboard focus reaches the skip link and main content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.locator('.skip-link').first();
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(url => url.hash === '#mainContent');
  // Chromium moves the sequential focus starting point to a native fragment
  // target even when the main element itself does not have a tabindex.
  await page.keyboard.press('Tab');
  expect(await page.locator('#mainContent').evaluate(main => main.contains(document.activeElement))).toBe(true);
});

test('auth errors are announced and inputs remain labelled', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.locator('#authMessage')).toHaveAttribute('aria-live', 'polite');
  await assertWcag(page, 'sign in form');
});

test('400-percent equivalent reflow does not create page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of ['/', '/products', '/login', '/privacy']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} must reflow at 320 CSS px`).toBeLessThanOrEqual(2);
  }
});

test('reduced-motion preference suppresses long animations and transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/', { waitUntil: 'networkidle' });
  const longestMs = await page.evaluate(() => {
    const durationMs = (value) => value.split(',').map((part) => {
      const text = part.trim();
      return text.endsWith('ms') ? Number.parseFloat(text) : Number.parseFloat(text) * 1000;
    }).filter(Number.isFinite);
    let max = 0;
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element);
      for (const value of [...durationMs(style.animationDuration), ...durationMs(style.transitionDuration)]) max = Math.max(max, value);
    }
    return max;
  });
  expect(longestMs).toBeLessThanOrEqual(20);
});

async function assertVisibleFocus(page) {
  const focusEvidence = await page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return null;
    const style = getComputedStyle(active);
    return {
      tag: active.tagName,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
    };
  });
  expect(focusEvidence).not.toBeNull();
  expect(
    (focusEvidence.outlineWidth >= 2 && !['none', 'hidden'].includes(focusEvidence.outlineStyle)) ||
      (focusEvidence.boxShadow && focusEvidence.boxShadow !== 'none'),
    `focused ${focusEvidence.tag} needs a visible focus indicator`,
  ).toBeTruthy();
}

test('keyboard navigation exposes a visible focus indicator beyond the skip link', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await assertVisibleFocus(page);
});

test('catalogue search, price and sorting controls expose visible keyboard focus indicators', async ({ page }) => {
  await page.goto('/products', { waitUntil: 'networkidle' });
  const query = page.locator('#catalogQuery');
  const filtersButton = page.getByRole('button', { name: 'Filters', exact: true });
  const filtersOpened = await filtersButton.isVisible();
  if (filtersOpened) await filtersButton.click();
  for (const control of [query, page.getByLabel('Minimum', { exact: true })]) {
    await expect(control).toBeVisible();
    await control.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(control).toBeFocused();
    await expect(control).toBeInViewport();
    await assertVisibleFocus(page);
  }
  if (filtersOpened) await page.getByRole('button', { name: 'Close filters', exact: true }).click();
  const sort = page.locator('#catalogSort');
  await expect(sort).toHaveAccessibleName(/^Sort by\b/);
  await sort.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(sort).toBeFocused();
  await expect(sort).toBeInViewport();
  await assertVisibleFocus(page);
});

test('primary touch controls meet the WCAG 2.2 minimum target size on mobile', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Touch-target assertion runs in the mobile project.');
  await page.goto('/login', { waitUntil: 'networkidle' });
  const tooSmall = await page.evaluate(() => Array.from(document.querySelectorAll('button, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, a.primary-button, a.outline-button'))
    .filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    })
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { tag: element.tagName, id: element.id || '', width: box.width, height: box.height };
    })
    .filter((item) => item.width < 24 || item.height < 24));
  expect(tooSmall).toEqual([]);
});

test('product previews open from native keyboard controls and return focus when closed', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const previewButton = page.locator('#trendingGrid .product-preview-button').first();
  await expect(previewButton).toBeVisible();
  const productName = await previewButton.innerText();
  await previewButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: productName, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Share product', exact: true })).toBeFocused();
  await assertWcag(page, 'opened product preview');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(previewButton).toBeFocused();
});

test('search suggestions support keyboard selection, dismissal and preview focus return', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const productName = await page.locator('#trendingGrid .product-preview-button').first().innerText();
  const search = page.getByRole('combobox', { name: 'Search products', exact: true });
  await search.fill(productName);
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  const firstOption = page.getByRole('listbox', { name: 'Search suggestions' }).getByRole('option').first();
  await expect(firstOption).toBeVisible();
  const firstId = await firstOption.getAttribute('id');
  await search.press('ArrowDown');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('aria-activedescendant', firstId);
  await expect(firstOption).toHaveAttribute('aria-selected', 'true');
  await assertWcag(page, 'opened search suggestions');
  await search.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#searchSuggestions')).not.toBeVisible();
  await expect(search).toBeFocused();
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  await search.press('Enter');
  await expect(page.getByRole('dialog', { name: productName, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
});

test('product filters keep keyboard focus in the open dialog and return it to the opener', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const opener = page.locator('#filterButton');
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#filterDrawer')).not.toBeVisible();
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Filter Products', exact: true });
  await expect(dialog).toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await assertWcag(page, 'opened product filters');
  for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await expect(opener).toBeFocused();
});

test('hero slides stay readable until manual navigation and inactive controls cannot receive focus', async ({ page }) => {
  await page.clock.install();
  await page.goto('/', { waitUntil: 'networkidle' });
  const slides = page.locator('.hero-slide');
  expect(await slides.count()).toBeGreaterThan(1);
  await page.clock.fastForward(6_000);
  await expect(slides.first()).toHaveAttribute('aria-hidden', 'false');
  await expect(slides.first()).toHaveJSProperty('inert', false);
  const nextArrow = page.locator('#heroNext');
  const next = await nextArrow.isVisible() ? nextArrow : page.getByRole('button', { name: 'Slide 2', exact: true });
  await next.focus();
  const inactiveControl = slides.nth(1).locator('button, a').first();
  await expect(slides.nth(1)).toHaveAttribute('aria-hidden', 'true');
  await expect(slides.nth(1)).toHaveJSProperty('inert', true);
  await inactiveControl.focus();
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(slides.nth(1)).toHaveAttribute('aria-hidden', 'false');
  await expect(slides.nth(1)).toHaveJSProperty('inert', false);
  await expect(slides.first()).toHaveJSProperty('inert', true);
  await expect(page.getByRole('button', { name: 'Slide 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await assertWcag(page, 'manually selected second hero slide');
  const thirdDot = page.getByRole('button', { name: 'Slide 3', exact: true });
  await thirdDot.focus();
  await page.keyboard.press('Space');
  await expect(slides.nth(2)).toHaveAttribute('aria-hidden', 'false');
  await expect(slides.nth(2)).toHaveJSProperty('inert', false);
  await assertWcag(page, 'manually selected third hero slide');
  const firstDot = page.getByRole('button', { name: 'Slide 1', exact: true });
  await firstDot.focus();
  await page.keyboard.press('Space');
  await expect(slides.first()).toHaveAttribute('aria-hidden', 'false');
  await expect(slides.first()).toHaveJSProperty('inert', false);
  await expect(firstDot).toHaveAttribute('aria-pressed', 'true');
  await expect(slides.nth(1)).toHaveJSProperty('inert', true);
});
