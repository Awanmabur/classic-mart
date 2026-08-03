import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('error UI is safe before user-loading middleware', () => {
  assert.match(read('views/error.ejs'), /typeof user !== ['"]undefined['"]/);
});

test('seller workspace has a safe membership fallback for direct rendering', () => {
  const view = read('views/catalog-workspace.ejs');
  assert.match(view, /typeof storeMembership !== ['"]undefined['"]/);
  assert.match(view, /membership\.role/);
});

test('Mongo query operators are protected at the request boundary without rewriting server filters', () => {
  const db = read('src/config/db.js');
  const request = read('src/middleware/request.js');
  assert.match(db, /sanitizeFilter', false/);
  assert.match(request, /key\.startsWith\('\$'\)/);
  assert.match(request, /key\.includes\('\.'\)/);
  assert.match(request, /UNSAFE_INPUT_KEY/);
  assert.match(request, /UNSAFE_INPUT_VALUE/);
});

test('reconciliation model avoids reserved errors pathname', () => {
  const model = read('src/models/ReconciliationRun.js');
  assert.doesNotMatch(model, /\berrors\s*:/);
  assert.match(model, /errorMessages\s*:/);
});

test('promoter coupon uses only the partial unique index declaration', () => {
  const model = read('src/models/PromoterLink.js');
  assert.doesNotMatch(model, /couponCode:\{[^}]*index:true/);
  assert.match(model, /schema\.index\(\{couponCode:1\},\{unique:true,partialFilterExpression:/);
});

test('public storefront state summary does not require authentication', () => {
  const routes = read('src/routes/storefront.js');
  const start = routes.indexOf("'/api/v1/storefront/state'");
  const end = routes.indexOf('router.post(', start);
  const chunk = routes.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(chunk, /requireAuth/);
  assert.match(chunk, /authenticated:\s*Boolean\(request\.user\)/);
  assert.match(chunk, /if \(request\.user\) \{[\s\S]*recommendationsFor/);
  assert.match(chunk, /recommendations:\s*\[\]/);
});


test('integration audit uses isolated identities and resets only the guarded audit database', () => {
  const audit = read('scripts/audit-integration.js');
  assert.match(audit, /audit-test\$\/i/);
  assert.match(audit, /dropDatabase\(\)/);
  assert.match(audit, /\+256799/);
  assert.doesNotMatch(audit, /\+256700\$\{String\(userSequence\)/);
});

test('transaction topology is verified and local bootstrap is isolated from verification', () => {
  const pkg = JSON.parse(read('package.json'));
  const db = read('src/config/db.js');
  const audit = read('scripts/audit-integration.js');
  const topology = read('src/config/mongo-topology.js');
  const ready = read('scripts/verify-mongo.js');

  assert.match(pkg.scripts['db:setup'], /db:local/);
  assert.match(pkg.scripts['db:setup'], /db:verify/);
  assert.match(pkg.scripts['release:check'], /db:verify/);
  assert.match(db, /assertMongoTransactions/);
  assert.match(topology, /MONGO_TRANSACTIONS_REQUIRED/);
  assert.match(audit, /verify-mongo\.js/);
  assert.match(ready, /assertMongoTransactions/);
  assert.doesNotMatch(ready, /replSetInitiate|docker compose/);
});


test('integration audit loads .env before resolving MongoDB configuration', () => {
  const audit = read('scripts/audit-integration.js');
  const dotenvIndex = audit.indexOf("import 'dotenv/config';");
  const uriIndex = audit.indexOf('projectMongoUri()');
  assert.ok(dotenvIndex >= 0, 'audit must load dotenv/config');
  assert.ok(uriIndex > dotenvIndex, 'audit must load .env before resolving MONGO_URI');
  assert.match(audit, /CLASSIC_MART_TEST_MONGO_OVERRIDE:\s*'1'/);
});

test('integration audit resolves parcel seller ownership before warehouse task creation', () => {
  const audit = read('scripts/audit-integration.js');
  assert.doesNotMatch(audit, /parcel\.storeId/);
  assert.match(audit, /models\.Store\.findOne\(\{ publicId: parcel\.storePublicId \}\)/);
  assert.match(audit, /models\.Warehouse\.findOne\(\{ storeId: parcelStore\._id, active: true \}\)/);
  assert.match(audit, /storeId: parcelStore\._id/);
});


test('integration audit loads shipment proof hashes with encrypted proof codes before driver transitions', () => {
  const audit = read('scripts/audit-integration.js');
  assert.match(audit, /select\('\+pickupCodeHash \+deliveryCodeHash \+pickupCodeEncrypted \+deliveryCodeEncrypted'\)/);
  assert.match(audit, /decryptSensitive\(shipment\.pickupCodeEncrypted\)/);
  assert.match(audit, /decryptSensitive\(shipment\.deliveryCodeEncrypted\)/);
  assert.match(audit, /verifyProofCode\(pickupCode, shipment\.pickupCodeHash\)/);
  assert.match(audit, /verifyProofCode\(deliveryCode, shipment\.deliveryCodeHash\)/);
  assert.match(audit, /nextStatus: 'picked_up'[\s\S]{0,140}proofCode: pickupCode/);
  assert.match(audit, /nextStatus: 'delivered'[\s\S]{0,140}proofCode: deliveryCode/);
});
