import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('official logo, fixed shopping top and home hero cleanup are applied', () => {
  const home = read('views/index.ejs');
  const styles = read('public/styles.css');
  assert.match(home, /\/assets\/classic-mart-logo\.png/);
  assert.doesNotMatch(home, /cmsBanner/);
  assert.match(styles, /\.utility-bar \{ position: sticky; top: 0; z-index: 910; \}/);
  assert.match(styles, /\.site-header \{ position: sticky; top: 39px; z-index: 900;/);
});

test('search bar keeps its existing shell while adding live image and voice controls', () => {
  const products = read('views/products.ejs');
  const searchTools = read('public/search-tools.js');
  const routes = read('src/routes/storefront.js');
  assert.match(products, /class="search-bar" id="searchForm"/);
  assert.match(products, /data-image-search/);
  assert.match(products, /data-voice-search/);
  assert.match(products, /class="search-button"/);
  assert.match(searchTools, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(searchTools, /classicmart:visual-search-results/);
  assert.doesNotMatch(searchTools, /localStorage|sessionStorage/);
  assert.match(searchTools, /body\.append\('transfer', hasResultSurface \? '0' : '1'\)/);
  assert.match(searchTools, /window\.location\.assign\('\/search\?visual=1'\)/);
  assert.match(routes, /\/api\/v1\/storefront\/search-by-image/);
  assert.match(routes, /request\.session\.visualSearch/);
  assert.match(routes, /\/api\/v1\/storefront\/visual-search-results/);
  assert.match(routes, /verifyDeferredCsrf\(request\)/);
  assert.match(routes, /scanUpload\(request\.file\.buffer\)/);
});

test('newsletter is visible and persists consent-safe encrypted subscriptions', () => {
  const home = read('views/index.ejs');
  const client = read('public/newsletter.js');
  const route = read('src/routes/newsletter.js');
  const model = read('src/models/NewsletterSubscription.js');
  assert.match(home, /id="newsletterForm"/);
  assert.match(home, /Enter your email address/);
  assert.match(client, /x-csrf-token/);
  assert.match(route, /encryptSensitive\(email\)/);
  assert.match(route, /normalizeEmail\(request\.user\.email\) === email/);
  assert.match(model, /emailHash/);
  assert.match(model, /emailEncrypted/);
});

test('product links reuse the same EJS preview on the current page with one live price', () => {
  const catalogue = read('views/products.ejs');
  const homeScript = read('public/script.js');
  const sharedScript = read('public/product-preview.js');
  assert.match(catalogue, /include\("partials\/product-preview-modal"\)/);
  assert.match(catalogue, /\/product-preview\.js/);
  assert.match(sharedScript, /event\.preventDefault\(\);\s*await openProduct\(decodeURIComponent\(match\[1\]\)\)/s);
  assert.match(sharedScript, /product\.price \* quantity/);
  assert.match(homeScript, /product\.price \* quantity/);
  assert.doesNotMatch(sharedScript, /previewLineTotal|previewUnitPriceNote|preview-line-total/);
  assert.doesNotMatch(homeScript, /previewLineTotal|previewUnitPriceNote|preview-line-total/);
});
