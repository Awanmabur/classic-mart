import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/product-sharing.js', import.meta.url), 'utf8');

function fixture({ nativeShare, clipboard, legacyCopy = false, country = 'UG' } = {}) {
  const messages = [], listeners = new Map();
  const document = { activeElement: null, querySelector: selector => nodes[selector] || null,
    addEventListener: (name, callback) => listeners.set(name, callback),
    execCommand: () => typeof legacyCopy === 'function' ? legacyCopy() : legacyCopy,
    createElement: () => ({ style: {}, setAttribute() {}, select() {}, setSelectionRange() {}, remove() {} }) };
  const button = { dataset: { shareProduct: 'prd_example', shareTitle: 'Fresh marketplace product', shareUrl: 'https://untrusted.example/wrong' },
    disabled: false, setAttribute() {}, closest: () => null, focus() { document.activeElement = this; } };
  const input = { value: '', focus() { document.activeElement = this; }, select() { this.selected = true; } };
  const nodes = { '#productModal': { dataset: { shareCountry: country } },
    '#productModal:not([hidden])': { append() {} }, '#productModalShare': button,
    '#productShareFallback': { hidden: true }, '#productShareLink': input };
  document.body = { append() {} };
  document.activeElement = button;
  const window = { location: new URL('https://classicmart.example/categories?token=private#preview'),
    isSecureContext: true, ClassicMartFlash: { show: message => messages.push(message) } };
  vm.runInNewContext(source, { window, document, navigator: { share: nativeShare, clipboard }, URL });
  return { sharing: window.ClassicMartSharing, button, input, panel: nodes['#productShareFallback'], messages, listeners, document };
}

test('native sharing starts synchronously with the selected public product and country rather than the current page or an injected URL', async () => {
  const calls = [];
  const f = fixture({ nativeShare: data => { calls.push(data); return Promise.resolve(); } });
  const pending = f.sharing.shareProduct(f.button);
  assert.equal(calls.length, 1, 'the native call retains the original user activation');
  assert.equal(calls[0].url, 'https://classicmart.example/products/prd_example?country=UG');
  assert.equal(calls[0].title, 'Fresh marketplace product');
  assert.equal(await pending, 'shared');
  assert.equal(f.button.disabled, false);
  assert.deepEqual(f.messages, []);
  assert.equal(f.panel.hidden, true);
});

test('cancelling the native share sheet stays quiet and never copies a link', async () => {
  let copied = 0;
  const f = fixture({ nativeShare: async () => { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); },
    clipboard: { writeText: async () => { copied += 1; } } });
  assert.equal(await f.sharing.shareProduct(f.button), 'cancelled');
  assert.equal(copied, 0);
  assert.deepEqual(f.messages, []);
  assert.equal(f.panel.hidden, true);
  assert.equal(f.button.disabled, false);
});

test('an unavailable share API copies the canonical link and reports success only after the real clipboard promise succeeds', async () => {
  const copied = [];
  const f = fixture({ clipboard: { writeText: async value => copied.push(value) } });
  assert.equal(await f.sharing.shareProduct(f.button), 'copied');
  assert.deepEqual(copied, ['https://classicmart.example/products/prd_example?country=UG']);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /link copied/i);
  assert.equal(f.panel.hidden, true);
});

test('denied clipboard access and a failed legacy copy reveal a selectable link without claiming it was copied', async () => {
  const f = fixture({ clipboard: { writeText: async () => { throw new Error('Permission denied'); } } });
  assert.equal(await f.sharing.shareProduct(f.button), 'manual');
  assert.equal(f.panel.hidden, false);
  assert.equal(f.input.value, 'https://classicmart.example/products/prd_example?country=UG');
  assert.equal(f.input.selected, true);
  assert.deepEqual(f.messages, []);
});

test('a superseded preview cannot show an old share fallback or enable a new loading toolbar', async () => {
  let rejectShare;
  const f = fixture({ nativeShare: () => new Promise((_resolve, reject) => { rejectShare = reject; }) });
  const pending = f.sharing.shareProduct(f.button);
  f.sharing.closeFallback();
  f.button.dataset.shareProduct = 'prd_another';
  f.button.disabled = true;
  rejectShare(new Error('Native sharing unavailable'));
  assert.equal(await pending, 'cancelled');
  assert.equal(f.button.disabled, true);
  assert.equal(f.panel.hidden, true);
  assert.deepEqual(f.messages, []);
});

test('share destinations reject non-product identifiers and never include navigation parameters', () => {
  const f = fixture({ country: 'UG&token=private' });
  assert.equal(f.sharing.productUrl('prd_example'), 'https://classicmart.example/products/prd_example');
  for (const id of ['', '../account', 'https://untrusted.example', 'prd_example?token=private', '<script>']) {
    assert.equal(f.sharing.productUrl(id), '');
  }
});

test('a delayed successful clipboard write stays quiet after the product preview is superseded', async () => {
  let finishCopy;
  const f = fixture({ clipboard: { writeText: () => new Promise(resolve => { finishCopy = resolve; }) } });
  const pending = f.sharing.shareProduct(f.button);
  f.sharing.closeFallback();
  f.button.dataset.shareProduct = 'prd_another';
  f.button.disabled = true;
  finishCopy();
  assert.equal(await pending, 'cancelled');
  assert.equal(f.button.disabled, true);
  assert.equal(f.panel.hidden, true);
  assert.deepEqual(f.messages, []);
});

test('a delayed clipboard rejection does not try legacy copying after the preview closes', async () => {
  let rejectCopy, legacyCopies = 0;
  const f = fixture({ clipboard: { writeText: () => new Promise((_resolve, reject) => { rejectCopy = reject; }) },
    legacyCopy: () => { legacyCopies += 1; return true; } });
  const pending = f.sharing.shareProduct(f.button);
  f.sharing.closeFallback();
  rejectCopy(new Error('Permission denied'));
  assert.equal(await pending, 'cancelled');
  assert.equal(legacyCopies, 0);
  assert.deepEqual(f.messages, []);
});

for (const outcome of ['success', 'failure']) {
  test(`a stale manual-copy ${outcome} cannot close or steal focus from a newer product share panel`, async () => {
    let finishCopy;
    const f = fixture({ clipboard: { writeText: () => new Promise((resolve, reject) => {
      finishCopy = outcome === 'success' ? resolve : () => reject(new Error('Permission denied'));
    }) } });
    f.panel.hidden = false;
    f.input.value = 'https://classicmart.example/products/prd_example?country=UG';
    const pending = f.listeners.get('click')({ target: { closest: selector =>
      ['#productShareFallback, #productModalShare', '[data-copy-share-link]'].includes(selector) ? {} : null } });
    f.sharing.closeFallback();
    f.panel.hidden = false;
    f.input.value = 'https://classicmart.example/products/prd_another?country=UG';
    const newControl = {};
    f.document.activeElement = newControl;
    finishCopy();
    await pending;
    assert.equal(f.panel.hidden, false);
    assert.equal(f.input.value, 'https://classicmart.example/products/prd_another?country=UG');
    assert.equal(f.document.activeElement, newControl);
    assert.deepEqual(f.messages, []);
  });
}
