import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Support context uses assigned customer and commerce records with audited limited disclosure and moderation isolation', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(7).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_support_context_test_' + suffix });
  try {
    const { createApp } = await import('../src/app.js');
    const { User, CountrySetting, PlatformGrant, Order, PaymentIntent, Refund, Shipment, SupportTicket, Review, TrustCase, RiskSignal, AuditLog, Notification, Store, Product } = await import('../src/models/index.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { assertSupportContactDisclosure, loadSupportContextPage, revealSupportCustomerContact, createSupportOrderCase, escalateSupportReview, streamSupportContextCsv, supportContextCsvCell } = await import('../src/services/support-context-pages.js');
    const { supportAccess } = await import('../src/services/support-workspace-access.js');
    const { publishReview, reviewTrustCase, reviewRiskSignal } = await import('../src/services/trust.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'Private country', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    const password = 'Support-' + suffix + '-Strong1!', passwordHash = await hashPassword(password), app = createApp(null), secret = 'JBSWY3DPEHPK3PXP';
    let sequence = 0;
    async function actor(role, { country = 'UG', countries = ['UG', 'KE'], managed = false, name, login = false } = {}) {
      const index = ++sequence, email = `context-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_sc_${suffix}_${index}`, name: name || `${role} context ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country, shoppingCountry: 'TZ', currency: 'TZS', operationalCountries: countries, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        platformAccessManagedAt: managed ? new Date() : undefined, security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_sc_${suffix}_${index}`, userId: user._id, role: 'support', operationalCountries: countries, status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Scoped support verification', approvalPublicId: `apr_sc_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) {
        client = request.agent(app);
        const loginPage = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(loginPage.text) }).expect(302).expect('location', '/mfa');
        const mfa = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(mfa.text) }).expect(302);
      }
      return { user, grant, client };
    }
    const staff = await actor('customer', { managed: true, login: true });
    const otherStaff = await actor('support'), moderator = await actor('moderator', { login: true }), foreignModerator = await actor('moderator', { country: 'TZ', countries: ['TZ'] });
    const buyer = await actor('customer', { name: 'Lookup Customer Primary' }), foreignBuyer = await actor('customer', { name: 'Lookup Customer Private', country: 'TZ', countries: [] });
    const scoped = (entry = staff, query = { country: 'UG' }) => ({ id: `req_sc_${suffix}_${++sequence}`, user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query,
      ip: '127.0.0.1', get: () => 'SupportContextTest/1.0' });
    async function order(country = 'UG', owner = buyer, overrides = {}) {
      const index = ++sequence, variantId = new mongoose.Types.ObjectId(), currency = { UG: 'UGX', KE: 'KES', TZ: 'TZS' }[country];
      const seller = await actor('seller', { country, countries: [] });
      const store = await Store.create({ publicId: `sto_sc_${index}`, ownerUserId: seller.user._id, name: `Context store ${index}`, slug: `context-store-${suffix}-${index}`, country, currency, status: 'verified' });
      const product = await Product.create({ publicId: `prd_sc_${index}`, storeId: store._id, ownerUserId: seller.user._id, categoryId: new mongoose.Types.ObjectId(), title: 'Recorded Product', slug: `context-product-${suffix}-${index}`, description: 'A real source product purchased by the recorded customer.', countries: [country], status: 'published', qualityScore: 80 });
      const productId = product._id, storeId = store._id;
      return Order.create({ publicId: `ord_sc_${suffix}_${index}`, idempotencyKey: `context-${suffix}-${index}`, checkoutId: `checkout-${index}`, cartPublicId: `cart-${index}`, sessionKey: `private-order-session-${index}`,
        userId: owner?.user?._id, country, status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', paymentMethod: 'pesapal', deliveryMethod: 'standard',
        contact: { fullName: owner?.user?.name || 'Guest', email: 'private-order-contact@example.com', phone: '+256700999888', address: 'PRIVATE SHIPPING ADDRESS', city: 'Kampala', country },
        totals: { subtotalMinor: 12000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 12000, currency },
        items: [{ linePublicId: `oli_sc_${index}`, productId, variantId, storeId, reservationPublicId: `rsv_sc_${index}`, productPublicId: `prd_sc_${index}`, variantPublicId: `var_sc_${index}`, storePublicId: `sto_sc_${index}`,
          title: 'Recorded Product', variantTitle: 'Original variant', sku: `SKU-${index}`, quantity: 1, deliveredQuantity: 1, unitPriceMinor: 12000, unitCostMinor: 7000, costSnapshotStatus: 'captured', lineTotalMinor: 12000, currency }],
        reservationExpiresAt: new Date(Date.now() + 3600_000), ...overrides });
    }
    const ugOrder = await order(), keOrder = await order('KE'), tzOrder = await order('TZ'), guestOrder = await order('UG', null);
    const payment = await PaymentIntent.create({ publicId: `pay_sc_${suffix}`, orderId: ugOrder._id, orderPublicId: ugOrder.publicId, country: 'UG', provider: 'pesapal', purpose: 'order_payment', method: 'pesapal',
      idempotencyKey: `payment-${suffix}`, status: 'succeeded', amountMinor: 12000, currency: 'UGX', paidAt: new Date(), providerReference: 'PRIVATE PROVIDER REFERENCE', providerTrackingId: 'PRIVATE_TRACKING_ID', providerConfirmationCode: 'PRIVATE CONFIRMATION' });
    await Refund.create({ publicId: `ref_sc_${suffix}`, idempotencyKey: `refund-${suffix}`, orderId: ugOrder._id, paymentIntentId: payment._id, amountMinor: 1000, currency: 'UGX', reason: 'Recorded partial refund', status: 'completed', completedAt: new Date(), manualReference: 'PRIVATE REFUND REFERENCE' });
    await Shipment.create({ publicId: `shp_sc_${suffix}`, orderId: ugOrder._id, orderPublicId: ugOrder.publicId, country: 'UG', kind: 'outbound', mode: 'standard', status: 'delivered', deliveredAt: new Date(), deliveryCodeHash: 'PRIVATE PROOF HASH', deliveryCodeEncrypted: encryptSensitive('123456') });
    const review = await Review.create({ publicId: `rev_sc_${suffix}`, userId: buyer.user._id, orderId: ugOrder._id, orderPublicId: ugOrder.publicId, country: 'UG', productId: ugOrder.items[0].productId,
      productPublicId: ugOrder.items[0].productPublicId, rating: 2, title: 'Recorded review', body: 'Verified buyer reported product concern.', status: 'published', publishedAt: new Date() });
    const newReview = async () => { const purchase = await order('KE'); return Review.create({ publicId: `rev_sc_${suffix}_${++sequence}`, userId: buyer.user._id, orderId: purchase._id, orderPublicId: purchase.publicId, country: 'KE', productId: purchase.items[0].productId, productPublicId: purchase.items[0].productPublicId,
      rating: 4, body: 'Actual review awaiting moderation.', status: 'pending' }); };
    let caseRecord;

    await t.test('lookup requires a minimum search and masks contacts and sensitive account fields', async () => {
      const empty = await loadSupportContextPage(scoped(), 'support-customers'); assert.equal(empty.page.total, 0); assert.equal(empty.lookupRequired, true);
      await assert.rejects(loadSupportContextPage(scoped(staff, { country: 'UG', q: 'Lo' }), 'support-customers'), error => error.code === 'SUPPORT_LOOKUP_TOO_SHORT');
      const flow = await loadSupportContextPage(scoped(staff, { country: 'UG', q: 'Lookup Customer' }), 'support-customers');
      assert.equal(flow.page.total, 1); assert.equal(flow.items[0].publicId, buyer.user.publicId); assert.equal(flow.items[0].orderCount, 1, 'Only orders actually belonging to this user and country are counted');
      const serialized = JSON.stringify(flow); assert.ok(!serialized.includes(buyer.user.email)); assert.ok(!serialized.includes(buyer.user.phone));
      for (const term of ['passwordHash', 'emailNormalized', 'phoneNormalized', 'mfaSecretEncrypted', 'tokenVersion', foreignBuyer.user.publicId, tzOrder.publicId]) assert.ok(!serialized.includes(term));
      const exact = await loadSupportContextPage(scoped(staff, { country: 'UG', search: buyer.user.email }), 'support-customers'); assert.equal(exact.page.total, 1); assert.ok(exact.items[0].emailMasked.includes('***'));
    });
    await t.test('customer selection keeps foreign orders out even for the same shopper', async () => {
      const ug = await loadSupportContextPage(scoped(staff, { country: 'UG', record: buyer.user.publicId }), 'support-customers');
      assert.ok(ug.selectedCustomer.orders.some(row => row.publicId === ugOrder.publicId));
      assert.ok(!JSON.stringify(ug.selectedCustomer).includes(keOrder.publicId)); assert.ok(!JSON.stringify(ug.selectedCustomer).includes(tzOrder.publicId));
      await assert.rejects(loadSupportContextPage(scoped(staff, { country: 'UG', record: foreignBuyer.user.publicId }), 'support-customers'), error => error.status === 404);
    });
    await t.test('order details expose recorded state and safe provider and logistics fields only', async () => {
      const flow = await loadSupportContextPage(scoped(staff, { country: 'UG', record: ugOrder.publicId }), 'support-orders'), selected = flow.selectedOrder;
      assert.equal(selected.currency, 'UGX'); assert.equal(selected.paymentState, 'paid'); assert.equal(selected.fulfillmentState, 'delivered');
      assert.equal(selected.payments[0].publicId, payment.publicId); assert.equal(selected.shipments[0].status, 'delivered'); assert.equal(selected.refunds[0].amountMinor, 1000);
      for (const text of ['PRIVATE', 'unitCostMinor', 'sessionKey', 'contact', 'deliveryCode', 'providerTrackingId', 'manualReference']) assert.ok(!JSON.stringify(selected).includes(text), text);
      const ke = await loadSupportContextPage(scoped(staff, { country: 'KE', record: keOrder.publicId }), 'support-orders'); assert.equal(ke.selectedOrder.currency, 'KES');
      await assert.rejects(loadSupportContextPage(scoped(staff, { country: 'UG', record: keOrder.publicId }), 'support-orders'), error => error.status === 404);
      await assert.rejects(loadSupportContextPage(scoped(staff, { country: 'TZ' }), 'support-orders'), error => error.status === 403);
    });
    await t.test('staff case creation belongs to the actual owner and does not alter order money or lifecycle', async () => {
      const before = await Order.findById(ugOrder._id).lean();
      caseRecord = await createSupportOrderCase(scoped(), ugOrder.publicId, { version: before.__v || 0, subject: 'Review concern for order', category: 'order', priority: 'high', message: 'PRIVATE INTERNAL STAFF NOTE for investigating the review.' });
      const saved = await SupportTicket.findOne({ publicId: caseRecord.publicId }).lean(), after = await Order.findById(ugOrder._id).lean();
      assert.equal(String(saved.userId), String(buyer.user._id)); assert.equal(String(saved.createdByUserId), String(staff.user._id)); assert.equal(saved.source, 'staff');
      assert.equal(saved.orderPublicId, ugOrder.publicId); assert.equal(saved.notes[0].internal, true); assert.equal(String(saved.notes[0].actorUserId), String(staff.user._id));
      assert.deepEqual(after.totals, before.totals); assert.equal(after.paymentState, before.paymentState); assert.equal(after.fulfillmentState, before.fulfillmentState);
      assert.equal(await Notification.countDocuments({ userId: buyer.user._id, type: 'support_case_created' }), 1); assert.equal(await AuditLog.countDocuments({ action: 'support.order_case_created', targetPublicId: saved.publicId }), 1);
      await assert.rejects(createSupportOrderCase(scoped(), ugOrder.publicId, { version: after.__v, subject: 'Duplicate case', category: 'order', message: 'Another same-category order case.' }), error => error.code === 'SUPPORT_DUPLICATE');
      await assert.rejects(createSupportOrderCase(scoped(), guestOrder.publicId, { version: 0, subject: 'Guest case', category: 'order', message: 'Cannot impersonate a guest requester.' }), error => error.code === 'SUPPORT_GUEST_IDENTITY_REQUIRED');
    });
    await t.test('full contact disclosure requires an assigned active linked case and persists atomic audit', async () => {
      const ticket = await SupportTicket.findOne({ publicId: caseRecord.publicId });
      const input = { ticketId: ticket.publicId, version: ticket.__v, reason: 'Customer requested a callback about this order.' };
      await assert.rejects(revealSupportCustomerContact(scoped(otherStaff), buyer.user.publicId, input), error => error.status === 403);
      await assert.rejects(revealSupportCustomerContact(scoped(), foreignBuyer.user.publicId, input), error => error.status === 403);
      const disclosed = await revealSupportCustomerContact(scoped(), buyer.user.publicId, input);
      assert.equal(disclosed.email, buyer.user.email); assert.equal(disclosed.phone, buyer.user.phone); assert.equal(disclosed.ticketVersion, ticket.__v + 1);
      assert.equal(await AuditLog.countDocuments({ action: 'support.customer_contact_disclosed', targetPublicId: ticket.publicId }), 1);
      assert.ok(!JSON.stringify((await loadSupportContextPage(scoped(staff, { country: 'UG', record: buyer.user.publicId }), 'support-customers')).selectedCustomer).includes(buyer.user.email));
      await assert.rejects(revealSupportCustomerContact(scoped(), buyer.user.publicId, input), error => error.status === 409);
      await SupportTicket.updateOne({ _id: ticket._id }, { $set: { status: 'resolved' }, $inc: { __v: 1 } });
      await assert.rejects(revealSupportCustomerContact(scoped(), buyer.user.publicId, { ...input, version: ticket.__v + 2 }), error => error.status === 403);
      await SupportTicket.updateOne({ _id: ticket._id }, { $set: { status: 'open' }, $inc: { __v: 1 } });
    });
    await t.test('contact disclosure fences the active recipient and linked order and rolls back with its audit', async () => {
      const ticket = await SupportTicket.findOne({ publicId: caseRecord.publicId }), beforeCustomer = await User.findById(buyer.user._id).lean(), beforeOrder = await Order.findById(ugOrder._id).lean();
      const beforeActor = await User.findById(staff.user._id).lean(), beforeAudit = await AuditLog.countDocuments({ action: 'support.customer_contact_disclosed' }), originalCreate = AuditLog.create;
      try {
        AuditLog.create = async function (...args) {
          if (args[0]?.[0]?.action === 'support.customer_contact_disclosed') throw new Error('Injected contact disclosure audit failure');
          return originalCreate.apply(this, args);
        };
        await assert.rejects(revealSupportCustomerContact(scoped(), buyer.user.publicId, { ticketId: ticket.publicId, version: ticket.__v, reason: 'Required order callback with atomic contact authorization.' }), /Injected contact disclosure audit failure/);
      } finally { AuditLog.create = originalCreate; }
      assert.equal((await User.findById(buyer.user._id)).__v, beforeCustomer.__v);
      assert.equal((await User.findById(staff.user._id)).__v, beforeActor.__v);
      assert.equal((await Order.findById(ugOrder._id)).__v, beforeOrder.__v);
      assert.equal((await SupportTicket.findById(ticket._id)).__v, ticket.__v);
      assert.equal(await AuditLog.countDocuments({ action: 'support.customer_contact_disclosed' }), beforeAudit);
      await User.updateOne({ _id: buyer.user._id }, { $set: { status: 'suspended' }, $inc: { __v: 1 } });
      await assert.rejects(revealSupportCustomerContact(scoped(), buyer.user.publicId, { ticketId: ticket.publicId, version: ticket.__v, reason: 'Inactive recipient contacts cannot be disclosed.' }), error => error.code === 'SUPPORT_CUSTOMER_UNAVAILABLE');
      await User.updateOne({ _id: buyer.user._id }, { $set: { status: 'active' }, $inc: { __v: 1 } });
      await Order.updateOne({ _id: ugOrder._id }, { $set: { userId: foreignBuyer.user._id }, $inc: { __v: 1 } });
      await assert.rejects(revealSupportCustomerContact(scoped(), buyer.user.publicId, { ticketId: ticket.publicId, version: ticket.__v, reason: 'A mismatched requester order cannot authorize contacts.' }), error => error.code === 'SUPPORT_CONTACT_CASE_CHANGED');
      await Order.updateOne({ _id: ugOrder._id }, { $set: { userId: buyer.user._id }, $inc: { __v: 1 } });
      assert.equal(await AuditLog.countDocuments({ action: 'support.customer_contact_disclosed' }), beforeAudit);
    });
    await t.test('contact response binding rejects changed assignment, recipient contacts and order ownership', async () => {
      const recipient = await actor('customer', { name: 'Contact race customer' }), purchase = await order('UG', recipient);
      const opened = await createSupportOrderCase(scoped(), purchase.publicId, { version: 0, category: 'order', subject: 'Contact source verification', message: 'The actual requester needs a scoped order callback.' });
      const disclose = async () => {
        const ticket = await SupportTicket.findOne({ publicId: opened.publicId });
        return revealSupportCustomerContact(scoped(), recipient.user.publicId, { ticketId: ticket.publicId, version: ticket.__v, reason: 'A necessary case contact callback for the order owner.' });
      };
      const original = await supportAccess(scoped());
      let contact = await disclose(); await assertSupportContactDisclosure(scoped(), original, contact);
      await SupportTicket.updateOne({ publicId: opened.publicId }, { $set: { assignedUserId: otherStaff.user._id }, $inc: { __v: 1 } });
      await assert.rejects(assertSupportContactDisclosure(scoped(), original, contact), error => error.code === 'SUPPORT_CONTACT_CASE_CHANGED');
      await SupportTicket.updateOne({ publicId: opened.publicId }, { $set: { assignedUserId: staff.user._id }, $inc: { __v: 1 } });
      contact = await disclose();
      const replacementEmail = `changed-contact-${suffix}@example.com`;
      await User.updateOne({ _id: recipient.user._id }, { $set: { email: replacementEmail, emailNormalized: replacementEmail }, $inc: { __v: 1 } });
      await assert.rejects(assertSupportContactDisclosure(scoped(), original, contact), error => error.code === 'SUPPORT_CONTACT_CASE_CHANGED');
      contact = await disclose(); assert.equal(contact.email, replacementEmail);
      await User.updateOne({ _id: recipient.user._id }, { $set: { status: 'pending_deletion' }, $inc: { __v: 1 } });
      await assert.rejects(assertSupportContactDisclosure(scoped(), original, contact), error => error.code === 'SUPPORT_CONTACT_CASE_CHANGED');
      await User.updateOne({ _id: recipient.user._id }, { $set: { status: 'active' }, $inc: { __v: 1 } });
      contact = await disclose();
      await Order.updateOne({ _id: purchase._id }, { $set: { userId: foreignBuyer.user._id }, $inc: { __v: 1 } });
      await assert.rejects(assertSupportContactDisclosure(scoped(), original, contact), error => error.code === 'SUPPORT_CONTACT_CASE_CHANGED');
    });
    await t.test('HTML contact disclosure rechecks assignment after the final header and sidebar reads', async () => {
      const recipient = await actor('customer', { name: 'Late render contact customer' }), purchase = await order('UG', recipient);
      const opened = await createSupportOrderCase(scoped(), purchase.publicId, { version: 0, category: 'order', subject: 'Final contact boundary', message: 'Contact is limited to the currently assigned active case.' });
      const page = await staff.client.get('/support/customers?country=UG&record=' + recipient.user.publicId).expect(200);
      const ticket = await SupportTicket.findOne({ publicId: opened.publicId });
      const originalCreate = AuditLog.create, originalAggregate = SupportTicket.aggregate;
      let armed = false, assignmentChanged = false;
      try {
        AuditLog.create = async function (...args) {
          const result = await originalCreate.apply(this, args);
          if (args[0]?.[0]?.action === 'support.customer_contact_disclosed') armed = true;
          return result;
        };
        SupportTicket.aggregate = function (...args) {
          const aggregate = originalAggregate.apply(this, args);
          if (armed && args[0].some(stage => stage.$group)) {
            const originalExec = aggregate.exec;
            aggregate.exec = async function (...execArgs) {
              const result = await originalExec.apply(this, execArgs);
              if (!assignmentChanged) {
                assignmentChanged = true;
                await SupportTicket.updateOne({ publicId: opened.publicId }, { $set: { assignedUserId: otherStaff.user._id }, $inc: { __v: 1 } });
              }
              return result;
            };
          }
          return aggregate;
        };
        const response = await staff.client.post('/support/customers/' + recipient.user.publicId + '/contact?country=UG').type('form')
          .send({ _csrf: csrf(page.text), ticketId: ticket.publicId, version: ticket.__v, reason: 'Necessary callback whose assignment changes while the frame loads.' }).expect(409);
        assert.equal(assignmentChanged, true, 'The case transfer occurred during the later sidebar read');
        assert.ok(!response.text.includes(recipient.user.email)); assert.ok(!response.text.includes(recipient.user.phone));
      } finally { AuditLog.create = originalCreate; SupportTicket.aggregate = originalAggregate; }
    });
    await t.test('review escalation keeps publication unchanged and links the recorded support evidence and moderation alert', async () => {
      const result = await escalateSupportReview(scoped(), review.publicId, { version: review.__v, ticketId: caseRecord.publicId, description: 'Buyer reported an authenticity concern backed by case evidence.' });
      assert.equal(result.moderationStatus, 'published');
      const saved = await Review.findById(review._id), issue = await TrustCase.findOne({ publicId: result.publicId }).lean();
      assert.equal(saved.status, 'published'); assert.equal(issue.reviewStatusSnapshot, 'published'); assert.equal(issue.reviewVersionSnapshot, 0);
      assert.equal(String(issue.reviewId), String(review._id)); assert.equal(issue.supportTicketPublicId, caseRecord.publicId); assert.equal(issue.status, 'open');
      assert.equal(await Notification.countDocuments({ userId: moderator.user._id, type: 'support_review_escalated' }), 1);
      assert.equal(await Notification.countDocuments({ userId: foreignModerator.user._id, type: 'support_review_escalated' }), 0);
      const detail = await loadSupportContextPage(scoped(staff, { country: 'UG', record: review.publicId }), 'support-reviews'); assert.equal(detail.selectedReview.issue.publicId, result.publicId);
      await assert.rejects(escalateSupportReview(scoped(), review.publicId, { version: saved.__v, ticketId: caseRecord.publicId, description: 'Follow-up facts must stay with the existing durable case.' }), error => error.code === 'SUPPORT_REVIEW_ALREADY_ESCALATED');
      assert.equal(await TrustCase.countDocuments({ reviewId: review._id }), 1);
    });
    await t.test('Support cannot publish or reject reviews or decide moderation cases and risk signals directly', async () => {
      const pending = await newReview(), issue = await TrustCase.findOne({ reviewId: review._id }), risk = await RiskSignal.create({ publicId: `rsk_sc_${suffix}`, country: 'UG', subjectType: 'product', subjectPublicId: review.productPublicId, type: 'review_manipulation', severity: 'medium' });
      await assert.rejects(publishReview(scoped(), pending.publicId, { decision: 'publish', reason: 'Support does not moderate reviews.' }), error => error.status === 403);
      await assert.rejects(reviewTrustCase(scoped(), issue, { status: 'dismissed', enforcement: 'none', decision: 'Support does not decide trust outcomes.' }), error => error.status === 403);
      await assert.rejects(reviewRiskSignal(scoped(), risk, { status: 'dismissed', decision: 'Support does not decide risk outcomes.' }), error => error.status === 403);
      assert.equal((await Review.findById(pending._id)).status, 'pending'); assert.equal((await TrustCase.findById(issue._id)).status, 'open'); assert.equal((await RiskSignal.findById(risk._id)).status, 'open');
      const fresh = await publishReview(scoped(moderator, { country: 'KE' }), pending.publicId, { version: 0, decision: 'publish', reason: 'Actual assigned market moderation decision.' });
      assert.equal(fresh.status, 'published'); assert.equal(await AuditLog.countDocuments({ action: 'review.moderated', targetPublicId: pending.publicId }), 1);
      await assert.rejects(publishReview(scoped(moderator), pending.publicId, { version: 0, decision: 'reject', reason: 'Stale outcome cannot replace publication.' }), error => error.status === 409);
    });
    await t.test('fresh moderation role and token checks reject stale actors and rollback audit failures', async () => {
      const pending = await newReview(), originalRole = moderator.user.role;
      await User.updateOne({ _id: moderator.user._id }, { $set: { role: 'support' } });
      await assert.rejects(publishReview(scoped(moderator), pending.publicId, { decision: 'publish', reason: 'Old role data cannot grant permission.' }), error => error.status === 403);
      await User.updateOne({ _id: moderator.user._id }, { $set: { role: originalRole, 'security.tokenVersion': 1 } });
      await assert.rejects(publishReview(scoped(moderator), pending.publicId, { decision: 'publish', reason: 'Revoked session cannot grant permission.' }), error => error.status === 403);
      await User.updateOne({ _id: moderator.user._id }, { $set: { 'security.tokenVersion': 0 } });
      const before = await User.findById(moderator.user._id).lean(), originalCreate = AuditLog.create;
      try {
        AuditLog.create = async () => { throw new Error('Injected authoritative audit failure'); };
        await assert.rejects(publishReview(scoped(moderator), pending.publicId, { decision: 'publish', reason: 'Atomic evidence failure must roll back.' }), /Injected authoritative audit failure/);
      } finally { AuditLog.create = originalCreate; }
      assert.equal((await Review.findById(pending._id)).status, 'pending'); assert.equal((await User.findById(moderator.user._id)).__v, before.__v);
    });
    await t.test('managed moderation decisions use current grants and preserve independent appeal review', async () => {
      const delegated = await actor('customer', { managed: true });
      await PlatformGrant.updateOne({ _id: delegated.grant._id }, { $set: { role: 'moderator' } });
      const pending = await newReview();
      const published = await publishReview(scoped(delegated), pending.publicId, { decision: 'publish', reason: 'Current authoritative grant permits this decision.' });
      assert.equal(published.status, 'published');
      const next = await newReview(); await PlatformGrant.updateOne({ _id: delegated.grant._id }, { $set: { status: 'suspended' } });
      await assert.rejects(publishReview(scoped(delegated), next.publicId, { decision: 'publish', reason: 'Suspended grant must reject this decision.' }), error => error.status === 403);
      await PlatformGrant.updateOne({ _id: delegated.grant._id }, { $set: { status: 'active', role: 'support' } });
      await assert.rejects(publishReview(scoped(delegated), next.publicId, { decision: 'publish', reason: 'Current Support grant must reject this decision.' }), error => error.status === 403);
      const issue = await TrustCase.findOne({ reviewId: review._id });
      await TrustCase.updateOne({ _id: issue._id }, { $set: { status: 'appealed', appealOriginalDecisionByUserId: moderator.user._id }, $unset: { assignedUserId: 1, assignedAt: 1 }, $inc: { __v: 1 } });
      const appeal = await TrustCase.findById(issue._id);
      await assert.rejects(reviewTrustCase(scoped(moderator), appeal, { status: 'dismissed', enforcement: 'none', decision: 'The prior reviewer must not decide this appeal.' }), error => error.code === 'TRUST_APPEAL_FOUR_EYES');
      const independent = await actor('moderator');
      const decided = await reviewTrustCase(scoped(independent), appeal, { status: 'dismissed', enforcement: 'none', decision: 'Independent appeal review records a scoped outcome.' });
      assert.equal(decided.status, 'dismissed');
      assert.equal((await Review.findById(review._id)).status, 'published', 'Trust case decision does not implicitly alter review moderation');
    });
    await t.test('context writes roll back on audit failure and case concurrency admits one creator', async () => {
      const target = await order(), before = await Order.findById(target._id).lean(), originalCreate = AuditLog.create;
      const body = { version: 0, category: 'delivery', subject: 'Scoped order delivery concern', message: 'Investigate actual recorded delivery evidence.' };
      try { AuditLog.create = async () => { throw new Error('Injected support audit failure'); }; await assert.rejects(createSupportOrderCase(scoped(), target.publicId, body), /Injected support audit failure/); }
      finally { AuditLog.create = originalCreate; }
      assert.equal(await SupportTicket.countDocuments({ orderId: target._id }), 0); assert.equal((await Order.findById(target._id)).__v, before.__v);
      const settled = await Promise.allSettled([createSupportOrderCase(scoped(), target.publicId, body), createSupportOrderCase(scoped(otherStaff), target.publicId, body)]);
      assert.equal(settled.filter(row => row.status === 'fulfilled').length, 1); assert.equal(await SupportTicket.countDocuments({ orderId: target._id }), 1);
    });
    await t.test('full result counts and keyset pages continue beyond the first 25 records', async () => {
      for (let index = 0; index < 54; index++) await order();
      const first = await loadSupportContextPage(scoped(), 'support-orders'); assert.ok(first.page.total > 50); assert.equal(first.rows.length, 25); assert.equal(first.page.hasMore, true);
      const next = await loadSupportContextPage(scoped(staff, { country: 'UG', after: first.page.next }), 'support-orders'); assert.equal(next.page.total, first.page.total);
      assert.equal(new Set([...first.items, ...next.items].map(row => row.publicId)).size, first.items.length + next.items.length);
      await assert.rejects(loadSupportContextPage(scoped(staff, { country: 'UG', after: 'garbage' }), 'support-orders'), error => error.status === 422);
    });
    await t.test('exports neutralize spreadsheet formulas and stop after current grant revocation', async () => {
      assert.equal(supportContextCsvCell('=HYPERLINK("private")'), '"\'=HYPERLINK(""private"")"');
      class Response extends EventEmitter {
        constructor() { super(); this.lines = []; this.headers = {}; this.destroyed = false; this.ended = false; }
        set(key, value) { this.headers[key] = value; return this; }
        write(line) { this.lines.push(line); if (this.lines.length === 2) { PlatformGrant.updateOne({ _id: staff.grant._id }, { $set: { status: 'suspended' } }).then(() => this.emit('drain'), error => this.emit('error', error)); return false; } return true; }
        end() { this.ended = true; }
      }
      const response = new Response();
      await assert.rejects(streamSupportContextCsv(scoped(), response, 'support-orders'), error => error.status === 403);
      assert.equal(response.lines.length, 2); assert.equal(response.ended, false); assert.match(response.headers['Cache-Control'], /no-store/);
      await PlatformGrant.updateOne({ _id: staff.grant._id }, { $set: { status: 'active' } });
    });
    await t.test('real routes preserve the approved Support frame and gate CSRF and duplicate filters', async () => {
      const page = await staff.client.get('/support/orders?country=UG&record=' + ugOrder.publicId).expect(200); assert.match(page.text, /Order context/); assert.ok(!page.text.includes('PRIVATE SHIPPING ADDRESS'));
      const json = await staff.client.get('/support/customers?country=UG&search=' + encodeURIComponent('Lookup Customer')).set('Accept', 'application/json').expect(200);
      assert.match(json.headers['cache-control'], /no-store/); assert.equal(json.headers['x-robots-tag'], 'noindex, nofollow, noarchive'); assert.ok(!JSON.stringify(json.body).includes(buyer.user.email));
      await staff.client.get('/support/orders?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await staff.client.get('/support/customers?search[bad]=Lookup').set('Accept', 'application/json').expect(422);
      const ticket = await SupportTicket.findOne({ publicId: caseRecord.publicId });
      const input = { ticketId: ticket.publicId, version: ticket.__v, reason: 'A necessary audited customer callback.' };
      await staff.client.post('/support/customers/' + buyer.user.publicId + '/contact?country=UG').set('Accept', 'application/json').send(input).expect(403);
      const disclosure = await staff.client.post('/support/customers/' + buyer.user.publicId + '/contact?country=UG').set('Accept', 'application/json').set('x-csrf-token', csrf(page.text)).send(input).expect(200);
      assert.equal(disclosure.body.contact.email, buyer.user.email); assert.match(disclosure.headers['cache-control'], /no-store/);
      const csv = await staff.client.get('/support/customers/export.csv?country=UG&search=' + encodeURIComponent('Lookup Customer')).expect(200);
      assert.ok(!csv.text.includes(buyer.user.email)); assert.ok(!csv.text.includes(buyer.user.phone));
      await staff.client.post('/moderation/reviews/' + review.publicId + '/decision').set('x-csrf-token', csrf(page.text)).send({ decision: 'reject', reason: 'Support cannot perform this decision.' }).expect(403);
      const moderatorPage = await moderator.client.get('/account/security').expect(200), pending = await newReview();
      await moderator.client.post('/moderation/reviews/' + pending.publicId + '/decision').send({ decision: 'publish', reason: 'CSRF remains required for an authorized reviewer.' }).expect(403);
      await moderator.client.post('/moderation/reviews/' + pending.publicId + '/decision').set('x-csrf-token', csrf(moderatorPage.text)).send({ version: 0, decision: 'publish', reason: 'Real authenticated moderation endpoint records its decision.' }).expect(303);
      assert.equal((await Review.findById(pending._id)).status, 'published'); assert.equal(await AuditLog.countDocuments({ action: 'review.moderated', targetPublicId: pending.publicId }), 1);
    });
  } finally {
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
