import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import ejs from 'ejs';
import { chromium } from '@playwright/test';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.UPLOAD_DIR = `/tmp/classicmart-support-warehouse-intake-media-${suffix}`;
process.env.MEDIA_STORAGE_DRIVER = 'filesystem';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'the real page supplies its session form token');
  return token[1];
};

test('Warehouse receipt controls remain usable in the approved desktop and mobile layout', async t => {
  const warehouse = { publicId: 'whs_receiving_layout', name: 'Receiving location with a long warehouse name', country: 'UG' };
  const flow = { mode: 'returns', warehouses: [warehouse], summary: {}, permissions: {}, filters: {}, tasks: [{ publicId: 'wht_actual_inspection_layout',
    type: 'return_inspection', title: 'Received item requiring its physical stock condition inspection', warehouseName: warehouse.name, quantity: 2,
    status: 'in_progress', version: 1, mine: true, actions: { execute: true } }], returnIntakes: {
    page: { total: 1, hasMore: false }, items: [{ publicId: 'ret_long_return_reference_1234567890', orderPublicId: 'ord_long_order_reference_1234567890', country: 'UG', version: 3,
      lines: [{ orderLineId: 'oli_long_order_line_reference_1234567890', title: 'Returned item with a long but legitimate product title', quantity: 2, warehouses: [warehouse],
        receipts: [{ publicId: 'evd_private_ready_receipt_1234567890', createdAt: new Date() }] }] }] } };
  const partial = await ejs.renderFile(fileURLToPath(new URL('../views/partials/warehouse-live.ejs', import.meta.url)), {
    liveWarehouse: { flow }, user: { name: 'Receiving Operator' }, csrfToken: 'standalone-layout-token', formatDate: value => new Date(value).toISOString().slice(0, 10),
  });
  const styleFiles = ['styles.css', 'role-workspaces.css', 'design-system.css', 'warehouse-live.css'];
  const styles = await Promise.all(styleFiles.map(file => fs.readFile(new URL('../public/approved-dashboard/' + file, import.meta.url), 'utf8')));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [1366, 390]) await t.test(`${width}px receipt and inspection controls fit the viewport`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + styles.join('\n') + '</style></head><body><main>' + partial + '</main></body></html>');
      await page.locator('details').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
      await page.getByRole('button', { name: 'Upload Receipt', exact: true }).scrollIntoViewIfNeeded();
      const controls = await page.locator('input:not([type="hidden"]):not([type="checkbox"]),select,button').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      }));
      assert.ok(controls.length >= 12);
      assert.ok(controls.every(rect => rect.left >= -1 && rect.right <= width + 1 && rect.width > 0 && rect.height >= 35), JSON.stringify(controls));
      assert.equal(await page.getByRole('combobox', { name: 'Inspected condition' }).count(), 1);
      if (width === 390) {
        const widths = await page.locator('.warehouse-live-detail-row .warehouse-live-task-form').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
        assert.ok(widths.every(value => value >= 300), 'mobile receipt and inspection forms use the available detail-row width: ' + widths.join(', '));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow');
      await page.close();
    });
  } finally { await browser.close(); }
});

