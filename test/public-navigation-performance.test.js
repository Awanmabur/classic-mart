import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shellSource = fs.readFileSync(new URL('../public/shared-shell.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function sharedHeader({ catalogue, authenticated = false, navigationError = false } = {}) {
  const calls = [], badge = { textContent: '' };
  const select = { value: 'all', options: [], replaceChildren(...options) { this.options = options; } };
  const document = {
    querySelector(selector) {
      if (selector === '.mobile-bottom-nav') return {};
      if (selector === '#searchCategory' || selector === '#searchCategory, a[href="/categories"] .tiny-badge') return select;
      if (selector === '[data-storefront-authenticated="true"]') return authenticated ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'a[href="/categories"] .tiny-badge' || selector === '[data-wishlist-count]' ? [badge] : [];
    },
    createElement() { return {}; },
  };
  const window = { ClassicMartCatalogueReady: catalogue && Promise.resolve(catalogue) };
  const context = vm.createContext({ window, document, URLSearchParams,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: !(navigationError && url.endsWith('/navigation')),
        json: async () => url.includes('/state') ? { state: { wishlist: ['prd_fixture'] } }
          : { categories: [{ id: 'electronics', name: 'Electronics' }, { id: 'books', name: 'Books' }] } };
    },
  });
  vm.runInContext(shellSource, context);
  return { calls, badge, select, window };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('an information-page header loads category metadata without fetching the full catalogue', async () => {
  const header = sharedHeader();
  await settled();
  assert.deepEqual(header.calls.map(call => call.url), ['/api/v1/storefront/navigation']);
  assert.deepEqual(header.select.options.map(option => option.textContent), ['All Categories', 'Electronics', 'Books']);
  assert.equal(header.badge.textContent, '2');
  assert.equal(header.window.ClassicMartSharedCataloguePromise, undefined, 'Metadata cannot become a cart/product full-data promise.');
});

test('a catalogue-page header shares its existing full data and saved state without extra requests', async () => {
  const header = sharedHeader({ authenticated: true, catalogue: {
    categories: [{ id: 'books', name: 'Books' }], state: { wishlist: ['prd_one', 'prd_two'] },
  } });
  await settled();
  assert.equal(header.calls.length, 0);
  assert.deepEqual(header.select.options.map(option => option.textContent), ['All Categories', 'Books']);
  assert.equal(header.badge.textContent, '2');
});

test('an authenticated information page independently requests only the current account summary', async () => {
  const header = sharedHeader({ authenticated: true, navigationError: true });
  await settled();
  assert.deepEqual(header.calls.map(call => call.url).sort(), [
    '/api/v1/storefront/navigation', '/api/v1/storefront/state?summary=1',
  ]);
  assert.equal(header.badge.textContent, '1', 'A failed navigation lookup cannot block the member summary.');
});

function serviceWorker({ cached, network, storageError = false } = {}) {
  const listeners = new Map(), calls = [], stored = [];
  const context = vm.createContext({ URL, Response,
    self: { location: { origin: 'https://classicmart.example' },
      addEventListener: (name, listener) => listeners.set(name, listener) },
    caches: { match: async () => { if (storageError) throw new Error('Cache storage unavailable'); return cached; },
      open: async () => { if (storageError) throw new Error('Cache quota exceeded'); return { put: async (...args) => stored.push(args) }; } },
    fetch: async (request, options) => {
      calls.push({ request, options });
      if (network instanceof Error) throw network;
      return network || new Response('fresh', { headers: { 'cache-control': 'public, max-age=60' } });
    },
  });
  vm.runInContext(workerSource, context);
  const dispatch = async (path, extra = {}) => {
    let result;
    listeners.get('fetch')({ request: { method: 'GET', url: 'https://classicmart.example' + path, mode: 'cors', ...extra },
      respondWith: value => { result = value; } });
    return result;
  };
  return { dispatch, calls, stored };
}

test('verified immutable static assets avoid repeat network requests', async () => {
  const worker = serviceWorker({ cached: new Response('cached', {
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  }) });
  assert.equal(await (await worker.dispatch('/styles.css?v=abcdef0123456789')).text(), 'cached');
  assert.equal(worker.calls.length, 0);
});

test('a version-shaped query does not freeze a non-immutable or private response', async () => {
  for (const policy of ['public, max-age=60', 'private, no-store, immutable']) {
    const worker = serviceWorker({ cached: new Response('stale', { headers: { 'cache-control': policy } }) });
    assert.equal(await (await worker.dispatch('/styles.css?v=abcdef0123456789')).text(), 'fresh');
    assert.equal(worker.calls.length, 1);
  }
});

test('unavailable cache storage cannot hide a valid immutable asset network response', async () => {
  const worker = serviceWorker({ storageError: true, network: new Response('working asset', {
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  }) });
  assert.equal(await (await worker.dispatch('/styles.css?v=abcdef0123456789')).text(), 'working asset');
  assert.equal(worker.calls.length, 1);
});

test('private routes and catalogue media cannot use cached bytes through the fingerprint shortcut', async () => {
  for (const path of ['/api/v1/private.js?v=abcdef0123456789', '/media/catalogue/med_fixture?v=abcdef0123456789']) {
    const worker = serviceWorker({ cached: new Response('old sensitive bytes', {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    }), network: new Response('withdrawn', { status: 404, headers: { 'cache-control': 'no-store' } }) });
    const result = await worker.dispatch(path);
    assert.equal(result.status, 404);
    assert.equal(await result.text(), 'withdrawn');
    assert.equal(worker.stored.length, 0);
    assert.equal(worker.calls.length, 1);
  }
  const offline = serviceWorker({ cached: new Response('withdrawn media'), network: new Error('offline') });
  await assert.rejects(offline.dispatch('/media/catalogue/med_fixture'), /offline/);
});
