import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Stage 11 fixes seeded storefront images to local bundled assets', () => {
  const helper = read('src/services/product-media-url.js');
  const storefront = read('src/services/storefront.js');
  const checkout = read('src/services/checkout.js');
  assert.match(helper, /source === 'seed_asset'/);
  assert.match(helper, /\/assets\/products\//);
  assert.match(storefront, /publicProductImageUrl/);
  assert.match(checkout, /publicProductImageUrl/);
  for (const file of ['wireless-headphones.svg','table-lamp.svg','city-backpack.svg','smart-watch.svg']) {
    assert.equal(fs.existsSync(path.join(root, 'public/assets/products', file)), true, `${file} must be packaged`);
  }
  const visualFiles = ['views/index.ejs','views/products.ejs','views/categories.ejs','views/sellers.ejs','public/script.js'];
  for (const file of visualFiles) assert.doesNotMatch(read(file), /images\.unsplash\.com/);
});

test('Stage 11 PWA never caches trusted commerce state', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /PRIVATE_PREFIXES/);
  for (const prefix of ['/api/','/account','/cart','/checkout','/track-order','/payments','/admin','/seller']) assert.match(sw, new RegExp(prefix.replace(/\//g,'\\/')));
  assert.match(sw, /cache:\s*'no-store'/);
  assert.match(read('public/manifest.webmanifest'), /"display"\s*:\s*"standalone"/);
  assert.match(read('src/app.js'), /manifest\.webmanifest/);
});

test('Stage 11 mobile tokens rotate and refresh reuse revokes the family', () => {
  const service = read('src/services/stage11.js');
  assert.match(service, /cma_/);
  assert.match(service, /cmr_/);
  assert.match(service, /MobileRefreshUse/);
  assert.match(service, /refresh_reuse/);
  assert.match(service, /MobileSession\.updateMany/);
  assert.match(service, /tokenVersion/);
});

test('Stage 11 mobile and seller APIs reuse server-authoritative commerce services', () => {
  const routes = read('src/routes/stage11.js');
  for (const token of ['getOrCreateCart','reviewCheckout','placeOrder','initiatePayment','adjustStock','createWarehouseTask','executeWarehouseTask']) assert.match(routes, new RegExp(token));
  assert.match(routes, /requestId/);
  assert.match(routes, /pageMeta/);
  assert.match(routes, /If-Match/);
  assert.match(read('src/services/inventory.js'), /INVENTORY_VERSION_CONFLICT/);
});

test('Stage 11 seller API keys, scopes, quotas, idempotency and auditing are enforced', () => {
  const service = read('src/services/stage11.js');
  const routes = read('src/routes/stage11.js');
  for (const token of ['SELLER_API_SCOPES','consumeApiQuota','executeExternalIdempotency','API_QUOTA_EXCEEDED','API_SCOPE_FORBIDDEN','auditExternalApi']) assert.match(service + routes, new RegExp(token));
  assert.match(service, /secretHash/);
  assert.doesNotMatch(read('src/models/ApiClient.js'), /secretPlain|apiKey\s*:/i);
});

test('Stage 11 webhook endpoints are SSRF protected, signed, retryable and unique', () => {
  const service = read('src/services/stage11.js');
  assert.match(service, /assertWebhookTarget/);
  assert.match(service, /privateAddress/);
  assert.match(service, /createHmac\('sha256'/);
  assert.match(service, /x-classic-mart-event-id/);
  assert.match(service, /x-classic-mart-timestamp/);
  assert.match(service, /x-classic-mart-signature/);
  assert.match(service, /deliverWebhookBatch/);
  assert.match(read('src/models/WebhookDelivery.js'), /endpointId:1,eventId:1/);
  assert.match(read('src/services/maintenance.js'), /deliverWebhookBatch/);
});

test('Stage 11 push delivery is provider-neutral and honest when unconfigured', () => {
  const service = read('src/services/stage11.js');
  const env = read('src/config/env.js');
  assert.match(env, /PUSH_GATEWAY_URL/);
  assert.match(service, /processPushOutbox/);
  assert.match(service, /providerConfigured:false/);
  assert.match(service, /decryptSensitive\(device\.tokenEncrypted\)/);
  assert.match(read('src/services/maintenance.js'), /processPushOutbox/);
});

test('Stage 11 publishes OpenAPI and configurable native deep-link associations', () => {
  const routes = read('src/routes/stage11.js');
  const openapi = JSON.parse(read('public/openapi-v1.json'));
  assert.equal(openapi.openapi, '3.1.0');
  assert.ok(openapi.components.securitySchemes.mobileBearer);
  assert.ok(openapi.components.securitySchemes.sellerApiKey);
  assert.match(routes, /assetlinks\.json/);
  assert.match(routes, /apple-app-site-association/);
  assert.match(routes, /ANDROID_APP_PACKAGE|androidPackage/);
  assert.match(routes, /APPLE_APP_ID|appleAppId/);
});

test('Stage 11 release gate requires the real Stage 1–11 MongoDB integration audit', () => {
  const audit = read('scripts/audit-integration.js');
  assert.match(audit, /Stage 1–12 MongoDB integration audit passed/);
  for (const token of ['issueMobileTokens','refreshMobileTokens','REFRESH_REUSE','createApiClient','INVENTORY_VERSION_CONFLICT','processPushOutbox']) assert.match(audit, new RegExp(token));
});


test('Stage 11 webhook test API returns the numeric queued endpoint count', () => {
  const routes = read('src/routes/stage11.js');
  assert.match(routes, /metadata: \{ queued \}/);
  assert.match(routes, /body: \{ apiVersion: 'v1', queued \}/);
  assert.doesNotMatch(routes, /queued\.length/);
});


test('Stage 11 mobile cart compares selected-variant authority instead of aggregate product stock', () => {
  const audit = read('scripts/audit-integration.js');
  assert.match(audit, /liveVariantForMobile = liveProductForMobile\?\.variants\?\.find/);
  assert.match(audit, /mobileCartItem\.available, liveVariantForMobile\.stock/);
  assert.match(audit, /mobileCartItem\.sku, liveVariantForMobile\.sku/);
  assert.match(audit, /product-level published stock must remain the sum of sellable variant stock/);
  assert.doesNotMatch(audit, /mobileCartItem\.available, liveProductForMobile\.stock/);
});
