import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routes = fs.readFileSync(new URL('../src/routes/storefront.js', import.meta.url), 'utf8');
const homepage = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const cataloguePage = fs.readFileSync(new URL('../public/catalog-page.js', import.meta.url), 'utf8');

function routeBlock(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Could not isolate route block: ${start}`);
  return source.slice(from, to);
}

test('public catalogue endpoint does not reference seller-directory pagination state', () => {
  const block = routeBlock(
    routes,
    "router.get('/api/v1/storefront/catalogue'",
    "router.get('/api/v1/storefront/search'",
  );
  assert.match(block, /getStorefront\(request\.country\)/);
  assert.match(block, /state:\s*customerState/);
  assert.match(block, /csrfToken:/);
  assert.doesNotMatch(block, /sellerPage/);
});

test('homepage and catalogue pages both consume the same working public catalogue endpoint', () => {
  assert.match(homepage, /fetch\("\/api\/v1\/storefront\/catalogue"/);
  assert.match(cataloguePage, /'\/api\/v1\/storefront\/catalogue'/);
});
