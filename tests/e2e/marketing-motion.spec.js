import { test, expect } from './browser-fixture.js';

const start = new Date('2026-10-11T00:00:00Z');

async function openHome(page, reducedMotion = 'no-preference') {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
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
  const response = await page.goto('/', { waitUntil: 'networkidle' });
  expect(response.status(), 'the homepage must load before testing its slide controls').toBe(200);
  expect(pageErrors, 'homepage scripts initialize from the published catalogue').toEqual([]);
  expect(await page.locator('.hero-slide').count()).toBeGreaterThan(1);
  expect(await page.locator('.promo-card').count()).toBeGreaterThan(0);
}

const activeSlide = page => page.locator('.hero-slide').evaluateAll(slides => slides.findIndex(slide => slide.classList.contains('is-active')));
const promoStarts = (page, index) => page.evaluate(index => window.marketingMotionStarts.filter(value => value === index).length, index);
const stopPointerAndFocus = page => page.evaluate(() => document.activeElement?.blur());

test('published catalogue initializes manual hero navigation and keeps each selected slide in view', async ({ page }) => {
  await openHome(page, 'reduce');

  const slides = page.locator('.hero-slide');
  const slideCount = await slides.count();
  const targets = await page.locator('#heroDots button').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect(), dot = getComputedStyle(button, '::before');
    return { left: box.left, right: box.right, width: box.width, height: box.height,
      dotWidth: parseFloat(dot.width), dotHeight: parseFloat(dot.height) };
  }));
  for (const [index, target] of targets.entries()) {
    expect(target.width).toBeGreaterThanOrEqual(24);
    expect(target.height).toBeGreaterThanOrEqual(24);
    expect(target.dotWidth).toBe(index === 0 ? 20 : 8);
    expect(target.dotHeight).toBe(8);
    if (index > 0) expect(target.left).toBeGreaterThanOrEqual(targets[index - 1].right);
  }
  const expectSelectedSlide = async index => {
    expect(await activeSlide(page)).toBe(index);
    await expect(slides.nth(index)).toHaveAttribute('aria-hidden', 'false');
    await expect(slides.nth(index)).toHaveJSProperty('inert', false);
    await expect(page.getByRole('button', { name: `Slide ${index + 1}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.locator('#heroSlider').evaluate((hero, index) => {
      const selected = hero.querySelectorAll('.hero-slide')[index].getBoundingClientRect();
      const viewport = hero.getBoundingClientRect();
      return Math.max(Math.abs(selected.left - viewport.left), Math.abs(selected.right - viewport.right));
    }, index), { message: 'selected hero slide fills the visible slider' }).toBeLessThanOrEqual(1);
  };

  await expectSelectedSlide(0);
  const nextArrow = page.locator('#heroNext');
  const previousArrow = page.locator('#heroPrev');
  if (await nextArrow.isVisible()) {
    await nextArrow.click();
    await expectSelectedSlide(1);
    await previousArrow.click();
    await expectSelectedSlide(0);
    await previousArrow.click();
    await expectSelectedSlide(slideCount - 1);
    await nextArrow.click();
    await expectSelectedSlide(0);
  }
  for (let index = 0; index < slideCount; index += 1) {
    await page.getByRole('button', { name: `Slide ${index + 1}`, exact: true }).click({ position: { x: 1, y: 1 } });
    await expectSelectedSlide(index);
  }
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await expectSelectedSlide(0);
});

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

test('all seven promotional motions keep labels opaque while only photos fade', async ({ page }) => {
  await openHome(page);
  const samples = await page.locator('.promo-card').evaluateAll(cards => {
    const motions = [
      ['slide-left', 'promoSlideLeft', 'promoPhotoSlide', .44],
      ['slide-right', 'promoSlideRight', 'promoPhotoSlide', .44],
      ['slide-up', 'promoSlideUp', 'promoPhotoSlide', .44],
      ['slide-down', 'promoSlideDown', 'promoPhotoSlide', .44],
      ['zoom-in', 'promoZoomIn', 'promoPhotoZoom', .48],
      ['zoom-out', 'promoZoomOut', 'promoPhotoZoom', .48],
      ['fade', 'promoFade', 'promoPhotoFade', .5],
    ];
    const classes = motions.map(([motion]) => `promo-motion-${motion}`);
    return cards.flatMap((card, cardIndex) => {
      const originalClass = card.className;
      card.classList.remove(...classes);
      const image = card.querySelector(':scope > img');
      const background = getComputedStyle(card).backgroundColor;
      const labels = [...card.querySelectorAll('strong, small, b')];
      const colors = labels.map(label => getComputedStyle(label).color);
      const normalPhotoOpacity = Number(getComputedStyle(image).opacity);
      try {
        return motions.flatMap(([motion, cardName, photoName, fadedAt]) => {
          card.classList.remove(...classes);
          void card.offsetWidth;
          card.classList.add(`promo-motion-${motion}`);
          const cardAnimation = card.getAnimations().find(animation => animation.animationName === cardName);
          const photoAnimation = image.getAnimations().find(animation => animation.animationName === photoName);
          if (!cardAnimation || !photoAnimation) throw new Error(`Missing live ${motion} card/photo animation.`);
          const animations = [cardAnimation, photoAnimation];
          for (const animation of animations) animation.pause();
          const duration = cardAnimation.effect.getTiming().duration;
          return [0, .25, .44, .48, .5, .55, .56, .75, .99].map(progress => {
            for (const animation of animations) animation.currentTime = duration * progress;
            const style = getComputedStyle(card);
            return { cardIndex, motion, progress, duration, photoDuration: photoAnimation.effect.getTiming().duration,
              background: style.backgroundColor, originalBackground: background,
              cardOpacity: Number(style.opacity), transform: style.transform,
              labels: labels.map((label, index) => {
                let effectiveOpacity = 1;
                for (let ancestor = label; ancestor; ancestor = ancestor.parentElement) {
                  effectiveOpacity *= Number(getComputedStyle(ancestor).opacity);
                }
                return { effectiveOpacity, color: getComputedStyle(label).color, originalColor: colors[index] };
              }),
              photoOpacity: Number(getComputedStyle(image).opacity), normalPhotoOpacity, fadedAt };
          });
        });
      } finally { card.className = originalClass; }
    });
  });
  expect(samples.length).toBeGreaterThanOrEqual(7 * 9);
  for (const sample of samples) {
    const context = `card ${sample.cardIndex}, ${sample.motion}, progress ${sample.progress}`;
    expect(sample.duration, context).toBe(1050);
    expect(sample.photoDuration, context).toBe(1050);
    expect(sample.cardOpacity, context).toBe(1);
    expect(sample.background, context).toBe(sample.originalBackground);
    for (const label of sample.labels) {
      expect(label.effectiveOpacity, context).toBe(1);
      expect(label.color, context).toBe(label.originalColor);
    }
    if (sample.progress === 0) expect(sample.photoOpacity, context).toBe(sample.normalPhotoOpacity);
    if (sample.progress === sample.fadedAt) {
      expect(sample.photoOpacity, context).toBeLessThan(.01);
      expect(sample.transform, context).not.toBe('matrix(1, 0, 0, 1, 0, 0)');
      expect(sample.transform, context).not.toBe('none');
    }
  }
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
