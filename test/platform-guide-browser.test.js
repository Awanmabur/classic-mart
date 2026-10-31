import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const script = await fs.readFile(new URL('../public/platform-guide.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../public/platform-guide.css', import.meta.url), 'utf8');
test('floating guide uses a private session, safe real-price cards, accessible mobile controls and cancellation', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 320, height: 568 }]) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      await context.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
      let sessionReads = 0, posts = 0, hold = false;
      let pending;
      await context.route('https://guide.example/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/guide.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (url.pathname === '/guide.css') return route.fulfill({ contentType: 'text/css', body: styles });
        if (url.pathname === '/api/v1/ai/guide/session') { sessionReads++; return route.fulfill({ json: { csrfToken: 'fixture-private-csrf', country: 'UG', locale: 'en-UG', aiConfigured: false } }); }
        if (url.pathname === '/api/v1/ai/guide') {
          posts++;
          assert.equal(route.request().headers()['x-csrf-token'], 'fixture-private-csrf');
          assert.equal(route.request().postDataJSON().detailed, false);
          if (hold) { pending = route; return; }
          return route.fulfill({ json: { answer: 'A speaker is UGX 150,000.', aiGenerated: false, products: [{ id: 'p1', name: '<img src=x onerror="window.injected=true">', price: 150000, currency: 'UGX', seller: 'Real shop', href: '/products/p1?country=UG' }], links: [{ label: 'Unsafe', href: 'javascript:alert(1)' }, { label: 'External', href: 'https://attacker.invalid/' }, { label: 'Products', href: '/products' }] } });
        }
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/guide.css"><script defer src="/guide.js"></script></head><body><main><h1>Marketplace</h1></main></body></html>' });
      });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('https://guide.example/');
      assert.equal(sessionReads, 0, 'closed helper makes no requests');
      await page.getByRole('button', { name: 'Open Classic AI voice and shopping guide' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.locator('.classic-guide-status')).toContainText('Shopping in UG');
      await expect(page.locator('.classic-guide-mic')).toBeHidden();
      await expect(page.locator('[data-guide-detailed]')).toBeHidden();
      await page.getByRole('textbox', { name: 'How can I help?' }).fill('find a speaker under UGX 200,000');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.classic-guide-products')).toContainText('150,000');
      await expect(page.locator('.classic-guide-products')).toContainText('<img src=x');
      assert.equal(await page.locator('.classic-guide-products img').count(), 0);
      assert.equal(await page.locator('.classic-guide-dialog a[href^="javascript:"], .classic-guide-dialog a[href^="https://attacker"]').count(), 0);
      assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
      assert.equal(posts, 1);
      const accessibility = await new AxeBuilder({ page }).include('#classicGuideDialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(accessibility.violations.map(item => ({ id: item.id, impact: item.impact })), [], 'guide controls, labels and text meet the scoped accessibility checks');
      const geometry = await page.getByRole('dialog').evaluate(dialog => { const rect = dialog.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: innerWidth, height: innerHeight }; });
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport && geometry.top >= 0 && geometry.bottom <= geometry.height);
      hold = true;
      await page.getByRole('textbox', { name: 'How can I help?' }).fill('another product');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => Boolean(pending)).toBe(true);
      await page.getByRole('button', { name: 'Close Classic guide' }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await pending.fulfill({ json: { answer: 'Stale reply must not appear', products: [], links: [] } }).catch(() => {});
      await page.getByRole('button', { name: 'Open Classic AI voice and shopping guide' }).click();
      await expect(page.locator('.classic-guide-log')).not.toContainText('Stale reply');
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('guide matches capsule design; launcher drags, stays onscreen and persists', { timeout: 45_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1200, height: 800 }, { width: 360, height: 700 }]) {
      const context = await browser.newContext({ viewport });
      await context.route('https://guide-drag.example/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/guide.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (path === '/guide.css') return route.fulfill({ contentType: 'text/css', body: styles });
        if (path.endsWith('/session')) return route.fulfill({ json: { csrfToken: 'design-csrf', country: 'UG', locale: 'en-UG', aiConfigured: false } });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><style>:root{--orange:#ff6500;--navy:#14253d}.back-to-top{position:fixed;bottom:22px;right:22px;width:40px;height:40px}@media(max-width:760px){.back-to-top{bottom:14px;right:14px;width:36px;height:36px}}</style><link rel="stylesheet" href="/guide.css"><script defer src="/guide.js"></script></head><body><main><h1>Marketplace</h1></main><button class="back-to-top" aria-label="Back to top"></button></body></html>' });
      });
      const page = await context.newPage();
      const failures = [];
      page.on('pageerror', error => failures.push(error.message));
      await page.goto('https://guide-drag.example/');
      const trigger = page.getByRole('button', { name: 'Open Classic AI voice and shopping guide' });
      const initial = await trigger.boundingBox();
      const back = await page.getByRole('button', { name: 'Back to top' }).boundingBox();
      assert.ok(initial.y + initial.height + 8 <= back.y, 'launcher must start above Back to top');
      await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
      await page.mouse.down();
      await page.mouse.move(20, 180, { steps: 8 });
      await page.mouse.up();
      const moved = await trigger.boundingBox();
      assert.ok(moved.x >= 8 && moved.y >= 8 && moved.x + moved.width <= viewport.width - 7 && moved.y + moved.height <= viewport.height - 7);
      assert.ok(Math.abs(moved.x - initial.x) > 10 || Math.abs(moved.y - initial.y) > 10);
      await expect(page.getByRole('dialog')).not.toBeVisible();
      assert.ok(await trigger.evaluate(node => localStorage.getItem('classic-mart:guide-launcher:v1')));
      await page.reload();
      const restored = await trigger.boundingBox();
      assert.ok(Math.abs(restored.x - moved.x) <= 2 && Math.abs(restored.y - moved.y) <= 2);
      await trigger.focus();
      await page.keyboard.press('Alt+ArrowRight');
      const keyboardMoved = await trigger.boundingBox();
      assert.ok(keyboardMoved.x > restored.x, 'Alt+ArrowRight repositions launcher');
      await page.keyboard.press('Alt+Home');
      const reset = await trigger.boundingBox();
      assert.ok(Math.abs(reset.y - initial.y) <= 2);
      await trigger.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const design = await page.evaluate(() => {
        const dialog = document.querySelector('#classicGuideDialog');
        const close = dialog.querySelector('.classic-guide-close');
        const icon = close.querySelector('svg');
        const input = dialog.querySelector('#classicGuideQuestion');
        const send = dialog.querySelector('.classic-guide-send');
        const css = getComputedStyle;
        const distance = (a, b) => Math.abs(a.left + a.width/2 - b.left - b.width/2)
          + Math.abs(a.top + a.height/2 - b.top - b.height/2);
        return {
          sendColor: css(send).color, sendRadius: parseFloat(css(send).borderTopLeftRadius),
          inputRadius: parseFloat(css(input).borderTopLeftRadius),
          triggerColor: css(document.querySelector('.classic-guide-trigger')).color,
          closeOffset: distance(close.getBoundingClientRect(), icon.getBoundingClientRect()),
          dialog: dialog.getBoundingClientRect().toJSON(),
        };
      });
      assert.equal(design.sendColor, 'rgb(255, 255, 255)');
      assert.equal(design.triggerColor, 'rgb(255, 255, 255)');
      assert.ok(design.sendRadius >= 20 && design.inputRadius >= 20);
      assert.ok(design.closeOffset <= 2, 'close icon centred');
      assert.ok(design.dialog.left >= 0 && design.dialog.right <= viewport.width);
      assert.ok(design.dialog.top >= 0 && design.dialog.bottom <= viewport.height);
      assert.deepEqual(failures, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('microphone is opt-in, transcripts are reviewed before sending and spoken replies stop on close', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.voiceStarts = 0; window.voiceAborts = 0; window.spokenReplies = []; window.voiceCancels = 0;
      window.SpeechRecognition = class {
        constructor() { window.activeRecognition = this; }
        start() { window.voiceStarts++; this.onstart?.(); }
        abort() { window.voiceAborts++; this.onend?.(); }
      };
      Object.defineProperty(window, 'speechSynthesis', { value: { cancel() { window.voiceCancels++; }, speak(value) { window.spokenReplies.push(value.text); } } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    });
    let posts = 0;
    await context.route('https://voice.example/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/guide.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/guide.css') return route.fulfill({ contentType: 'text/css', body: styles });
      if (url.pathname.endsWith('/session')) return route.fulfill({ json: { csrfToken: 'voice-csrf', country: 'UG', locale: 'en-UG', aiConfigured: true } });
      if (url.pathname === '/api/v1/ai/guide') { posts++; return route.fulfill({ json: { answer: 'Open Account security to change your password.', products: [], links: [{ label: 'Security', href: '/account/security' }] } }); }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/guide.css"><script defer src="/guide.js"></script></head><body><main><h1>Marketplace</h1></main></body></html>' });
    });
    const page = await context.newPage(); await page.goto('https://voice.example/');
    await page.getByRole('button', { name: 'Open Classic AI voice and shopping guide' }).click();
    assert.equal(await page.evaluate(() => window.voiceStarts), 0);
    await page.getByRole('button', { name: 'Speak your question' }).click();
    assert.equal(await page.evaluate(() => window.voiceStarts), 1);
    await page.evaluate(() => window.activeRecognition.onresult({ results: [[{ transcript: 'Where can I change my password?' }]] }));
    await expect(page.getByRole('textbox', { name: 'How can I help?' })).toHaveValue('Where can I change my password?');
    assert.equal(posts, 0, 'voice does not automatically send potentially incorrect transcription');
    await page.getByRole('checkbox', { name: 'Read replies aloud' }).check();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.spokenReplies.length)).toBe(1);
    await page.getByRole('button', { name: 'Close Classic guide' }).click();
    assert.ok(await page.evaluate(() => window.voiceCancels) > 0);
    assert.ok(await page.evaluate(() => window.voiceAborts) > 0);
    await context.close();
  } finally { await browser.close(); }
});

