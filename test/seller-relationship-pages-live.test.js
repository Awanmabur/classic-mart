import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.REDIS_URL = '';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.SESSION_SECRET ||= crypto.randomBytes(48).toString('hex');
process.env.TOKEN_PEPPER ||= crypto.randomBytes(48).toString('hex');
process.env.DATA_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.SECURITY_INTEGRITY_KEY ||= crypto.randomBytes(48).toString('hex');
process.env.UPLOAD_DIR = `/tmp/classicmart-relationship-test-${suffix}`;
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('seller relationship pages use complete scoped counts and persist authorized customer support workflows', { skip: !uri, timeout: 240_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const database = `classicmart_relationship_test_${suffix}`;
  await mongoose.connect(uri, { dbName: database });
  const { createApp } = await import('../src/app.js');
  const { Device, User, Store, StoreMember, Category, Product, ProductVariant, Order, SellerOrder, SellerReturnCase, ReturnRequest,
    Review, SellerContactRequest, ProductQuestion, EvidenceDocument, AuditLog, OutboxEvent, Notification, CountrySetting } = await import('../src/models/index.js');
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { getOrCreateStore } = await import('../src/services/store.js');
  const { sellerRelationshipPage, respondSellerReturn, disputeSellerReview, replySellerConversation, contactSellerCustomer } = await import('../src/services/seller-relationship-pages.js');
  const { processNotificationOutbox } = await import('../src/services/outbox.js');
  const app = createApp(null), password = `Relationship-${suffix}A1!`, transports = [];
  let actorSequence = 0, orderSequence = 0, server, browser;

  async function actor(role = 'seller', mfa = true) {
    const index = actorSequence++, email = `relationships-${suffix}-${index}@example.com`, phone = '+2567' + crypto.randomInt(10000000, 99999999);
    let user = await User.create({ publicId: `usr_rel_${suffix}_${index}`, name: `Relationship User ${index}`, email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash: await hashPassword(password), role, country: 'UG', currency: 'UGX',
      emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const transport = new http.Agent({ localAddress: `127.0.0.${index + 2}`, keepAlive: false }); transports.push(transport);
    const agent = request.agent(app).use(req => req.agent(transport));
    const login = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
    if (mfa) {
      const security = await agent.get('/account/security').expect(200);
      await agent.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(user._id);
      await agent.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf((await agent.get('/account/security')).text) }).expect(302);
      user = await User.findById(user._id);
    }
    const currentUser = await User.findById(user._id), sessionID = crypto.randomUUID();
    const device = await Device.create({ publicId: `dev_rel_${suffix}_${index}`, userId: currentUser._id,
      sessionHash: hashToken(sessionID), label: 'Current fixture service session', userAgent: 'Authenticated fixture', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    const context = { sessionID, device, session: { userId: String(currentUser._id), tokenVersion: currentUser.security.tokenVersion,
      mfaVerifiedAt: Date.now() }, country: { code: currentUser.country, currency: currentUser.currency }, ip: '127.0.0.1', query: {} };
    return { user: currentUser, agent, context };
  }
  async function seller() {
    const person = await actor();
    const access = await getOrCreateStore(person.user);
    person.store = await Store.findOneAndUpdate({ _id: access.store._id }, { $set: { status: 'verified', verifiedAt: new Date() } }, { returnDocument: 'after' });
    return person;
  }
  const serviceRequest = (person, id = '', body = {}, query = {}) => ({ ...person.context, id: `rel-${suffix}-${crypto.randomBytes(4).toString('hex')}`, user: person.user, store: person.store,
    params: { publicId: id }, body, query, get: () => '', country: { code: 'UG' } });
  async function catalogue(person, index, category) {
    const product = await Product.create({ publicId: `prd_rel_${suffix}_${index}`, storeId: person.store._id, ownerUserId: person.user._id,
      categoryId: category._id, title: index === 0 ? 'Relationship product' : 'Foreign private product', slug: `rel-${suffix}-${index}`,
      description: 'A real published product for the store support workflow.', countries: ['UG'], status: 'published' });
    const variant = await ProductVariant.create({ publicId: `var_rel_${suffix}_${index}`, productId: product._id, storeId: person.store._id,
      sku: `REL-${suffix}-${index}`, title: 'Default', currency: 'UGX', priceMinor: 10000, active: true });
    return { product, variant, store: person.store };
  }
  async function purchase(person, buyer, product, { guest = '', extra = null } = {}) {
    const index = orderSequence++, orderId = `ord_rel_${suffix}_${index}`;
    const contact = { fullName: guest || buyer.user.name, email: guest ? `guest-${index}-${suffix}@example.com` : buyer.user.email,
      phone: buyer.user.phone, address: '12 Test Road', city: 'Kampala', country: 'UG' };
    const lines = [product, ...(extra ? [extra] : [])].map((item, i) => ({ linePublicId: `oline_rel_${suffix}_${index}_${i}`,
      productId: item.product._id, variantId: item.variant._id, storeId: item.store._id, reservationPublicId: `res_rel_${suffix}_${index}_${i}`,
      productPublicId: item.product.publicId, variantPublicId: item.variant.publicId, storePublicId: item.store.publicId,
      title: item.product.title, variantTitle: 'Default', sku: item.variant.sku, quantity: 1, deliveredQuantity: 1,
      unitPriceMinor: 10000, lineTotalMinor: 10000, currency: 'UGX' }));
    const order = await Order.create({ publicId: orderId, idempotencyKey: `rel-${suffix}-${index}`, checkoutId: `chk_rel_${suffix}_${index}`,
      cartPublicId: `cart_rel_${suffix}_${index}`, sessionKey: `session-rel-${suffix}-${index}`, userId: guest ? undefined : buyer.user._id,
      country: 'UG', status: 'paid', paymentMethod: 'wallet', paymentState: 'paid', fulfillmentState: 'delivered', deliveryMethod: 'standard', contact,
      totals: { subtotalMinor: 10000 * lines.length, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000 * lines.length, currency: 'UGX' },
      items: lines, reservationExpiresAt: new Date(Date.now() + 3600000) });
    const row = await SellerOrder.create({ publicId: `sord_rel_${suffix}_${index}`, orderId: order._id, orderPublicId: order.publicId,
      storeId: person.store._id, storePublicId: person.store.publicId, country: 'UG', currency: 'UGX', status: 'fulfilled', subtotalMinor: 10000,
      items: [{ orderLineId: lines[0].linePublicId, productPublicId: product.product.publicId, variantPublicId: product.variant.publicId,
        title: product.product.title, variantTitle: 'Default', sku: product.variant.sku, quantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000, currency: 'UGX', unitCostMinor: 4321 }] });
    return { order, row, lines };
  }
  async function returnCase(person, bought, product, index) {
    const line = bought.lines[0];
    const ret = await ReturnRequest.create({ publicId: `ret_rel_${suffix}_${index}`, orderId: bought.order._id, orderPublicId: bought.order.publicId,
      userId: bought.order.userId, country: 'UG', reason: 'damaged', details: 'The delivered product arrived damaged.', resolution: 'refund',
      eligibleUntil: new Date(Date.now() + 86400000), policyVersion: 'test', items: [{ orderLineId: line.linePublicId, productId: product.product._id,
        variantId: product.variant._id, storeId: person.store._id, storePublicId: person.store.publicId, productPublicId: product.product.publicId,
        variantPublicId: product.variant.publicId, title: product.product.title, quantity: 1, unitPriceMinor: 10000, requestedRefundMinor: 10000 }] });
    const row = await SellerReturnCase.create({ publicId: `src_rel_${suffix}_${index}`, returnRequestId: ret._id, returnPublicId: ret.publicId,
      orderPublicId: bought.order.publicId, storeId: person.store._id, storePublicId: person.store.publicId, country: 'UG',
      items: [{ orderLineId: line.linePublicId, productPublicId: product.product.publicId, variantPublicId: product.variant.publicId,
        title: product.product.title, quantity: 1, requestedRefundMinor: 10000, sellerReceivableReversalMinor: 9500, platformFeeReversalMinor: 500 }], slaDueAt: new Date(Date.now() - 1000) });
    return { ret, row };
  }
  try {
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    for (const kind of ['returns', 'customers', 'reviews', 'messages']) await request(app).get('/seller/' + kind).expect(302).expect('location', '/login?next=' + encodeURIComponent('/seller/' + kind));
    const owner = await seller(), other = await seller(), buyer = await actor('customer', false), foreignBuyer = await actor('customer', false);
    const category = await Category.create({ publicId: `cat_rel_${suffix}`, name: 'Relationships', slug: `rel-${suffix}`, active: true });
    const ownProduct = await catalogue(owner, 0, category), foreignProduct = await catalogue(other, 1, category);
    const main = await purchase(owner, buyer, ownProduct, { extra: foreignProduct }), foreign = await purchase(other, foreignBuyer, foreignProduct);
    // These are real model records rather than a capped dashboard fixture. The
    // summary must count all 205 same-buyer orders plus the paginated guests.
    for (let i = 1; i < 205; i++) await purchase(owner, buyer, ownProduct);
    for (let i = 0; i < 30; i++) await purchase(owner, buyer, ownProduct, { guest: `Store Guest ${i}` });
    const ownReturn = await returnCase(owner, main, ownProduct, 0), foreignReturn = await returnCase(other, foreign, foreignProduct, 1);
    await SellerReturnCase.updateOne({ _id: ownReturn.row._id }, { $set: { slaDueAt: new Date('2026-01-01T22:30:00Z') } });
    const storeCalendar = await sellerRelationshipPage(serviceRequest(owner), 'seller-returns');
    assert.equal(storeCalendar.timeZone, 'Africa/Kampala');
    assert.equal(storeCalendar.rows.find(row => row.id === ownReturn.row.publicId).cells[3], '2 Jan 2026');
    const review = await Review.create({ publicId: `rev_rel_${suffix}_0`, userId: buyer.user._id, orderId: main.order._id,
      orderPublicId: main.order.publicId, productId: ownProduct.product._id, productPublicId: ownProduct.product.publicId, country: 'UG',
      rating: 4, title: 'Useful product', body: 'This product is useful and works as described.', status: 'published', publishedAt: new Date() });
    const foreignReview = await Review.create({ publicId: `rev_rel_${suffix}_1`, userId: foreignBuyer.user._id, orderId: foreign.order._id,
      orderPublicId: foreign.order.publicId, productId: foreignProduct.product._id, productPublicId: foreignProduct.product.publicId,
      country: 'UG', rating: 1, body: 'Foreign private customer review text.', status: 'published' });
    const thread = await SellerContactRequest.create({ publicId: `scr_rel_${suffix}_0`, customerUserId: buyer.user._id, storeId: owner.store._id,
      country: 'UG', subject: 'Order help', message: 'Can you help with my delivered item?' });
    const foreignThread = await SellerContactRequest.create({ publicId: `scr_rel_${suffix}_1`, customerUserId: foreignBuyer.user._id, storeId: other.store._id,
      country: 'UG', subject: 'Foreign private conversation', message: 'Foreign private customer message.' });
    const question = await ProductQuestion.create({ publicId: `pq_rel_${suffix}_0`, productId: ownProduct.product._id, productPublicId: ownProduct.product.publicId,
      storeId: owner.store._id, customerUserId: buyer.user._id, country: 'UG', question: 'How do I clean this product?' });
    for (const kind of ['returns', 'customers', 'reviews', 'messages']) {
      const response = await owner.agent.get('/seller/' + kind).expect(200);
      assert.match(response.headers['cache-control'], /no-store/);
      assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.doesNotMatch(response.text, /Foreign private|sellerReceivableReversalMinor|platformFeeReversalMinor|unitCostMinor/);
    }
    const customerData = (await owner.agent.get('/seller/customers').set('accept', 'application/json').expect(200)).body;
    assert.equal(customerData.metrics[0].value, 31); assert.equal(customerData.metrics[1].value, 1);
    assert.equal(customerData.metrics[2].value, 235); assert.equal(customerData.page.total, 31);
    assert.equal(customerData.records.length, 25); assert.equal(customerData.page.hasMore, true);
    const page2 = await sellerRelationshipPage(serviceRequest(owner, '', {}, { after: customerData.page.next }), 'seller-customers');
    assert.equal(page2.records.length, 6);
    assert.ok(page2.records.every(row => !customerData.records.some(previous => previous.publicId === row.publicId)));
    const buyerDetail = (await owner.agent.get('/seller/customers?customer=' + main.row.publicId).set('accept', 'application/json').expect(200)).body;
    assert.equal(buyerDetail.selected.orderCount, 205); assert.equal(buyerDetail.selected.orderValueMinor, 2050000);
    assert.equal(buyerDetail.selected.orders.length, 10);
    assert.doesNotMatch(JSON.stringify(buyerDetail), /Foreign private|unitCostMinor|passwordHash|security|address|sessionKey/);
    const literal = await owner.agent.get('/seller/customers?search=%5B.*').set('accept', 'application/json').expect(200); assert.equal(literal.body.records.length, 0);
    for (const [kind, param, id] of [['returns', 'case', foreignReturn.row.publicId], ['customers', 'customer', foreign.row.publicId], ['reviews', 'review', foreignReview.publicId], ['messages', 'thread', foreignThread.publicId]]) {
      await owner.agent.get(`/seller/${kind}?${param}=${id}`).expect(404);
    }
    await User.updateOne({ _id: buyer.user._id }, { $set: { name: 'Changed global profile name', email: `changed-${suffix}@example.com` } });
    assert.equal((await sellerRelationshipPage(serviceRequest(owner, '', {}, { customer: main.row.publicId }), 'seller-customers')).selected.name, buyer.user.name, 'Customer display comes from store purchase snapshot');

    const contactPage = await owner.agent.get('/seller/customers?customer=' + main.row.publicId).expect(200);
    await owner.agent.post(`/seller/customers/${main.row.publicId}/contact`).type('form').send({ subject: 'Delivery follow-up', message: 'Please contact marketplace support if the product is damaged.' }).expect(403);
    await owner.agent.post(`/seller/customers/${main.row.publicId}/contact`).type('form').send({ _csrf: csrf(contactPage.text), subject: 'Delivery follow-up',
      message: 'Please contact marketplace support if the product is damaged.', email: foreignBuyer.user.email, userId: foreignBuyer.user._id }).expect(302);
    const queued = await OutboxEvent.findOne({ type: 'seller.order_notification', aggregatePublicId: main.row.publicId });
    assert.equal(queued.payload.email, main.order.contact.email); assert.equal(queued.status, 'pending');
    assert.equal(await Notification.countDocuments({ userId: buyer.user._id, type: 'seller.order_message' }), 1);
    assert.equal(await Notification.countDocuments({ userId: foreignBuyer.user._id, type: 'seller.order_message' }), 0);
    const delivery = await processNotificationOutbox(); assert.equal(delivery.processed, 1);
    assert.equal((await OutboxEvent.findById(queued._id)).status, 'processed');
    assert.match((await OutboxEvent.findById(queued._id)).lastError, /Development mail sink/);
    await assert.rejects(contactSellerCustomer(serviceRequest(owner, foreign.row.publicId, { subject: 'Attempt', message: 'Unauthorized contact attempt.' })), { code: 'CUSTOMER_NOT_FOUND' });
    const notificationCount = await Notification.countDocuments({ userId: buyer.user._id });
    t.mock.method(OutboxEvent, 'create', async () => { throw new Error('Contact queue unavailable'); });
    try { await assert.rejects(contactSellerCustomer(serviceRequest(owner, main.row.publicId,
      { subject: 'A queued contact', message: 'This contact must be stored atomically.' })), /Contact queue unavailable/); }
    finally { t.mock.restoreAll(); }
    assert.equal(await Notification.countDocuments({ userId: buyer.user._id }), notificationCount);
    assert.equal(await OutboxEvent.countDocuments({ aggregatePublicId: main.row.publicId }), 1);

    let returnPage = await owner.agent.get('/seller/returns?case=' + ownReturn.row.publicId).expect(200);
    const invalidResponse = await owner.agent.post(`/seller/returns/${ownReturn.row.publicId}/respond`).type('form').send({ _csrf: csrf(returnPage.text), version: 0, action: 'contested', message: 'No' }).expect(422);
    assert.match(invalidResponse.text, /name="message"/);
    assert.match(invalidResponse.text, /data-dashboard-workspace="seller"/);
    assert.match(invalidResponse.text, /data-dashboard-page="seller-returns"/);
    assert.match(invalidResponse.text, /Explain the response in at least 10 characters\./);
    assert.match(invalidResponse.text, /name="message"[^>]*>No<\/textarea>/);
    assert.equal((await SellerReturnCase.findById(ownReturn.row._id)).status, 'pending');
    t.mock.method(AuditLog, 'create', async () => { throw new Error('Relationship audit unavailable'); });
    try { await assert.rejects(respondSellerReturn(serviceRequest(owner, ownReturn.row.publicId, { version: 0, action: 'acknowledged', message: 'We are checking this.' })), /Relationship audit unavailable/); }
    finally { t.mock.restoreAll(); }
    assert.equal((await SellerReturnCase.findById(ownReturn.row._id)).status, 'pending');
    const race = await Promise.allSettled(Array.from({ length: 5 }, () => respondSellerReturn(serviceRequest(owner, ownReturn.row.publicId, { version: 0, action: 'acknowledged', message: 'We are checking this.' }))));
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1,
      race.filter(result => result.status === 'rejected').map(result => result.reason.code || result.reason.message).join(', '));
    assert.ok(race.filter(result => result.status === 'rejected').every(result => result.reason.code === 'RELATIONSHIP_VERSION_CONFLICT'));
    returnPage = await owner.agent.get('/seller/returns?case=' + ownReturn.row.publicId).expect(200);
    const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#f47700' } }).png().toBuffer();
    await owner.agent.post(`/seller/returns/${ownReturn.row.publicId}/evidence`).field('version', '1').attach('document', image, 'evidence.png').expect(403);
    assert.equal(await EvidenceDocument.countDocuments({ contextPublicId: ownReturn.row.publicId }), 0);
    await owner.agent.post(`/seller/returns/${ownReturn.row.publicId}/evidence`).field('_csrf', csrf(returnPage.text)).field('version', '1')
      .field('description', 'Packing evidence').attach('document', image, 'evidence.png').expect(302);
    const evidence = await EvidenceDocument.findOne({ contextPublicId: ownReturn.row.publicId, status: 'ready' }); assert.ok(evidence);
    await owner.agent.get('/evidence/' + evidence.publicId).expect(200); await other.agent.get('/evidence/' + evidence.publicId).expect(403);
    assert.equal((await ReturnRequest.findById(ownReturn.ret._id)).status, 'requested', 'Seller response must not bypass marketplace refund decisions');
    const staleResponse = await owner.agent.post(`/seller/returns/${ownReturn.row.publicId}/respond`).type('form').send({ _csrf: csrf(returnPage.text), version: 0, action: 'escalated', message: 'A stale escalation attempt.' }).expect(409);
    assert.match(staleResponse.text, /data-dashboard-workspace="seller"/);
    assert.match(staleResponse.text, /data-dashboard-page="seller-returns"/);
    assert.match(staleResponse.text, /This record changed\. Reload the page before saving\./);
    assert.equal((await SellerReturnCase.findById(ownReturn.row._id)).status, 'acknowledged');
    await owner.agent.post(`/seller/returns/${ownReturn.row.publicId}/respond`).type('form').send({ _csrf: csrf(returnPage.text), version: 2, action: 'contested', message: 'The attached packing evidence needs support review.' }).expect(302);
    assert.equal((await SellerReturnCase.findById(ownReturn.row._id)).status, 'contested');
    await owner.agent.post(`/seller/returns/${ownReturn.row.publicId}/respond`).type('form').send({ _csrf: csrf(returnPage.text), version: 3, action: 'escalated', message: 'Please ask marketplace support to review both accounts.' }).expect(302);
    assert.equal((await SellerReturnCase.findById(ownReturn.row._id)).status, 'escalated');
    const reviewPage = await owner.agent.get('/seller/reviews?review=' + review.publicId).expect(200);
    await owner.agent.post(`/seller/reviews/${review.publicId}/dispute`).type('form').send({ _csrf: csrf(reviewPage.text), version: 0, reason: 'The feedback appears to concern a different item.' }).expect(302);
    assert.equal((await Review.findById(review._id)).status, 'disputed');
    assert.equal(await AuditLog.countDocuments({ action: 'review.disputed', targetPublicId: review.publicId }), 1);
    await assert.rejects(disputeSellerReview(serviceRequest(owner, foreignReview.publicId, { version: 0, reason: 'A forged foreign-store review dispute.' })), { code: 'REVIEW_NOT_FOUND' });

    const messagePage = await owner.agent.get('/seller/messages?thread=' + thread.publicId).expect(200);
    await owner.agent.post(`/seller/messages/${thread.publicId}/reply`).type('form').send({ _csrf: csrf(messagePage.text), version: 0, message: 'We can help you with this delivery.' }).expect(302);
    const savedThread = await SellerContactRequest.findById(thread._id); assert.equal(savedThread.replies.length, 1); assert.equal(savedThread.replies[0].sender, 'seller');
    assert.equal(await Notification.countDocuments({ userId: buyer.user._id, type: 'seller.contact_reply' }), 1);
    const accountMessages = await buyer.agent.get('/account/messages').expect(200); assert.match(accountMessages.text, /We can help you with this delivery/);
    await owner.agent.post(`/seller/messages/${thread.publicId}/resolve`).type('form').send({ _csrf: csrf(messagePage.text), version: 1 }).expect(302);
    assert.equal((await SellerContactRequest.findById(thread._id)).status, 'resolved');
    await assert.rejects(replySellerConversation(serviceRequest(owner, thread.publicId, { version: 2, message: 'Late reply' })), { code: 'CONTACT_RESOLVED' });
    const questionPage = await owner.agent.get('/seller/messages?tab=questions&question=' + question.publicId).expect(200);
    await owner.agent.post(`/seller/messages/questions/${question.publicId}/answer`).type('form').send({ _csrf: csrf(questionPage.text), version: 0, answer: 'Clean the product with a soft dry cloth.' }).expect(302);
    assert.equal((await ProductQuestion.findById(question._id)).status, 'answered');
    const publishedQuestions = await buyer.agent.get('/api/v1/storefront/products/' + ownProduct.product.publicId + '/questions').expect(200);
    assert.equal(publishedQuestions.body.questions[0].answer.body, 'Clean the product with a soft dry cloth.');

    const staff = await actor('customer'), member = await StoreMember.create({ publicId: `stm_rel_${suffix}`, userId: staff.user._id,
      storeId: owner.store._id, invitedByUserId: owner.user._id, role: 'catalogue', status: 'active', acceptedAt: new Date() }); staff.store = owner.store;
    const selection = await staff.agent.get('/account/security').expect(200);
    await staff.agent.post('/seller/workspace').set('accept', 'application/json').type('form').send({ storePublicId: owner.store.publicId, _csrf: csrf(selection.text) }).expect(200);
    for (const kind of ['returns', 'customers', 'reviews', 'messages']) await staff.agent.get('/seller/' + kind).expect(403);
    await StoreMember.updateOne({ _id: member._id }, { $set: { role: 'support' } });
    for (const kind of ['returns', 'customers', 'reviews', 'messages']) await staff.agent.get('/seller/' + kind).expect(200);
    await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } });
    await assert.rejects(sellerRelationshipPage(serviceRequest(staff), 'seller-customers'), { code: 'STORE_PERMISSION_DENIED' });
    await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'active' } });
    await User.updateOne({ _id: staff.user._id }, { $inc: { 'security.tokenVersion': 1 } });
    await assert.rejects(sellerRelationshipPage(serviceRequest(staff), 'seller-reviews'), { code: 'ACCOUNT_UNAVAILABLE' });
    const nonMfa = await actor('customer', false); await StoreMember.create({ publicId: `stm_rel_no_mfa_${suffix}`, userId: nonMfa.user._id,
      storeId: owner.store._id, invitedByUserId: owner.user._id, role: 'support', status: 'active', acceptedAt: new Date() });
    nonMfa.store = owner.store;
    await nonMfa.agent.get('/seller/customers').set('accept', 'application/json').expect(403);
    await assert.rejects(sellerRelationshipPage(serviceRequest(nonMfa), 'seller-customers'), { code: 'MFA_ENROLLMENT_REQUIRED' });
    await assert.rejects(contactSellerCustomer(serviceRequest(nonMfa, main.row.publicId, { subject: 'Denied direct contact', message: 'An unenrolled staff contact must fail.' })), { code: 'MFA_ENROLLMENT_REQUIRED' });
    await User.updateOne({ _id: owner.user._id }, { $unset: { emailVerifiedAt: 1 } });
    try { await assert.rejects(sellerRelationshipPage(serviceRequest(owner), 'seller-reviews'), { code: 'ACCOUNT_UNAVAILABLE' }); }
    finally { await User.updateOne({ _id: owner.user._id }, { $set: { emailVerifiedAt: owner.user.emailVerifiedAt } }); }
    await User.updateOne({ _id: owner.user._id }, { $unset: { onboardingCompletedAt: 1 } });
    try { await assert.rejects(sellerRelationshipPage(serviceRequest(owner), 'seller-messages'), { code: 'ACCOUNT_UNAVAILABLE' }); }
    finally { await User.updateOne({ _id: owner.user._id }, { $set: { onboardingCompletedAt: owner.user.onboardingCompletedAt } }); }
    await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
    try {
      await assert.rejects(sellerRelationshipPage(serviceRequest(owner), 'seller-returns'), { code: 'STORE_MARKET_UNAVAILABLE' });
      await assert.rejects(contactSellerCustomer(serviceRequest(owner, main.row.publicId, { subject: 'Unavailable market', message: 'An inactive country contact must fail.' })), { code: 'STORE_MARKET_UNAVAILABLE' });
    } finally { await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } }); }
    await CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'KES' } });
    try { await assert.rejects(sellerRelationshipPage(serviceRequest(owner), 'seller-customers'), { code: 'STORE_MARKET_UNAVAILABLE' }); }
    finally { await CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'UGX' } }); }
    await SellerOrder.updateOne({ _id: main.row._id }, { $set: { currency: 'KES' } });
    await owner.agent.get('/seller/returns?case=' + ownReturn.row.publicId).expect(404);
    await SellerOrder.updateOne({ _id: main.row._id }, { $set: { currency: 'UGX' } });
    await Store.updateOne({ _id: owner.store._id }, { $set: { status: 'suspended' } });
    await assert.rejects(contactSellerCustomer(serviceRequest(owner, main.row.publicId, { subject: 'Follow-up', message: 'This store is now suspended.' })), { code: 'STORE_LOCKED' });
    await Store.updateOne({ _id: owner.store._id }, { $set: { status: 'verified' } });

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
      server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
      const context = await browser.newContext(), errors = [];
      const cookie = (await owner.agent.get('/seller/customers')).headers['set-cookie'].find(value => value.startsWith('cm.sid=')).split(';')[0];
      const separator = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin }]);
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 950 });
        for (const [kind, query] of [['returns', 'case=' + ownReturn.row.publicId], ['customers', 'customer=' + main.row.publicId], ['reviews', 'review=' + review.publicId], ['messages', 'tab=questions&question=' + question.publicId]]) {
          assert.equal((await page.goto(`${origin}/seller/${kind}?${query}`)).status(), 200);
          assert.equal(new URL(page.url()).hash, '');
          if (width === 390) {
            const recordValue = await page.locator('.role-table-panel tbody tr').first().locator('td > span').first().boundingBox();
            assert.ok(recordValue && recordValue.width >= 140, `${kind} record values need room to remain readable on mobile`);
          }
          const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
            offenders: [...document.querySelectorAll('.seller-standard-live *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1 ||
              (getComputedStyle(node).overflowX === 'visible' && node.scrollWidth > node.clientWidth + 1)).map(node => ({ tag: node.tagName,
                className: node.className, text: node.textContent.trim().slice(0, 100), right: Math.round(node.getBoundingClientRect().right),
                clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })).slice(0, 20) }));
          await page.screenshot({ path: `/tmp/classic-mart-seller-${kind}-${width}.png`, fullPage: true });
          assert.ok(geometry.scroll <= geometry.width + 1, `${kind} overflow at ${width}: ${JSON.stringify(geometry)}`);
        }
      }
      assert.deepEqual(errors, []); await context.close();
    }
  } finally {
    t.mock.restoreAll(); for (const transport of transports) transport.destroy();
    if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
});
