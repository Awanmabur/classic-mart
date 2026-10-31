import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const script = await fs.readFile(new URL('../public/platform-guide.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../public/platform-guide.css', import.meta.url), 'utf8');
const name = 'Ask Classic - start voice assistant';
function setup() {
  window.starts = 0; window.aborts = 0; window.answers = []; window.cancels = 0;
  window.SpeechRecognition = class {
    constructor() { window.currentRecognition = this; }
    start() { window.starts++; this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() { window.aborts++; this.onend?.(); }
  };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  Object.defineProperty(window, 'speechSynthesis', { value: {
    cancel() { window.cancels++; },
    speak(u) { window.answers.push(u.text); u.onstart?.(); }
  } });
}
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>:root{--orange:#ff6500;--orange-dark:#ea5600;--navy:#14253d}</style><link rel="stylesheet" href="/voice.css"><script defer src="/voice.js"></script></head><body><main><h1>Mart</h1></main><button aria-label="Back to top" style="position:fixed;right:22px;bottom:22px;width:40px;height:40px"></button></body></html>';
function mock(route) {
  const path = new URL(route.request().url()).pathname;
  if (path === '/voice.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: styles });
  if (path === '/voice.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
  if (path.endsWith('/session')) return route.fulfill({ json: { csrfToken: 'voice-csrf', country: 'UG', locale: 'en-UG' } });
  if (path === '/api/v1/ai/guide') return route.fulfill({ json: { answer: 'Product costs UGX 150,000.' } });
  return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
}
test('tap immediately starts voice, recognition submits safely, reply speaks without any chat modal', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 320, height: 568 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(setup);
      let posts = 0, sessions = 0;
      await context.route('https://voice.example/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/session')) sessions++;
        if (path === '/api/v1/ai/guide') {
          posts++;
          assert.equal(route.request().headers()['x-csrf-token'], 'voice-csrf');
          assert.deepEqual(route.request().postDataJSON(), { message: 'Find a speaker', detailed: false });
        }
        return mock(route);
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('https://voice.example/');
      assert.equal(sessions, 0);
      assert.equal(await page.locator('dialog, form.classic-guide-form, input[type="text"]').count(), 0);
      const button = page.getByRole('button', { name });
      await button.click();
      await expect(page.locator('.classic-voice-status')).toContainText('Listening');
      assert.equal(await page.evaluate(() => window.starts), 1);
      await page.evaluate(() => window.currentRecognition.onresult({ results: [[{ transcript: 'Find a speaker' }]] }));
      await expect.poll(() => posts).toBe(1);
      await expect.poll(() => page.evaluate(() => window.answers.length)).toBe(1);
      assert.equal(await page.evaluate(() => window.answers[0]), 'Product costs UGX 150,000.');
      const rect = await page.locator('#classicVoiceHud').boundingBox();
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1);
      const axe = await new AxeBuilder({ page }).include('#classicVoiceHud').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(axe.violations.map(x => ({ id: x.id, nodes: x.nodes.map(y => y.target) })), []);
      await page.getByRole('button', { name: 'Stop Classic AI voice assistant' }).click();
      await expect(page.locator('#classicVoiceHud')).toBeHidden();
      assert.ok(await page.evaluate(() => window.cancels) >= 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});
test('voice trigger can be dragged and repositioned without recording, persists and supports keyboard', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 790 } });
    await context.addInitScript(setup);
    await context.route('https://drag.example/**', mock);
    const page = await context.newPage(); await page.goto('https://drag.example/');
    const button = page.getByRole('button', { name }), first = await button.boundingBox();
    const back = await page.getByRole('button', { name: 'Back to top' }).boundingBox();
    assert.ok(first.y + first.height + 8 <= back.y);
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down(); await page.mouse.move(20, 150, { steps: 8 }); await page.mouse.up();
    const moved = await button.boundingBox();
    assert.ok(moved.x >= 8 && moved.y >= 8 && moved.x + moved.width <= 382 && moved.y + moved.height <= 782);
    assert.ok(Math.abs(moved.x-first.x) > 10);
    assert.equal(await page.evaluate(() => window.starts), 0);
    await page.reload();
    assert.ok(Math.abs((await button.boundingBox()).x-moved.x) <= 2);
    await button.focus(); await page.keyboard.press('Alt+ArrowRight');
    assert.ok((await button.boundingBox()).x > moved.x);
    await page.keyboard.press('Alt+Home');
    assert.ok(Math.abs((await button.boundingBox()).y - first.y) <= 2);
    await context.close();
  } finally { await browser.close(); }
});
test('stop aborts stale guide response; unsupported speech offers a functioning alternative', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext(); await context.addInitScript(setup);
    let pending;
    await context.route('https://stop.example/**', route => {
      if (new URL(route.request().url()).pathname === '/api/v1/ai/guide') { pending = route; return; }
      return mock(route);
    });
    const page = await context.newPage(); await page.goto('https://stop.example/');
    const button = page.getByRole('button', { name }); await button.click();
    await page.evaluate(() => window.currentRecognition.onresult({ results: [[{ transcript: 'Find my orders' }]] }));
    await expect.poll(() => Boolean(pending)).toBe(true);
    await page.getByRole('button', { name: 'Stop Classic AI voice assistant' }).click();
    await pending.fulfill({ json: { answer: 'Stale, should not play' } }).catch(() => {});
    await page.waitForTimeout(75);
    assert.deepEqual(await page.evaluate(() => window.answers), []);
    await context.close();
    const without = await browser.newContext();
    await without.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
    await without.route('https://unsupported.example/**', mock);
    const noVoice = await without.newPage(); await noVoice.goto('https://unsupported.example/');
    await noVoice.getByRole('button', { name }).click();
    await expect(noVoice.locator('.classic-voice-status')).toContainText('not supported');
    await expect(noVoice.getByRole('link', { name: 'Open Classic AI without voice' })).toHaveAttribute('href', '/ask-classic');
    await without.close();
  } finally { await browser.close(); }
});
