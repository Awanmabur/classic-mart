import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const generators = [
  "public/compare.js",
  "public/people-page.js",
  "public/wishlist.js",
  "public/profile-page.js",
  "public/catalog-page.js",
  "public/cart-page.js",
  "public/product-preview.js",
  "public/script.js"
];

test('generated image markup uses inert fallback attributes instead of CSP-blocked inline handlers', () => {
  for (const path of generators) {
    const code = read(path);
    assert.doesNotMatch(code, /onerror\s*=\s*["']/i, path);
    assert.match(code, /data-fallback-src="\/assets\/(?:product|image)-placeholder\.svg"/, path);
  }
});

test('shared image fallback handles both declared placeholders and existing images', () => {
  const code = read('public/image-fallback.js');
  assert.match(code, /addEventListener\(\s*'error'/);
  assert.match(code, /getAttribute\('data-fallback-src'\)/);
  assert.match(code, /image\.src = fallback/);
  assert.match(code, /image\.dataset\.classicMartImageFallback/);
  for (const view of [
    'views/index.ejs', 'views/products.ejs', 'views/categories.ejs', 'views/cart.ejs',
    'views/compare.ejs', 'views/wishlist.ejs', 'views/sellers.ejs', 'views/promoters.ejs',
    'views/seller-profile.ejs', 'views/promoter-profile.ejs',
  ]) {
    assert.match(read(view), /src="\/image-fallback\.js"/, view);
  }
});

test('cart first paint uses country currency rather than a US-dollar placeholder', () => {
  const view = read('views/cart.ejs');
  assert.doesNotMatch(view, /\$0\.00/);
  assert.ok(view.includes('<strong data-total-final=""><%= formatMoney(0) %></strong>'));
  assert.ok(view.includes('data-market-currency='));
  assert.ok(view.includes('data-market-locale='));
  assert.ok(read('public/cart-page.js').includes('document.body.dataset.marketCurrency'));
  assert.ok(read('public/cart-page.js').includes('document.body.dataset.marketLocale'));
});

test('first catalog card photos are eager, later images remain lazy', () => {
  assert.ok(read('views/partials/catalogue-cards.ejs').includes("cardIndex === 0 ? 'eager' : 'lazy'"));
  assert.ok(read('views/categories.ejs').includes("cardIndex === 0 ? 'eager' : 'lazy'"));
  assert.ok(read('public/catalog-page.js').includes("index === 0 ? 'eager' : 'lazy'"));
});

test('directory sort controls have screen-reader labels', () => {
  assert.ok(read('views/sellers.ejs').includes('<span class="sr-only">Sort sellers</span>'));
  assert.ok(read('views/promoters.ejs').includes('<span class="sr-only">Sort promoters</span>'));
});