test('a stalled guide connection times out and retry preserves a question after a failed request', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.clock.install();
    let firstSession, sessionReads = 0;
    await page.route('https://retry.example/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/guide.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path === '/guide.css') return route.fulfill({ contentType: 'text/css', body: styles });
      if (path.endsWith('/session')) {
        if (++sessionReads === 1) { firstSession = route; return; }
        return route.fulfill({ json: { csrfToken: 'retry-csrf', country: 'UG', locale: 'en-UG', aiConfigured: false } });
      }
      if (path === '/api/v1/ai/guide') return route.fulfill({ status: 503, json: { error: { message: 'Temporarily unavailable. Please retry.' } } });
      return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/guide.css"><script defer src="/guide.js"></script></head><body><main><h1>Marketplace</h1></main></body></html>' });
    });
    await page.goto('https://retry.example/');
    await page.getByRole('button', { name: 'Open Classic AI voice and shopping guide' }).click();
    await expect.poll(() => Boolean(firstSession)).toBe(true);
    await page.clock.fastForward(11_000);
    await expect(page.locator('.classic-guide-status')).toContainText('Connection took too long');
    await page.getByRole('button', { name: 'Close Classic guide' }).click();
    await page.getByRole('button', { name: 'Open Classic AI voice and shopping guide' }).click();
    await expect(page.locator('.classic-guide-status')).toContainText('Shopping in UG');
    await page.getByRole('textbox', { name: 'How can I help?' }).fill('Where is my profile?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.classic-guide-log')).toContainText('Temporarily unavailable');
    await expect(page.getByRole('textbox', { name: 'How can I help?' })).toHaveValue('Where is my profile?');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await firstSession.abort().catch(() => {});
  } finally { await browser.close(); }
});
