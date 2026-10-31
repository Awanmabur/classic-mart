import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const script = await fs.readFile(new URL('../public/loading-feedback.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../public/loading-feedback.css', import.meta.url), 'utf8');
const recordStyles = await fs.readFile(new URL('../public/record-actions.css', import.meta.url), 'utf8');
const dialogIsolationScript = await fs.readFile(new URL('../public/dialog-isolation.js', import.meta.url), 'utf8');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/loading-feedback.css"><script defer src="/loading-feedback.js"></script></head><body>
<a id="next" href="/next">Next page</a><a id="hash" href="#section">Same page</a><a id="download" download="sample.txt" href="/download">Download</a>
<a id="external" href="https://other.example/" target="_blank">External</a><a id="cancelled" href="/cancelled">Cancelled</a>
<form id="save" action="/save" method="post"><input name="_csrf" value="fixture-csrf"><button type="submit" name="intent" value="publish">Save record</button></form><div id="section">Section</div></body></html>`;

test('loading feedback follows actual work without changing requests, cancelled actions or restored form controls', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  const contexts = [];
  async function setup(extra = {}, initialize) {
    const context = await browser.newContext(extra); contexts.push(context);
    if (initialize) await context.addInitScript(initialize);
    await context.route('https://loading.example/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/loading-feedback.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/loading-feedback.css') return route.fulfill({ contentType: 'text/css', body: styles });
      return route.fulfill({ contentType: 'text/html', body: fixture });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://loading.example/');
    return { context, page, errors };
  }
  try {
    await t.test('fast requests add no forced delay or visible loader, and reinitialization is idempotent', async () => {
      const { page, errors } = await setup();
      await page.evaluate(async () => {
        const original = window.fetch;
        await fetch('/fast');
        window.originalFeedbackFetch = original;
      });
      await page.addScriptTag({ content: script });
      assert.equal(await page.evaluate(() => window.fetch === window.originalFeedbackFetch), true);
      await page.waitForTimeout(350);
      await expect(page.locator('[data-platform-loading]')).toBeHidden();
      assert.deepEqual(errors, []);
    });

    await t.test('overlapping GET and POST requests stay pending until both finish and keep request data unchanged', async () => {
      const { page, errors } = await setup();
      const pending = [], requests = [];
      await page.route('https://loading.example/api/**', route => { requests.push(route.request()); pending.push(route); });
      await page.evaluate(() => {
        window.pendingRequests = Promise.all([
          fetch('/api/read', { headers: { 'X-Fixture': 'read' } }).then(response => response.text()),
          fetch(new Request(location.origin + '/api/write', { method: 'POST', credentials: 'same-origin', headers: { 'X-Fixture': 'write' }, body: 'intent=publish&_csrf=fixture' })).then(response => response.text()),
        ]);
      });
      await expect.poll(() => pending.length).toBe(2);
      const loader = page.locator('[data-platform-loading]');
      await expect(loader).toBeVisible();
      await expect(loader).toHaveAttribute('role', 'status');
      await expect(loader).toHaveText('Working…');
      const center = await loader.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { x: Math.abs(box.x + box.width / 2 - innerWidth / 2), y: Math.abs(box.y + box.height / 2 - innerHeight / 2) };
      });
      assert.ok(center.x <= 1 && center.y <= 1, 'pending-work indicator is centered in the viewport');
      const write = requests.find(request => request.method() === 'POST');
      assert.equal(write.postData(), 'intent=publish&_csrf=fixture');
      assert.equal(write.headers()['x-fixture'], 'write');
      await pending.find(route => route.request().method() === 'GET').fulfill({ contentType: 'text/plain', body: 'read' });
      await expect(loader).toBeVisible();
      await pending.find(route => route.request().method() === 'POST').fulfill({ contentType: 'text/plain', body: 'write' });
      assert.deepEqual(await page.evaluate(() => window.pendingRequests), ['read', 'write']);
      await expect(loader).toBeHidden();
      assert.deepEqual(errors, []);
    });

    await t.test('AJAX submit cancellation avoids navigation locks and a failed response leaves controls usable', async () => {
      const { page, errors } = await setup();
      let pending;
      await page.route('https://loading.example/api/save', route => { pending = route; });
      await page.evaluate(() => {
        const form = document.querySelector('#save');
        form.addEventListener('submit', event => {
          event.preventDefault();
          window.savePromise = fetch('/api/save', { method: 'POST', body: new FormData(form, event.submitter) })
            .then(response => { if (!response.ok) throw new Error('Save was rejected'); })
            .catch(error => { window.saveError = error.message; });
        });
      });
      await page.getByRole('button', { name: 'Save record' }).click();
      const loader = page.locator('[data-platform-loading]');
      await expect(loader).toBeVisible();
      await expect(page.locator('#save')).not.toHaveAttribute('aria-busy');
      await expect(page.getByRole('button', { name: 'Save record' })).not.toHaveAttribute('aria-disabled');
      assert.match(pending.request().postData(), /name="intent"\r\n\r\npublish/);
      await pending.fulfill({ status: 422, contentType: 'text/plain', body: 'Rejected' });
      await page.evaluate(() => window.savePromise);
      assert.equal(await page.evaluate(() => window.saveError), 'Save was rejected');
      await expect(loader).toBeHidden();
      await expect(page.getByRole('button', { name: 'Save record' })).toBeEnabled();
      assert.deepEqual(errors, []);
    });

    await t.test('feedback continues beyond response headers through the actual JSON/text body read without consuming twice', async () => {
      for (const reader of ['json', 'text']) {
        const { page, errors } = await setup({}, () => {
          const originalFetch = window.fetch;
          window.fetch = function (input) {
            if (input !== '/api/stream') return Reflect.apply(originalFetch, this, arguments);
            const stream = new ReadableStream({ start(controller) {
              controller.enqueue(new TextEncoder().encode('{"saved":'));
              window.finishBody = () => { controller.enqueue(new TextEncoder().encode('true}')); controller.close(); };
              window.failBody = () => controller.error(new DOMException('The fixture body was aborted', 'AbortError'));
            } });
            return Promise.resolve(new Response(stream, { status: 202, headers: { 'Content-Type': 'application/json', 'X-Fixture': 'body' } }));
          };
        });
        await page.evaluate(reader => {
          window.readOutcome = (async () => {
            const response = await fetch('/api/stream');
            window.streamHeaders = { native: response instanceof Response, status: response.status,
              header: response.headers.get('X-Fixture'), bodyUsed: response.bodyUsed };
            const value = await response[reader]();
            window.streamBodyUsed = response.bodyUsed;
            return value;
          })();
        }, reader);
        await expect.poll(() => page.evaluate(() => Boolean(window.streamHeaders))).toBe(true);
        assert.deepEqual(await page.evaluate(() => window.streamHeaders), { native: true, status: 202, header: 'body', bodyUsed: false });
        const loader = page.locator('[data-platform-loading]');
        await expect(loader).toBeVisible();
        await page.evaluate(() => window.finishBody());
        assert.deepEqual(await page.evaluate(() => window.readOutcome), reader === 'json' ? { saved: true } : '{"saved":true}');
        assert.equal(await page.evaluate(() => window.streamBodyUsed), true);
        await expect(loader).toBeHidden();
        assert.equal(await page.evaluate(() => fetch('/api/stream').then(async response => {
          window.finishBody(); await response.text();
          return response.json().then(() => 'unexpected', error => error.name);
        })), 'TypeError', 'An already consumed body still fails with the native error.');
        await expect(loader).toBeHidden();
        await page.evaluate(() => {
          window.failedBody = fetch('/api/stream').then(response => response.json()).catch(error => error.name);
        });
        await expect(loader).toBeVisible();
        await page.evaluate(() => window.failBody());
        const nativeError = await page.evaluate(async () => {
          const response = new Response(new ReadableStream({ start(controller) {
            controller.error(new DOMException('The fixture body was aborted', 'AbortError'));
          } }));
          try { await Response.prototype.json.call(response); } catch (error) { return error.name; }
        });
        assert.equal(await page.evaluate(() => window.failedBody), nativeError, 'A failed body must retain its native reader error.');
        await expect(loader).toBeHidden();
        assert.deepEqual(errors, []);
      }
    });

    await t.test('aborted and network-failed fetches preserve their error and always release the indicator', async () => {
      const { page, errors } = await setup();
      let pending;
      await page.route('https://loading.example/api/abort', route => { pending = route; });
      await page.evaluate(() => {
        window.abortController = new AbortController();
        window.abortPromise = fetch('/api/abort', { method: 'POST', signal: window.abortController.signal })
          .catch(error => { window.abortName = error.name; });
      });
      const loader = page.locator('[data-platform-loading]');
      await expect(loader).toBeVisible();
      await page.evaluate(() => window.abortController.abort());
      await page.evaluate(() => window.abortPromise);
      assert.equal(await page.evaluate(() => window.abortName), 'AbortError');
      await expect(loader).toBeHidden();
      await pending.abort().catch(() => {});
      await page.route('https://loading.example/api/fail', route => route.abort('failed'));
      assert.equal(await page.evaluate(() => fetch('/api/fail').then(() => 'unexpected', error => error.name)), 'TypeError');
      await expect(loader).toBeHidden();
      assert.deepEqual(errors, []);
    });

    await t.test('native submit preserves submitter fields, blocks duplicate sends and resets after a real response', async () => {
      const { page, errors } = await setup();
      let pending;
      const requests = [];
      const observations = [];
      page.on('console', message => { if (message.text().startsWith('LOADING_OBSERVATION:')) observations.push(JSON.parse(message.text().slice('LOADING_OBSERVATION:'.length))); });
      await page.route('https://loading.example/save', route => { requests.push(route.request()); pending = route; });
      await page.evaluate(() => {
        const form = document.querySelector('#save'), button = form.querySelector('button');
        setTimeout(() => form.requestSubmit(button), 0);
        setTimeout(() => {
          const loader = document.querySelector('[data-platform-loading]');
          console.log('LOADING_OBSERVATION:' + JSON.stringify({ visible: Boolean(loader && !loader.hidden && loader.getBoundingClientRect().width),
            text: loader?.textContent, busy: form.getAttribute('aria-busy') }));
          form.requestSubmit(button);
        }, 600);
      });
      const loader = page.locator('[data-platform-loading]');
      // Browser evaluation/locators wait on a pending document navigation. The
      // outgoing document reports its actual DOM before its response arrives.
      await expect.poll(() => observations.length).toBe(1);
      assert.deepEqual(observations[0], { visible: true, text: 'Loading page…', busy: 'true' });
      await page.waitForTimeout(100);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].postData(), '_csrf=fixture-csrf&intent=publish');
      await pending.fulfill({ contentType: 'text/html', body: fixture });
      await page.waitForURL('https://loading.example/save');
      await expect(page.locator('[data-platform-loading]')).toBeHidden();
      await expect(page.getByRole('button', { name: 'Save record' })).not.toHaveAttribute('aria-disabled');
      assert.deepEqual(errors, []);
    });

    await t.test('cancelled submits and links, hash links, external new tabs and downloads do not start page feedback', async () => {
      const { page, context, errors } = await setup();
      await context.route('https://other.example/**', route => route.fulfill({ contentType: 'text/html', body: '<p>External</p>' }));
      await page.route('https://loading.example/download', route => route.fulfill({ contentType: 'text/plain', headers: { 'Content-Disposition': 'attachment; filename="sample.txt"' }, body: 'fixture' }));
      await page.evaluate(() => {
        // A late window handler can still cancel after loading's own listener.
        window.addEventListener('click', event => { if (event.target.id === 'cancelled') event.preventDefault(); });
        window.addEventListener('submit', event => event.preventDefault());
      });
      await page.locator('#cancelled').click();
      await page.getByRole('button', { name: 'Save record' }).click();
      await page.locator('#hash').click();
      const popupEvent = page.waitForEvent('popup');
      await page.locator('#external').click();
      const popup = await popupEvent; await popup.close();
      const downloaded = page.waitForEvent('download');
      await page.locator('#download').click();
      await downloaded;
      await page.waitForTimeout(400);
      await expect(page.locator('[data-platform-loading]')).toBeHidden();
      await expect(page.locator('#save')).not.toHaveAttribute('aria-busy');
      assert.deepEqual(errors, []);
    });

    await t.test('same-origin page navigation shows feedback while the actual document is pending', async () => {
      const { page, errors } = await setup();
      let pending;
      const observations = [];
      page.on('console', message => { if (message.text().startsWith('LOADING_OBSERVATION:')) observations.push(JSON.parse(message.text().slice('LOADING_OBSERVATION:'.length))); });
      await page.route('https://loading.example/next', route => { pending = route; });
      await page.evaluate(() => {
        setTimeout(() => document.querySelector('#next').click(), 0);
        setTimeout(() => {
          const loader = document.querySelector('[data-platform-loading]');
          console.log('LOADING_OBSERVATION:' + JSON.stringify({ visible: Boolean(loader && !loader.hidden && loader.getBoundingClientRect().width), text: loader?.textContent }));
        }, 600);
      });
      const loader = page.locator('[data-platform-loading]');
      await expect.poll(() => observations.length).toBe(1);
      assert.deepEqual(observations[0], { visible: true, text: 'Loading page…' });
      await pending.fulfill({ contentType: 'text/html', body: fixture });
      await page.waitForURL('https://loading.example/next');
      await expect(page.locator('[data-platform-loading]')).toBeHidden();
      assert.deepEqual(errors, []);
    });

    await t.test('attachment responses clear navigation feedback for ordinary links and native form exports without replacing the page', async () => {
      const { page, errors } = await setup();
      await page.route('https://loading.example/download', route => route.fulfill({ contentType: 'text/plain', headers: { 'Content-Disposition': 'attachment; filename="sample.txt"' }, body: 'fixture' }));
      await page.route('https://loading.example/business/statement.csv', route => route.fulfill({ contentType: 'text/csv', headers: { 'Content-Disposition': 'attachment; filename="export.csv"' }, body: 'record,status\nfixture,ready\n' }));
      await page.evaluate(() => {
        document.querySelector('#download').removeAttribute('download');
        document.querySelector('#save').action = '/business/statement.csv';
      });
      const file = page.waitForEvent('download');
      await page.locator('#download').click();
      const download = await file; await download.cancel();
      await page.waitForTimeout(350);
      await expect(page.locator('[data-platform-loading]')).toBeHidden();
      assert.equal(page.url(), 'https://loading.example/');
      const exported = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Save record' }).click();
      const exportFile = await exported; await exportFile.cancel();
      await page.waitForTimeout(350);
      await expect(page.locator('[data-platform-loading]')).toBeHidden();
      await expect(page.locator('#save')).not.toHaveAttribute('aria-busy');
      await expect(page.getByRole('button', { name: 'Save record' })).not.toHaveAttribute('aria-disabled');
      assert.equal(page.url(), 'https://loading.example/');
      assert.deepEqual(errors, []);
    });

    await t.test('restored-page cleanup resets busy state, fits mobile and respects reduced motion', async () => {
      const { page, errors } = await setup({ viewport: { width: 320, height: 700 }, reducedMotion: 'reduce' });
      await page.evaluate(() => {
        window.pendingTask = window.ClassicMartLoading.track(new Promise(resolve => { window.finishTask = resolve; }));
      });
      const loader = page.locator('[data-platform-loading]');
      await expect(loader).toBeVisible();
      const appearance = await loader.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { right: box.right, left: box.left, pointerEvents: getComputedStyle(element).pointerEvents,
          animation: getComputedStyle(element.querySelector('.platform-loading-spinner')).animationName };
      });
      assert.ok(appearance.left >= 0 && appearance.right <= 320);
      assert.equal(appearance.pointerEvents, 'none');
      assert.equal(appearance.animation, 'none');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await expect(loader).toBeHidden();
      await page.evaluate(async () => { window.finishTask('done'); await window.pendingTask; });
      assert.deepEqual(errors, []);
    });

    await t.test('pending work remains visible and accessible in a real native modal top layer, then returns to body', async () => {
      const { page, errors } = await setup({ viewport: { width: 390, height: 780 } });
      await page.addStyleTag({ content: recordStyles });
      let pending;
      await page.route('https://loading.example/api/dialog', route => { pending = route; });
      await page.evaluate(() => {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'transform:translate(20px, 10px);overflow:hidden;width:150px;height:90px';
        const dialog = document.createElement('dialog');
        dialog.id = 'record-dialog'; dialog.className = 'record-modal';
        dialog.innerHTML = '<header class="record-modal-header"><h2>Save record</h2><button>Close</button></header><div class="record-modal-content">Record content</div>';
        wrapper.append(dialog); document.body.append(wrapper); dialog.showModal();
        window.dialogRequest = fetch('/api/dialog', { method: 'POST' }).then(response => response.text());
      });
      const loader = page.locator('[data-platform-loading]');
      await expect(loader).toBeVisible();
      await expect(page.getByRole('status')).toHaveText('Working…');
      const placement = await loader.evaluate(element => {
        const box = element.getBoundingClientRect();
        element.style.pointerEvents = 'auto';
        const topmost = element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        element.style.removeProperty('pointer-events');
        return { host: element.parentElement.id, topmost, left: box.left, right: box.right, top: box.top,
          centerX: Math.abs(box.x + box.width / 2 - innerWidth / 2), centerY: Math.abs(box.y + box.height / 2 - innerHeight / 2),
          inert: Boolean(element.closest('[inert]')), position: getComputedStyle(element).position };
      });
      assert.equal(placement.host, 'record-dialog');
      assert.equal(placement.topmost, true, 'The native dialog backdrop must not cover the loading indicator.');
      assert.equal(placement.inert, false);
      assert.equal(placement.position, 'fixed');
      assert.ok(placement.left >= 0 && placement.right <= 390 && placement.top >= 0 && placement.centerX <= 1 && placement.centerY <= 1,
        'Top-layer hosting must keep loading centered despite an overflowing transformed ancestor.');
      await page.evaluate(() => document.querySelector('#record-dialog').close());
      await expect.poll(() => loader.evaluate(element => element.parentElement === document.body)).toBe(true);
      await expect(loader).toBeVisible();
      await pending.fulfill({ contentType: 'text/plain', body: 'Saved' });
      assert.equal(await page.evaluate(() => window.dialogRequest), 'Saved');
      await expect(loader).toBeHidden();
      assert.deepEqual(errors, []);
    });

    await t.test('custom modal isolation keeps the pending status accessible while retaining focus and restoring author inert states', async () => {
      const { page, errors } = await setup();
      await page.addScriptTag({ content: dialogIsolationScript });
      let pending;
      await page.route('https://loading.example/api/custom-dialog', route => { pending = route; });
      await page.evaluate(() => {
        const authorInert = document.createElement('section'); authorInert.id = 'author-inert'; authorInert.setAttribute('inert', 'author');
        authorInert.innerHTML = '<button>Unavailable author control</button>';
        const backdrop = document.createElement('div'); backdrop.id = 'custom-backdrop';
        const dialog = document.createElement('section'); dialog.id = 'custom-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Product preview');
        dialog.innerHTML = '<button id="custom-close" type="button">Close preview</button>';
        document.body.append(authorInert, backdrop, dialog);
        window.ClassicMartDialogIsolation.activate(dialog, [backdrop]);
        window.customDialogRequest = fetch('/api/custom-dialog', { method: 'POST' }).then(response => response.text());
      });
      const loader = page.locator('[data-platform-loading]');
      await expect(loader).toBeVisible();
      await expect(page.getByRole('status')).toHaveText('Working…');
      assert.equal(await loader.evaluate(element => Boolean(element.closest('[inert]'))), false);
      await expect(page.locator('#custom-close')).toBeFocused();
      assert.equal(await page.locator('#next').getAttribute('inert'), '');
      await page.evaluate(() => document.querySelector('#next').focus());
      await expect(page.locator('#custom-close')).toBeFocused();
      await page.evaluate(() => {
        const dialog = document.querySelector('#custom-dialog');
        window.ClassicMartDialogIsolation.release(dialog); dialog.hidden = true;
        document.querySelector('#custom-backdrop').remove(); document.querySelector('#next').focus();
      });
      await expect(page.locator('#next')).not.toHaveAttribute('inert');
      await expect(page.locator('#author-inert')).toHaveAttribute('inert', 'author');
      await expect(page.locator('#next')).toBeFocused();
      await expect(loader).toBeVisible();
      assert.equal(await loader.evaluate(element => Boolean(element.closest('[inert]'))), false);
      await pending.fulfill({ contentType: 'text/plain', body: 'Ready' });
      assert.equal(await page.evaluate(() => window.customDialogRequest), 'Ready');
      await expect(loader).toBeHidden();
      assert.deepEqual(errors, []);
    });
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
});
