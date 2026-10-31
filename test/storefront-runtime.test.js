import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../views/index.ejs', import.meta.url), 'utf8');
const publicRoutes = fs.readFileSync(new URL('../src/routes/public.js', import.meta.url), 'utf8');
const seed = fs.readFileSync(new URL('../scripts/seed.js', import.meta.url), 'utf8');

test('homepage declares storefront state before any state access', () => {
  const declaration = script.indexOf('const state = {');
  const firstAccess = script.indexOf('state.');
  assert.ok(declaration >= 0, 'public/script.js must declare storefront state');
  assert.ok(firstAccess > declaration, 'storefront state must be declared before first access');
  assert.match(script, /cart:\s*window\.ClassicMartCart\?\.asLegacyCart/);
  assert.match(script, /wishlist:\s*\[\]/);
  assert.match(script, /recent:\s*\[\]/);
});

test('homepage boots from the MongoDB catalogue before client refresh', () => {
  assert.match(index, /id="initialStorefrontData"\s+type="application\/json"/);
  assert.match(script, /readInitialStorefront\(\)/);
  assert.match(script, /initialStorefront\.products/);
  assert.match(publicRoutes, /await getStorefront\(request\.country\)/);
  assert.match(publicRoutes, /initialStorefrontJson/);
  assert.match(publicRoutes, /initialStorefront:\s*catalogue/);
  assert.match(index, /initialStorefront\?\.products\?\.length/);
});

test('development seed publishes real catalogue products to configured countries', () => {
  assert.match(seed, /status:\s*'published'/);
  assert.match(seed, /countries:\s*countries\.map\(\(country\) => country\.code\)/);
  assert.match(seed, /products:\s*12|products\.length/);
});
