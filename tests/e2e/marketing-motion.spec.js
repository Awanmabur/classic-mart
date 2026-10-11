import { test, expect } from '@playwright/test';

const start = new Date('2026-10-11T00:00:00Z');

async function openHome(page, reducedMotion = 'no-preference') {
  await page.emulateMedia({ reducedMotion });
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1_000));
  await page.addInitScript(() => {
    window.marketingMotionStarts = [];
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(records => {
        for (const record of records) {
          const card = record.target;
          if (!card.matches('.promo-card') || record.oldValue?.includes('promo-motion-')) continue;
          if (![...card.classList].some(name => name.startsWith('promo-motion-'))) continue;
          window.marketingMotionStarts.push([...document.querySelectorAll('.promo-card')].indexOf(card));
        }
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    });
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  expect(await page.locator('.hero-slide').count()).toBeGreaterThan(1);
  expect(await page.locator('.promo-card').count()).toBeGreaterThan(0);
}

const activeSlide = page => page.locator('.hero-slide').evaluateAll(slides => slides.findIndex(slide => slide.classList.contains('is-active')));
const promoStarts = (page, index) => page.evaluate(index => window.marketingMotionStarts.filter(value => value === index).length, index);
const stopPointerAndFocus = page => page.evaluate(() => document.activeElement?.blur());

test('approved hero advances every 5.6 seconds and pauses while hovered or focused', async ({ page }) => {
  await openHome(page);
  await page.clock.fastForward(5_599);
  expect(await activeSlide(page)).toBe(0);
  await page.clock.fastForward(1);
  expect(await activeSlide(page)).toBe(1);
  await expect(page.locator('.hero-slide').first()).toHaveJSProperty('inert', true);
  await expect(page.getByRole('button', { name: 'Slide 2', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#heroSlider').hover();
  await page.clock.fastForward(16_800);
  expect(await activeSlide(page)).toBe(1);
  await page.mouse.move(0, 0);
  await page.clock.fastForward(5_600);
  expect(await activeSlide(page)).toBe(2);

  const dot = page.getByRole('button', { name: 'Slide 3', exact: true });
  await dot.focus();
  await page.clock.fastForward(16_800);
  expect(await activeSlide(page)).toBe(2);
  await page.locator('.hero-slide').first().locator('button, a').first().focus();
  await expect(dot).toBeFocused();
  await stopPointerAndFocus(page);
  await page.clock.fastForward(5_600);
  expect(await activeSlide(page)).toBe(0);
});

test('approved promotional motions recur and pause on the card being used', async ({ page }) => {
  await openHome(page);
  await page.clock.runFor(15_000);
  const cards = page.locator('.promo-card');
  for (let index = 0; index < await cards.count(); index += 1) expect(await promoStarts(page, index)).toBeGreaterThanOrEqual(2);

  const card = cards.first();
  await card.hover();
  const hoveredCount = await promoStarts(page, 0);
  await page.clock.runFor(10_000);
  expect(await promoStarts(page, 0)).toBe(hoveredCount);
  expect(await card.evaluate(element => [...element.classList].some(name => name.startsWith('promo-motion-')))).toBe(false);
  await page.mouse.move(0, 0);
  await card.focus();
  await page.clock.runFor(10_000);
  expect(await promoStarts(page, 0)).toBe(hoveredCount);
  await stopPointerAndFocus(page);
  await page.clock.runFor(3_000);
  expect(await promoStarts(page, 0)).toBeGreaterThan(hoveredCount);
});

test('reduced motion pauses marketing timers and changes take effect without reloading', async ({ page }) => {
  await openHome(page, 'reduce');
  await page.clock.runFor(15_000);
  expect(await activeSlide(page)).toBe(0);
  expect(await promoStarts(page, 0)).toBe(0);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.runFor(6_000);
  expect(await activeSlide(page)).toBe(1);
  expect(await promoStarts(page, 0)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pausedSlide = await activeSlide(page);
  const pausedPromos = await promoStarts(page, 0);
  await page.clock.runFor(15_000);
  expect(await activeSlide(page)).toBe(pausedSlide);
  expect(await promoStarts(page, 0)).toBe(pausedPromos);
});

test('hidden pages and page-cache suspension stop marketing timers and resume safely', async ({ page }) => {
  await openHome(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(15_000);
  expect(await activeSlide(page)).toBe(0);
  expect(await promoStarts(page, 0)).toBe(0);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(6_000);
  expect(await activeSlide(page)).toBe(1);
  expect(await promoStarts(page, 0)).toBeGreaterThan(0);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const pausedPromos = await promoStarts(page, 0);
  await page.clock.runFor(15_000);
  expect(await activeSlide(page)).toBe(1);
  expect(await promoStarts(page, 0)).toBe(pausedPromos);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.clock.runFor(6_000);
  expect(await activeSlide(page)).toBe(2);
  expect(await promoStarts(page, 0)).toBeGreaterThan(pausedPromos);
});