test('Warehouse approved return pages upload private receipts, receive exact goods and finish authoritative inspection', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: `classicmart_support_warehouse_intake_test_${suffix}` });
  const transports = [];
  try {
    const { createApp } = await import('../src/app.js');
    const models = await import('../src/models/index.js');
    const { User, PlatformGrant, CountrySetting, Category, Store, Product, ProductVariant, Warehouse, StockItem,
      Order, Shipment, SellerOrder, ReturnRequest, EvidenceDocument, WarehouseTask, InventoryMovement, AuditLog } = models;
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { createReturnRequest } = await import('../src/services/trust.js');
    const { decideSupportReturn } = await import('../src/services/support-case-pages.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' }]);
    let sequence = 0;
    const id = kind => `${kind}_wi_${suffix}_${++sequence}`;
    const password = `Intake-${suffix}-A1!`, passwordHash = await hashPassword(password), secret = 'JBSWY3DPEHPK3PXP';
    async function actor(role, { managed = false, login = false } = {}) {
      const number = ++sequence, email = `intake-${suffix}-${number}@example.com`, phone = '+25670' + String(number).padStart(7, '0');
      const user = await User.create({ publicId: id('usr'), name: `Receiving Operator ${number}`, email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash,
        role: managed ? 'customer' : role, country: 'UG', currency: 'UGX', operationalCountries: ['UG'], emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        ...(managed ? { platformAccessManagedAt: new Date() } : {}), security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: ['UG'], status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Actual Warehouse receipt page verification',
        approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) {
        const transport = new http.Agent({ localAddress: `127.0.0.${number % 100 + 100}`, keepAlive: false });
        transports.push(transport);
        client = request.agent(createApp(null)).use(req => req.agent(transport));
        const form = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302).expect('location', '/mfa');
        const challenge = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
      }
      return { user, grant, client };
    }
    const buyer = await actor('customer', { login: true }), seller = await actor('seller'), support = await actor('support'), operator = await actor('warehouse', { managed: true, login: true });
    const req = member => ({ id: id('req'), user: member.user, session: { tokenVersion: member.user.security.tokenVersion }, query: {}, country: { code: 'UG' }, ip: '127.0.0.1', get: () => 'WarehouseIntakeTest/1.0' });
    const category = await Category.create({ publicId: id('cat'), name: 'Receipt goods', slug: id('category'), countries: ['UG'] });
    const store = await Store.create({ publicId: id('sto'), ownerUserId: seller.user._id, name: 'Receipt store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
    const product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: seller.user._id, categoryId: category._id, title: 'Receiving receipt fixture item',
      slug: id('product'), description: 'An actual delivered goods fixture for private receipt verification', countries: ['UG'], status: 'published' });
    const variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: id('sku').toUpperCase(), title: 'Standard', priceMinor: 10000, costMinor: 5000, currency: 'UGX' });
    const warehouse = await Warehouse.create({ publicId: id('whs'), storeId: store._id, ownerUserId: seller.user._id, name: 'Receiving warehouse', country: 'UG', city: 'Kampala', address: 'Fixture receiving location' });
    const stock = await StockItem.create({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id, variantId: variant._id, onHand: 12, reserved: 0, damaged: 0, quarantined: 0 });
    await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { warehouseScopes: [warehouse.publicId] } });
    async function fixture() {
      const lineId = id('oli');
      const order = await Order.create({ publicId: id('ord'), idempotencyKey: id('checkout'), checkoutId: id('checkout'), cartPublicId: id('crt'), sessionKey: id('session'), userId: buyer.user._id,
        country: 'UG', status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', deliveryMethod: 'standard', paymentMethod: 'card',
        contact: { fullName: buyer.user.name, email: buyer.user.email, phone: buyer.user.phone, address: 'PRIVATE_BUYER_ADDRESS', city: 'Kampala', country: 'UG' },
        totals: { subtotalMinor: 20000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 20000, currency: 'UGX' }, reservationExpiresAt: new Date(Date.now() + 86400_000),
        items: [{ linePublicId: lineId, productId: product._id, variantId: variant._id, storeId: store._id, reservationPublicId: id('rsv'), productPublicId: product.publicId,
          variantPublicId: variant.publicId, storePublicId: store.publicId, title: product.title, variantTitle: variant.title, sku: variant.sku, quantity: 2, deliveredQuantity: 2,
          unitPriceMinor: 10000, lineTotalMinor: 20000, currency: 'UGX' }] });
      await Shipment.create({ publicId: id('shp'), orderId: order._id, orderPublicId: order.publicId, country: 'UG', kind: 'outbound', mode: 'standard', status: 'delivered',
        deliveredAt: new Date(), proof: { type: 'otp', reference: 'verified', recordedAt: new Date() } });
      await SellerOrder.create({ publicId: id('sord'), orderId: order._id, orderPublicId: order.publicId, storeId: store._id, storePublicId: store.publicId, country: 'UG', status: 'fulfilled',
        subtotalMinor: 20000, platformFeeMinor: 1000, currency: 'UGX', items: [{ orderLineId: lineId, productPublicId: product.publicId, variantPublicId: variant.publicId, title: product.title,
          variantTitle: variant.title, sku: variant.sku, quantity: 2, unitPriceMinor: 10000, lineTotalMinor: 20000, currency: 'UGX', grossMinor: 20000, customerPaidMinor: 20000,
          platformFeeMinor: 1000, sellerReceivableMinor: 19000 }] });
      const returned = (await createReturnRequest(req(buyer), { orderId: order.publicId, items: [{ orderLineId: lineId, quantity: 1 }], reason: 'damaged',
        details: 'Actual delivered item needs a receiving receipt and inspection.', resolution: 'refund', returnMethod: 'dropoff' })).returnRequest;
      await decideSupportReturn(req(support), returned.publicId, { version: returned.__v, decision: 'approve', note: 'Approved exact delivered goods for receiving and inspection.' });
      return { returned, order, lineId };
    }
    const current = await fixture(), image = await sharp({ create: { width: 360, height: 360, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const version = async returned => (await ReturnRequest.findById(returned._id)).__v;
    const payload = async item => ({ version: await version(item.returned), orderLineId: item.lineId, warehousePublicId: warehouse.publicId });
    let evidence;
    await t.test('real HTML and JSON show only current accessible intake records and safe source details', async () => {
      const page = await operator.client.get('/warehouse/returns').expect(200);
      assert.match(page.headers['cache-control'], /no-store/); assert.match(page.headers['x-robots-tag'], /noindex/);
      assert.ok(page.text.includes(current.returned.publicId)); assert.ok(page.text.includes('Record Return Receipt'));
      assert.ok(!page.text.includes('PRIVATE_BUYER_ADDRESS')); assert.ok(!page.text.includes(buyer.user.email));
      const json = await operator.client.get('/warehouse/returns').set('Accept', 'application/json').expect(200);
      assert.equal(json.body.returnIntakes.page.total, 1); assert.equal(json.body.returnIntakes.items[0].lines[0].warehouses[0].publicId, warehouse.publicId);
      await operator.client.get('/warehouse/returns?intakesAfter=broken-cursor').expect(422);
    });
    await t.test('multipart CSRF and image validation happen before receipt persistence', async () => {
      const input = await payload(current);
      await operator.client.post('/warehouse/returns/' + current.returned.publicId + '/intake-evidence').field(input).attach('document', image, 'receipt.png').expect(403);
      assert.equal(await EvidenceDocument.countDocuments(), 0);
      const page = await operator.client.get('/warehouse/returns').expect(200);
      const invalid = await operator.client.post('/warehouse/returns/' + current.returned.publicId + '/intake-evidence').field('_csrf', csrf(page.text)).field(input)
        .attach('document', Buffer.from('not a valid receipt image'), { filename: 'receipt.png', contentType: 'image/png' }).expect(422);
      assert.ok(invalid.text.includes('not a valid image')); assert.ok(invalid.text.includes(current.lineId));
      assert.equal(await EvidenceDocument.countDocuments(), 0);
      await operator.client.post('/warehouse/returns/' + current.returned.publicId + '/intake-evidence').field('_csrf', csrf(page.text)).field(input).attach('document', image, 'receipt.png')
        .expect(303).expect('location', '/warehouse/returns');
      evidence = await EvidenceDocument.findOne({ contextPublicId: current.returned.publicId });
      assert.equal(evidence.contextLinePublicId, current.lineId); assert.equal(evidence.mimeType, 'image/webp'); assert.equal(evidence.status, 'ready');
      const warehousePreview = await operator.client.get('/evidence/' + evidence.publicId).expect(200);
      assert.match(warehousePreview.headers['content-type'], /image\/webp/); assert.match(warehousePreview.headers['cache-control'], /private.*no-store/);
      const buyerPreview = await buyer.client.get('/evidence/' + evidence.publicId).expect(200);
      assert.match(buyerPreview.headers['content-type'], /image\/webp/); assert.match(buyerPreview.headers['cache-control'], /private.*no-store/);
      assert.equal((await StockItem.findById(stock._id)).onHand, 12);
      const refreshed = await operator.client.get('/warehouse/returns').expect(200);
      assert.ok(refreshed.text.includes('Confirm Goods Received')); assert.ok(refreshed.text.includes(evidence.publicId));
    });
    await t.test('stale receipt confirmation rerenders the current case without changing goods', async () => {
      const page = await operator.client.get('/warehouse/returns').expect(200);
      const failed = await operator.client.post('/warehouse/returns/' + current.returned.publicId + '/intake').type('form').send({ ...await payload(current),
        version: 0, _csrf: csrf(page.text), evidencePublicId: evidence.publicId }).expect(409);
      assert.ok(failed.text.includes('Reload')); assert.ok(failed.text.includes(evidence.publicId));
      assert.equal((await ReturnRequest.findById(current.returned._id)).status, 'awaiting_return'); assert.equal(await WarehouseTask.countDocuments({ returnRequestId: current.returned._id }), 0);
      assert.equal((await StockItem.findById(stock._id)).onHand, 12);
    });
    await t.test('HTML confirmation creates the exact inspection task, then task forms record disposition', async () => {
      const page = await operator.client.get('/warehouse/returns').expect(200);
      await operator.client.post('/warehouse/returns/' + current.returned.publicId + '/intake?warehousePublicId=' + warehouse.publicId).type('form').send({ ...await payload(current),
        _csrf: csrf(page.text), evidencePublicId: evidence.publicId }).expect(303).expect('location', '/warehouse/returns?warehousePublicId=' + warehouse.publicId);
      assert.equal((await ReturnRequest.findById(current.returned._id)).status, 'received'); assert.equal((await StockItem.findById(stock._id)).onHand, 12);
      const task = await WarehouseTask.findOne({ returnRequestId: current.returned._id }); assert.ok(task); assert.equal(task.returnOrderLineId, current.lineId); assert.equal(task.quantity, 1);
      const queue = await operator.client.get('/warehouse/returns').expect(200); assert.ok(queue.text.includes(task.publicId));
      await operator.client.post('/warehouse/tasks/' + task.publicId + '/claim').type('form').send({ version: task.__v, returnPage: 'returns', _csrf: csrf(queue.text) }).expect(303);
      const claimed = await WarehouseTask.findById(task._id);
      const inspection = await operator.client.get('/warehouse/returns').expect(200); assert.ok(inspection.text.includes('Inspected condition'));
      await operator.client.post('/warehouse/tasks/' + task.publicId + '/execute').type('form').send({ version: claimed.__v, quantity: 1, disposition: 'damaged', returnPage: 'returns', _csrf: csrf(inspection.text) }).expect(303);
      assert.equal((await WarehouseTask.findById(task._id)).status, 'completed');
      const recorded = await StockItem.findById(stock._id); assert.equal(recorded.onHand, 13); assert.equal(recorded.damaged, 1);
      assert.equal(await InventoryMovement.countDocuments({ reference: current.returned.publicId, type: 'return' }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'warehouse.return_intake_recorded', targetPublicId: current.returned.publicId }), 1);
    });
    await t.test('receipt choices are batched and bounded per exact case line without accepting foreign or unattached images', async () => {
      const pending = [await fixture(), await fixture()];
      const expectedByReturn = new Map();
      for (const item of pending) {
        const fields = { ownerUserId: operator.user._id, country: 'UG', contextType: 'return', contextPublicId: item.returned.publicId,
          contextLinePublicId: item.lineId, documentType: 'return_receipt', status: 'ready', storageKey: 'private/receipt-fixture.webp', mimeType: 'image/webp', size: 500 };
        const ready = await EvidenceDocument.create(Array.from({ length: 45 }, (_, index) => ({ ...fields, publicId: id('evd'), createdAt: new Date(Date.now() - 60_000 + index) })));
        const unrelated = await EvidenceDocument.create([
          { ...fields, publicId: id('evd'), ownerUserId: buyer.user._id },
          { ...fields, publicId: id('evd'), country: 'KE' },
          { ...fields, publicId: id('evd'), contextLinePublicId: id('oli') },
          { ...fields, publicId: id('evd'), contextPublicId: current.returned.publicId },
        ]);
        // A ready image with a matching public context is insufficient unless the
        // return itself still attaches the exact private evidence record.
        await EvidenceDocument.create({ ...fields, publicId: id('evd') });
        await ReturnRequest.updateOne({ _id: item.returned._id }, { $push: { evidenceDocumentIds: { $each: [...ready, ...unrelated].map(row => row._id) } } });
        expectedByReturn.set(item.returned.publicId, ready.slice(-20).reverse().map(row => row.publicId));
      }
      const { loadWarehouseReturnIntakes } = await import('../src/services/support-case-pages.js');
      const originalAggregate = EvidenceDocument.aggregate, originalFind = EvidenceDocument.find;
      let aggregates = 0, separateFinds = 0;
      t.mock.method(EvidenceDocument, 'aggregate', function (...args) { aggregates++; return originalAggregate.apply(this, args); });
      t.mock.method(EvidenceDocument, 'find', function (...args) { separateFinds++; return originalFind.apply(this, args); });
      let queue;
      try { queue = await loadWarehouseReturnIntakes(req(operator)); } finally { t.mock.restoreAll(); }
      assert.equal(aggregates, 1, 'multiple cases use one bounded receipt aggregation');
      assert.equal(separateFinds, 0, 'receipt lookup does not add a database read per return line');
      for (const item of pending) {
        const returned = queue.items.find(row => row.publicId === item.returned.publicId);
        assert.ok(returned);
        assert.deepEqual(returned.lines[0].receipts.map(row => row.publicId), expectedByReturn.get(item.returned.publicId));
        assert.equal(returned.lines[0].receipts.length, 20);
      }
      assert.ok(!JSON.stringify(queue).includes('storageKey')); assert.ok(!JSON.stringify(queue).includes(String(operator.user._id)));
    });
    await t.test('current Warehouse MFA, country, location and grants protect staff receipt reads, pages and writes', async () => {
      const pending = await fixture(), page = await operator.client.get('/warehouse/returns').expect(200), count = await EvidenceDocument.countDocuments();
      await operator.client.get('/evidence/' + evidence.publicId).expect(200);
      await User.updateOne({ _id: operator.user._id }, { $set: { 'security.mfaEnabled': false } });
      await operator.client.get('/evidence/' + evidence.publicId).set('Accept', 'application/json').expect(403);
      await User.updateOne({ _id: operator.user._id }, { $set: { 'security.mfaEnabled': true } });
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { operationalCountries: ['KE'] } });
      await operator.client.get('/evidence/' + evidence.publicId).set('Accept', 'application/json').expect(404);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { operationalCountries: ['UG'], warehouseScopes: [id('whs')] } });
      await operator.client.get('/evidence/' + evidence.publicId).set('Accept', 'application/json').expect(403);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { warehouseScopes: [warehouse.publicId] } });
      await operator.client.get('/evidence/' + evidence.publicId).expect(200);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { status: 'revoked' } });
      await operator.client.get('/evidence/' + evidence.publicId).set('Accept', 'application/json').expect(403);
      await buyer.client.get('/evidence/' + evidence.publicId).expect(200);
      await operator.client.get('/warehouse/returns').set('Accept', 'application/json').expect(403);
      await operator.client.post('/warehouse/returns/' + pending.returned.publicId + '/intake-evidence').set('Accept', 'application/json')
        .field('_csrf', csrf(page.text)).field(await payload(pending)).attach('document', image, 'receipt.png').expect(403);
      assert.equal(await EvidenceDocument.countDocuments(), count); assert.equal((await ReturnRequest.findById(pending.returned._id)).status, 'awaiting_return');
    });
  } finally {
    t.mock.restoreAll();
    for (const transport of transports) transport.destroy();
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true }); }
  }
});
