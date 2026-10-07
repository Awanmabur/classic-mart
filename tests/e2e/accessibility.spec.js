import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const publicPages = [
  ['home', '/'],
  ['products', '/products'],
  ['sign in', '/login'],
  ['sign up', '/signup'],
  ['privacy', '/privacy'],
  ['terms', '/terms'],
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

for (const [label, path] of publicPages) {
  test(`${label} has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'networkidle' });
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
  await expect(page.locator('#mainContent')).toBeVisible();
});

test('auth errors are announced and inputs remain labelled', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
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

test('keyboard navigation exposes a visible focus indicator beyond the skip link', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
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
    focusEvidence.outlineWidth >= 2 || (focusEvidence.boxShadow && focusEvidence.boxShadow !== 'none'),
    `focused ${focusEvidence.tag} needs a visible focus indicator`,
  ).toBeTruthy();
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
