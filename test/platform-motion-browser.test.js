import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const motion = await fs.readFile(new URL('../public/platform-motion.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../public/platform-motion.css', import.meta.url), 'utf8');
const homepage = await fs.readFile(new URL('../public/script.js', import.meta.url), 'utf8');
const homepageCss = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const between = (start, end) => {
  const first = homepage.indexOf(start), last = homepage.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'production motion controller boundaries exist');
  return homepage.slice(first, last);
};
const promoHarness = `(() => { const qs = s => document.querySelector(s), qsa = s => [...document.querySelectorAll(s)];
 const reducedMarketingMotion = matchMedia('(prefers-reduced-motion: reduce)'), marketingPointerWithin = new WeakSet();
 const startHero = () => {}, stopHero = () => {}; Math.random = () => 0;
 ${between('  function marketingMotionAllowed(element)', '  function configureCataloguePriceRange()')}
 ${between('  function startPromoAnimations()', '  function ensureMobileBottomNav()')}
 window.promoStarts = []; const classes = document.querySelector('.promo-card').classList, nativeAdd = classes.add.bind(classes);
 classes.add = (...names) => { for (const name of names) if (name.startsWith('promo-motion-')) window.promoStarts.push(name); return nativeAdd(...names); };
 startPromoAnimations(); })();`;

test('scroll entrances cover storefront and dashboard cards, dynamic content, focus and motion preferences', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const dashboard of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent(`<html><head><style>body{margin:0;overflow-x:hidden}main{padding:20px}article{height:130px;margin:20px 0;padding:16px;background:#eee}button{margin:10px}.spacer{height:900px}${css}</style></head><body ${dashboard ? 'data-dashboard-workspace="customer"' : ''}><main><h1>Marketplace</h1><div class="spacer"></div>${['up','down','left','right','zoom','zoom-out','drop'].map((name, i) => `<article id="card${i}" class="${dashboard ? 'stat-card panel' : 'product-card'}" data-scroll-motion="${name}"><button>Open ${i}</button></article>`).join('')}<section id="closed" hidden><article class="panel" id="unhidden">Later dashboard page</article></section></main></body></html>`);
      await page.mouse.move(380, 5);
      await page.evaluate(() => { window.motionStarts = []; document.addEventListener('animationstart', event => { if (event.animationName.startsWith('cmEntrance')) window.motionStarts.push({ id: event.target.id, name: event.animationName }); }); });
      await page.addScriptTag({ content: motion });
      assert.equal(await page.locator('#card0').evaluate(element => getComputedStyle(element).opacity), '1', 'offscreen content is never pre-hidden');
      await page.locator('#card0').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'card0'))).toBe(true);
      await expect(page.locator('#card0')).not.toHaveClass(/platform-motion-enter/, { timeout: 2000 });
      await page.locator('#card5').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.name === 'cmEntranceZoomOut'))).toBe(true);
      await page.locator('#card6').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'card6'))).toBe(true);
      await page.locator('#card6 button').focus();
      await expect(page.locator('#card6')).not.toHaveClass(/platform-motion-enter/);
      await page.evaluate(() => { document.activeElement.blur(); const card = document.createElement('article'); card.id = 'dynamic'; card.className = 'panel'; card.textContent = 'New live data'; document.querySelector('main').append(card); });
      await page.locator('#dynamic').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'dynamic'))).toBe(true);
      await page.evaluate(() => { document.querySelector('#closed').hidden = false; });
      await page.locator('#unhidden').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.motionStarts.some(item => item.id === 'unhidden'))).toBe(true);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.locator('.platform-motion-enter')).toHaveCount(0);
      assert.equal(await page.locator('#unhidden').evaluate(element => getComputedStyle(element).opacity), '1');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'directional effects never introduce horizontal scrolling');
      assert.deepEqual(errors, []);
      await page.close();
    }
    const lowData = await browser.newPage();
    await lowData.setContent(`<html data-low-data="true"><head><style>${css}</style></head><body><main><article class="panel">Visible content</article></main></body></html>`);
    await lowData.addScriptTag({ content: motion });
    assert.equal(await lowData.locator('.platform-motion-enter').count(), 0);
    assert.equal(await lowData.locator('article').evaluate(element => getComputedStyle(element).opacity), '1');
    await lowData.close();
  } finally { await browser.close(); }
});

test('small hero banners cycle through all seven production effects and pause for interaction and reduced motion', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.clock.install();
    await page.setContent(`<html><head><style>${homepageCss}</style></head><body><main><div class="promo-stack" style="width:300px"><article class="promo-card"><img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3C/svg%3E"><div><h2>Discover products</h2><button>Browse</button></div></article></div></main></body></html>`);
    await page.mouse.move(1300, 800);
    await page.addScriptTag({ content: promoHarness });
    for (let i = 0; i < 7; i++) {
      await page.clock.fastForward(3300);
      assert.equal(await page.locator('.promo-card').evaluate(element => getComputedStyle(element).opacity), '1', 'promotional labels stay opaque during effects');
    }
    const starts = await page.evaluate(() => window.promoStarts);
    assert.equal(new Set(starts.slice(0, 7)).size, 7, 'all slide/zoom/fade effects run before repeats');
    await page.hover('.promo-card');
    const paused = await page.evaluate(() => window.promoStarts.length);
    await page.clock.fastForward(20_000);
    assert.equal(await page.evaluate(() => window.promoStarts.length), paused);
    await page.mouse.move(1300, 800);
    await page.locator('.promo-card button').focus();
    await page.clock.fastForward(20_000);
    assert.equal(await page.evaluate(() => window.promoStarts.length), paused);
    await page.evaluate(() => document.activeElement.blur());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.fastForward(20_000);
    assert.equal(await page.evaluate(() => window.promoStarts.length), paused);
    assert.equal(await page.locator('.promo-card').evaluate(element => getComputedStyle(element).opacity), '1');
    assert.equal(await page.locator('.promo-card h2').evaluate(element => getComputedStyle(element).opacity), '1');
  } finally { await browser.close(); }
});
