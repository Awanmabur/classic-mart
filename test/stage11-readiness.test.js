import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function openapi() { return JSON.parse(read('public/openapi-v1.json')); }

test('Stage 11 mobile network contract stays server-authoritative and versioned', () => {
  const routes = read('src/routes/stage11.js');
  for (const token of [
    "'/api/v1/mobile/catalogue'", "'/api/v1/mobile/cart'", "'/api/v1/mobile/checkout/review'",
    "'/api/v1/mobile/orders'", "'/api/v1/mobile/orders/:id/payment-intents'",
  ]) assert.match(routes, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const service of ['getStorefront','getOrCreateCart','reviewCheckout','placeOrder','initiatePayment']) assert.match(routes, new RegExp(service));
  assert.match(routes, /apiVersion:\s*'v1'/);
  assert.match(routes, /requestId:/);
  assert.match(routes, /Cache-Control/);
  assert.match(read('src/middleware/csrf.js'), /Bearer-authenticated mobile\/seller APIs are not authorized by ambient browser cookies/);
});

test('Stage 11 background/offline behavior cannot fabricate trusted commerce state', () => {
  const sw = read('public/sw.js');
  for (const prefix of ['/api/','/account','/dashboard','/cart','/checkout','/track-order','/payments','/admin','/seller','/business']) {
    assert.match(sw, new RegExp(prefix.replace(/\//g, '\\/')));
  }
  assert.match(sw, /fetch\(request,\{cache:'no-store'\}\)/);
  assert.match(sw, /caches\.match\('\/offline'\)/);
  assert.match(sw, /showNotification/);
  const maintenance = read('src/services/maintenance.js');
  assert.match(maintenance, /processPushOutbox/);
  assert.match(maintenance, /deliverWebhookBatch/);
});

test('Stage 11 installable client has store-ready icons and an honest cross-platform surface', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((x) => x.sizes === '192x192' && x.type === 'image/png'));
  assert.ok(manifest.icons.some((x) => x.sizes === '512x512' && x.type === 'image/png'));
  assert.equal(fs.existsSync(path.join(root, 'public/assets/pwa-192.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'public/assets/pwa-512.png')), true);
  assert.match(read('views/index.ejs'), /Classic Mart PWA/);
  assert.doesNotMatch(read('views/index.ejs'), /PLANNED FOR<strong>Stage 11/);
  assert.match(read('src/app.js'), /apple-touch-icon/);
  assert.match(read('views/mobile-app.ejs'), /same secure marketplace/i);
});

test('Stage 11 accessibility and mobile-shell controls expose names and viewport support', () => {
  const appView = read('views/mobile-app.ejs');
  const connected = read('views/connected-apps.ejs');
  for (const html of [appView, connected]) assert.match(html, /name="viewport"/);
  assert.match(appView, /alt="Classic Mart"/);
  assert.match(appView, /data-pwa-install/);
  assert.match(connected, /Revoke/);
  assert.match(read('public/pwa.js'), /beforeinstallprompt/);
  assert.match(read('public/sw.js'), /notificationclick/);
});

test('Stage 11 OpenAPI covers every supported mobile commerce surface and seller write guard', () => {
  const api = openapi();
  const required = [
    '/api/v1/mobile/auth/login','/api/v1/mobile/auth/refresh','/api/v1/mobile/auth/logout',
    '/api/v1/mobile/catalogue','/api/v1/mobile/products/{id}','/api/v1/mobile/me',
    '/api/v1/mobile/cart','/api/v1/mobile/cart/items','/api/v1/mobile/cart/items/{variantId}',
    '/api/v1/mobile/checkout/review','/api/v1/mobile/orders','/api/v1/mobile/orders/{id}',
    '/api/v1/mobile/orders/{id}/payment-intents','/api/v1/mobile/push-devices','/api/v1/mobile/push-devices/{id}',
    '/api/v1/seller/products','/api/v1/seller/inventory','/api/v1/seller/inventory/{id}/adjust',
    '/api/v1/seller/orders','/api/v1/seller/orders/{id}/{action}','/api/v1/seller/webhooks/test',
  ];
  for (const pathName of required) assert.ok(api.paths[pathName], `${pathName} missing from OpenAPI`);
  const adjust = api.paths['/api/v1/seller/inventory/{id}/adjust'].post.parameters;
  assert.ok(adjust.some((p) => p.name === 'If-Match' && p.required));
  assert.ok(adjust.some((p) => p.name === 'Idempotency-Key' && p.required));
});

test('Stage 11 seller developer portal is wired, CSRF protected and secrets are one-time reveal only', () => {
  const seller = read('src/routes/seller.js');
  const view = read('views/developer-portal.ejs');
  for (const route of [
    '/seller/developers','/seller/developers/clients','/seller/developers/clients/:id/rotate',
    '/seller/developers/clients/:id/revoke','/seller/developers/webhooks','/seller/developers/webhooks/:id/rotate',
    '/seller/developers/webhooks/:id/revoke','/seller/developers/webhooks/:id/test',
  ]) assert.ok(seller.includes(route), `${route} is not registered`);
  assert.match(view, /name="_csrf"/);
  assert.match(view, /will not be shown again/i);
  assert.match(view, /Optional expiry/);
  assert.match(read('src/services/stage11.js'), /safeEqual\(client\.secretHash,candidate\)/);
});

test('Stage 11 webhook transport pins a vetted public DNS result and never follows redirects', () => {
  const service = read('src/services/stage11.js');
  assert.match(service, /resolveWebhookTarget/);
  assert.match(service, /lookup\(_hostname,_options,callback\)\{callback\(null,target\.address,target\.family\);\}/);
  assert.match(service, /https\.request/);
  assert.match(service, /Webhook delivery timed out/);
  assert.doesNotMatch(service, /fetch\(endpoint\.url/);
});

test('Stage 11 seeded catalogue media is fully local and CSP no longer depends on Unsplash', () => {
  const seed = read('scripts/seed.js');
  const assets = [...seed.matchAll(/asset:\s*'([^']+\.svg)'/g)].map((m) => m[1]);
  assert.ok(assets.length >= 12, 'Expected all reference products to declare bundled assets');
  for (const asset of assets) assert.equal(fs.existsSync(path.join(root, 'public/assets/products', asset)), true, `${asset} missing`);
  assert.doesNotMatch(read('src/app.js'), /images\.unsplash\.com/);
  assert.match(read('src/services/product-media-url.js'), /source === 'seed_asset'/);
});
