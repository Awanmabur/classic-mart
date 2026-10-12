import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.AI_ENABLED = 'false';
for (const key of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[key] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;

test('Customer dispute projection keeps public decisions without leaking staff records', async () => {
  const { customerDisputeDto, customerSatisfactionDto } = await import('../src/services/customer-dispute-pages.js');
  const buyer = new mongoose.Types.ObjectId(), staff = new mongoose.Types.ObjectId();
  const result = customerDisputeDto({ publicId: 'dsp_public', userId: buyer, orderPublicId: 'ord_public', country: 'UG',
    status: 'resolved', category: 'refund', subject: 'Recorded refund', description: 'Please review the actual refund.', priority: 'normal', __v: 3,
    assignedUserId: staff, review: { notes: 'PRIVATE_REVIEW_NOTES' }, escalation: { reason: 'PRIVATE_REFERRAL_NOTES' },
    resolution: { decision: 'customer_service', summary: 'The public decision is saved.', resolvedByUserId: staff, resolvedAt: new Date() },
    evidenceDocumentIds: [staff], events: [{ type: 'dispute.customer_reply', message: 'Public requester reply.', actorUserId: buyer, visibility: 'customer' },
      { type: 'dispute.reviewed', message: 'PRIVATE_REVIEW_NOTES', actorUserId: staff, visibility: 'internal' }] });
  assert.equal(result.version, 3);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].author, 'You');
  assert.equal(result.resolution.summary, 'The public decision is saved.');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|assignedUserId|resolvedByUserId|evidenceDocumentIds|actorUserId/);
  const rating = customerSatisfactionDto({ _id: staff, publicId: 'sat_public', ticketId: staff,
    ticketPublicId: 'tkt_public', userId: buyer, country: 'UG', rating: 5, comment: 'Saved rating.', __v: 4 });
  assert.equal(rating.rating, 5);
  assert.doesNotMatch(JSON.stringify(rating), /ticketId|userId|__v|_id/);
});

test('Customer disputes, appeals and ratings preserve current ownership, source records and atomic evidence', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_customer_disputes_test_' + suffix });
  try {
    const { User, CountrySetting, Order, Dispute, SupportTicket, SatisfactionSurvey, AuditLog, Notification } = await import('../src/models/index.js');
    const { createDispute, submitSatisfaction } = await import('../src/services/trust.js');
    const { appealOwnedDispute } = await import('../src/services/customer-dispute-pages.js');
    const { assignSupportDispute, reviewSupportDispute, resolveSupportDispute } = await import('../src/services/support-case-pages.js');
    const { loadCustomerDashboardPage } = await import('../src/dashboard/customer-data.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' }]);
    const password = 'Dispute-' + suffix + '-A1!', passwordHash = await hashPassword(password);
    let sequence = 0;
    const id = prefix => prefix + '_cd_' + suffix + '_' + (++sequence);
    async function actor(role = 'customer', country = 'UG', preferences = {}) {
      const index = ++sequence, email = 'customer-dispute-' + suffix + '-' + index + '@example.com', phone = '+25670' + String(index).padStart(7, '0');
      let user = await User.create({ publicId: id('usr'), name: 'Dispute owner ' + index, email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash,
        role, country, currency: country === 'UG' ? 'UGX' : 'KES', operationalCountries: [country], emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        preferences, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      if (role === 'support') {
        const pending = await beginMfaEnrollment(user._id, password);
        user = (await confirmMfaEnrollment(user._id, totpCode(pending.secret))).user;
      }
      return user;
    }
    const buyer = await actor(), other = await actor(), support = await actor('support'), optedOut = await actor('support', 'UG', { supportPriorityAlerts: false, supportEscalationAlerts: false }), foreignSupport = await actor('support', 'KE');
    const req = user => ({ id: id('req'), user, session: { tokenVersion: user.security.tokenVersion }, country: { code: 'KE' }, ip: '127.0.0.1', get: () => 'CustomerDisputeTest/1.0' });
    async function order(owner = buyer, country = 'UG', currency = country === 'UG' ? 'UGX' : 'KES') {
      const product = new mongoose.Types.ObjectId(), variant = new mongoose.Types.ObjectId(), store = new mongoose.Types.ObjectId();
      return Order.create({ publicId: id('ord'), idempotencyKey: id('key'), checkoutId: id('chk'), cartPublicId: id('crt'), sessionKey: id('session'),
        userId: owner._id, country, status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', paymentMethod: 'card', deliveryMethod: 'standard',
        contact: { fullName: owner.name, email: owner.email, phone: owner.phone, address: 'Private buyer street', city: 'Kampala', country },
        items: [{ linePublicId: id('oli'), productId: product, variantId: variant, storeId: store, productPublicId: id('prd'), variantPublicId: id('var'),
          storePublicId: id('sto'), reservationPublicId: id('rsv'), title: 'Order goods', variantTitle: 'Standard', sku: id('sku').toUpperCase(), quantity: 1,
          deliveredQuantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000, currency }],
        totals: { subtotalMinor: 10000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000, currency }, reservationExpiresAt: new Date(Date.now() + 86400_000) });
    }
    const input = source => ({ orderId: source.publicId, category: 'payment', subject: 'Payment review request', description: 'Please review the payment for this exact saved order.' });
    async function terminalDispute() {
      const source = await order(), dispute = await createDispute(req(buyer), input(source));
      await Dispute.updateOne({ _id: dispute._id }, { $set: { status: 'resolved', resolvedAt: new Date(), assignedUserId: support._id,
        review: { notes: 'PRIVATE_CUSTOMER_REVIEW', reviewedByUserId: support._id, reviewedAt: new Date() },
        escalation: { department: 'finance', reason: 'PRIVATE_FINANCE_REFERRAL', referralTicketPublicId: id('tkt') },
        resolution: { decision: 'customer_service', summary: 'The original public decision remains available.', resolvedByUserId: support._id, resolvedAt: new Date() } },
        $push: { events: { type: 'dispute.reviewed', message: 'PRIVATE_CUSTOMER_REVIEW', visibility: 'internal', actorUserId: support._id } }, $inc: { __v: 1 } });
      return { source, dispute: await Dispute.findById(dispute._id) };
    }
    async function ticket({ status = 'resolved', owner = buyer, country = 'UG', source = null } = {}) {
      const createdAt = new Date(Date.now() - 2 * 3600_000);
      return SupportTicket.create({ publicId: id('tkt'), userId: owner._id, createdByUserId: owner._id, source: 'customer', country,
        category: 'account', subject: 'Saved account support request', status, queue: 'accounts', priority: 'normal',
        createdAt, slaDueAt: new Date(createdAt.getTime() + 48 * 3600_000),
        orderId: source?._id, orderPublicId: source?.publicId, resolvedAt: status === 'resolved' ? new Date() : undefined,
        notes: [{ message: 'Public requester message.', internal: false, actorUserId: owner._id }, { message: 'PRIVATE_INTERNAL_TICKET', internal: true, actorUserId: support._id }] });
    }

    await t.test('creation keeps the real owner and full description while alerting only current scoped subscribers', async () => {
      const source = await order(), description = 'Recorded detail. '.repeat(160);
      const dispute = await createDispute(req(buyer), { ...input(source), description, userId: other._id, country: 'KE', assignedUserId: support._id });
      assert.equal(String(dispute.userId), String(buyer._id)); assert.equal(dispute.country, 'UG'); assert.equal(dispute.description, description.trim());
      assert.ok(dispute.events[0].message.length <= 1000); assert.equal(dispute.assignedUserId, undefined);
      const alerts = await Notification.find({ href: '/support/escalations?record=' + dispute.publicId }).lean();
      assert.deepEqual(alerts.map(row => String(row.userId)), [String(support._id)]);
      assert.ok(!alerts.some(row => [String(optedOut._id), String(foreignSupport._id)].includes(String(row.userId))));
      assert.equal(await AuditLog.countDocuments({ action: 'customer.dispute_created', targetPublicId: dispute.publicId }), 1);
    });
    await t.test('concurrent duplicate requests create one active order case and one authoritative audit', async () => {
      const source = await order(), attempts = await Promise.allSettled([1, 2].map(() => createDispute(req(buyer), input(source))));
      assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter(row => row.status === 'rejected' && row.reason.code === 'DISPUTE_ALREADY_OPEN').length, 1);
      assert.equal(await Dispute.countDocuments({ orderId: source._id }), 1);
    });
    await t.test('current sessions, verification, ownership and source market are enforced for direct callers', async () => {
      const source = await order();
      await assert.rejects(createDispute(req(other), input(source)), error => error.code === 'ORDER_NOT_FOUND');
      const staleSession = req(buyer); staleSession.session.tokenVersion += 1;
      await assert.rejects(createDispute(staleSession, input(source)), error => error.code === 'ACCOUNT_UNAVAILABLE');
      for (const [field, value, restore] of [['status', 'suspended', 'active'], ['emailVerifiedAt', null, new Date()], ['onboardingCompletedAt', null, new Date()]]) {
        await User.updateOne({ _id: buyer._id }, { $set: { [field]: value } });
        await assert.rejects(createDispute(req(buyer), input(source)), error => error.code === 'ACCOUNT_UNAVAILABLE');
        await User.updateOne({ _id: buyer._id }, { $set: { [field]: restore } });
      }
      await User.updateOne({ _id: buyer._id }, { $inc: { 'security.tokenVersion': 1 } });
      await assert.rejects(createDispute(req(buyer), input(source)), error => error.code === 'ACCOUNT_UNAVAILABLE');
      buyer.security.tokenVersion += 1;
      const badCurrency = await order(buyer, 'UG', 'KES');
      await assert.rejects(createDispute(req(buyer), input(badCurrency)), error => error.code === 'CUSTOMER_SUPPORT_MARKET_UNAVAILABLE');
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
      await assert.rejects(createDispute(req(buyer), input(source)), error => error.code === 'CUSTOMER_SUPPORT_MARKET_UNAVAILABLE');
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } });
      assert.equal(await Dispute.countDocuments({ orderId: source._id }), 0);
    });
    await t.test('appeals require the exact current version and reopen only the owner’s terminal case', async () => {
      const { dispute } = await terminalDispute(), body = { version: dispute.__v, message: 'Please independently review the saved decision and this additional evidence.' };
      await assert.rejects(appealOwnedDispute(req(buyer), dispute.publicId, { message: body.message }), error => error.name === 'ZodError');
      await assert.rejects(appealOwnedDispute(req(other), dispute.publicId, body), error => error.code === 'DISPUTE_NOT_FOUND');
      await assert.rejects(appealOwnedDispute(req(buyer), dispute.publicId, { ...body, version: dispute.__v + 1 }), error => error.code === 'CUSTOMER_DISPUTE_VERSION_CONFLICT');
      const result = await appealOwnedDispute(req(buyer), dispute.publicId, body);
      assert.equal(result.status, 'appealed'); assert.equal(result.resolvedAt, null); assert.equal(result.version, dispute.__v + 1);
      assert.equal(result.resolution.summary, 'The original public decision remains available.');
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|assignedUserId|reviewedByUserId|resolvedByUserId/);
      const current = await Dispute.findById(dispute._id);
      assert.equal(current.assignedUserId, undefined); assert.equal(current.review?.reviewedAt, undefined); assert.equal(current.review.notes, '');
      assert.equal(current.escalation.referralTicketPublicId, ''); assert.equal(current.escalation.reason, ''); assert.equal(current.escalation.escalatedByUserId, undefined);
      await assert.rejects(appealOwnedDispute(req(buyer), dispute.publicId, { ...body, version: current.__v }), error => error.code === 'DISPUTE_STATE');
      assert.equal(await AuditLog.countDocuments({ action: 'customer.dispute_appealed', targetPublicId: dispute.publicId }), 1);
    });
    await t.test('an appeal cannot create a second active case for the same order category', async () => {
      const { source, dispute } = await terminalDispute(); await createDispute(req(buyer), input(source));
      await assert.rejects(appealOwnedDispute(req(buyer), dispute.publicId, { version: dispute.__v, message: 'Please reopen the earlier decision for this same saved order.' }), error => error.code === 'DISPUTE_ALREADY_OPEN');
      assert.equal((await Dispute.findById(dispute._id)).status, 'resolved');
    });
    await t.test('appeals retain prior reviewer evidence and require a different reviewer for the next decision', async () => {
      const { dispute } = await terminalDispute();
      const appealed = await appealOwnedDispute(req(buyer), dispute.publicId, { version: dispute.__v, message: 'Please independently review the saved outcome with this additional evidence.' });
      await assert.rejects(assignSupportDispute(req(support), dispute.publicId, { version: appealed.version }), error => error.code === 'DISPUTE_APPEAL_FOUR_EYES');
      const independent = await actor('support'), assigned = await assignSupportDispute(req(independent), dispute.publicId, { version: appealed.version });
      await assert.rejects(reviewSupportDispute(req(support), dispute.publicId, { version: assigned.version, notes: 'The prior reviewer attempts to record another private decision.', message: 'Prior reviewer attempts the appeal.' }), error => error.code === 'DISPUTE_APPEAL_FOUR_EYES');
      await assert.rejects(resolveSupportDispute(req(support), dispute.publicId, { version: assigned.version, decision: 'no_action', summary: 'Prior reviewer attempts to retain the original outcome.' }), error => error.code === 'DISPUTE_APPEAL_FOUR_EYES');
      const reviewed = await reviewSupportDispute(req(independent), dispute.publicId, { version: assigned.version, notes: 'Independent reviewer examined both the original record and new evidence.', message: 'Your appeal received an independent investigation.' });
      const resolved = await resolveSupportDispute(req(independent), dispute.publicId, { version: reviewed.version, decision: 'customer_service', summary: 'The independently reviewed outcome is recorded for the customer.' });
      assert.equal(resolved.status, 'resolved');
      assert.equal(String((await Dispute.findById(dispute._id)).resolution.resolvedByUserId), String(independent._id));
    });
    await t.test('failed audit rolls case creation and appeal, account/market/order fences and notifications back', async () => {
      const { source, dispute } = await terminalDispute(), untouched = await order(), beforeUser = await User.findById(buyer._id), beforeMarket = await CountrySetting.findOne({ code: 'UG' }),
        beforeOrder = await Order.findById(source._id), notifications = await Notification.countDocuments(), disputes = await Dispute.countDocuments();
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Customer authoritative audit unavailable'); });
      try {
        await assert.rejects(createDispute(req(buyer), input(untouched)), /Customer authoritative audit unavailable/);
        await assert.rejects(appealOwnedDispute(req(buyer), dispute.publicId, { version: dispute.__v, message: 'Request a new independent review of this saved decision.' }), /Customer authoritative audit unavailable/);
      } finally { t.mock.restoreAll(); }
      assert.equal(await Dispute.countDocuments(), disputes); assert.equal((await Dispute.findById(dispute._id)).status, 'resolved');
      assert.equal((await User.findById(buyer._id)).__v, beforeUser.__v); assert.equal((await CountrySetting.findOne({ code: 'UG' })).__v, beforeMarket.__v);
      assert.equal((await Order.findById(source._id)).__v, beforeOrder.__v); assert.equal(await Notification.countDocuments(), notifications);
    });
    await t.test('CSAT validates whole ratings, exact requester and terminal ticket without accepting forged joins', async () => {
      const resolved = await ticket(), active = await ticket({ status: 'open' });
      for (const rating of [0, 6, 1.5, 'bad']) await assert.rejects(submitSatisfaction(req(buyer), resolved.publicId, { rating }), error => error.name === 'ZodError');
      await assert.rejects(submitSatisfaction(req(other), resolved.publicId, { rating: 5 }), error => error.code === 'TICKET_NOT_FOUND');
      await assert.rejects(submitSatisfaction(req(buyer), active.publicId, { rating: 5 }), error => error.code === 'TICKET_NOT_FOUND');
      const rated = await submitSatisfaction(req(buyer), resolved.publicId, { rating: '5', comment: 'Saved rating.', userId: other._id, ticketPublicId: active.publicId, country: 'KE' });
      assert.equal(String(rated.userId), String(buyer._id)); assert.equal(String(rated.ticketId), String(resolved._id)); assert.equal(rated.ticketPublicId, resolved.publicId); assert.equal(rated.country, 'UG'); assert.equal(rated.rating, 5);
      const wrongSource = await ticket({ source: await order(other) });
      await assert.rejects(submitSatisfaction(req(buyer), wrongSource.publicId, { rating: 5 }), error => error.code === 'ORDER_NOT_FOUND');
      assert.equal(await SatisfactionSurvey.countDocuments({ ticketId: wrongSource._id }), 0);
    });
    await t.test('concurrent CSAT edits update one owner rating rather than inflating satisfaction counts', async () => {
      const resolved = await ticket(), attempts = await Promise.allSettled([3, 5].map(rating => submitSatisfaction(req(buyer), resolved.publicId, { rating, comment: 'One owner’s current rating.' })));
      assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 2); assert.equal(await SatisfactionSurvey.countDocuments({ ticketId: resolved._id, userId: buyer._id }), 1);
      assert.ok([3, 5].includes((await SatisfactionSurvey.findOne({ ticketId: resolved._id })).rating));
      assert.equal(await AuditLog.countDocuments({ action: 'customer.support_satisfaction_submitted', targetPublicId: resolved.publicId }), 2);
    });
    await t.test('forged saved survey references, reopened tickets and inactive markets cannot produce ratings', async () => {
      const resolved = await ticket(), survey = await SatisfactionSurvey.create({ publicId: id('sat'), ticketId: resolved._id, ticketPublicId: id('tkt'), country: 'KE', userId: buyer._id, rating: 1 });
      await assert.rejects(submitSatisfaction(req(buyer), resolved.publicId, { rating: 5 }), error => error.code === 'SATISFACTION_TICKET_MISMATCH');
      assert.equal((await SatisfactionSurvey.findById(survey._id)).rating, 1);
      const reopened = await ticket(); await SupportTicket.updateOne({ _id: reopened._id }, { $set: { status: 'open' } });
      await assert.rejects(submitSatisfaction(req(buyer), reopened.publicId, { rating: 5 }), error => error.code === 'TICKET_NOT_FOUND');
      const inactive = await ticket({ country: 'KE' }); await CountrySetting.updateOne({ code: 'KE' }, { $set: { active: false } });
      await assert.rejects(submitSatisfaction(req(buyer), inactive.publicId, { rating: 5 }), error => error.code === 'CUSTOMER_SUPPORT_MARKET_UNAVAILABLE');
      await CountrySetting.updateOne({ code: 'KE' }, { $set: { active: true } });
      assert.equal(await SatisfactionSurvey.countDocuments({ ticketId: mongoose.trusted({ $in: [reopened._id, inactive._id] }) }), 0);
    });
    await t.test('CSAT audit failure rolls ratings and conversation/account/country fences back', async () => {
      const resolved = await ticket(), beforeUser = await User.findById(buyer._id), beforeMarket = await CountrySetting.findOne({ code: 'UG' });
      t.mock.method(AuditLog, 'create', async () => { throw new Error('CSAT authoritative audit unavailable'); });
      try { await assert.rejects(submitSatisfaction(req(buyer), resolved.publicId, { rating: 5 }), /CSAT authoritative audit unavailable/); }
      finally { t.mock.restoreAll(); }
      assert.equal(await SatisfactionSurvey.countDocuments({ ticketId: resolved._id }), 0); assert.equal((await SupportTicket.findById(resolved._id)).__v, resolved.__v);
      assert.equal((await User.findById(buyer._id)).__v, beforeUser.__v); assert.equal((await CountrySetting.findOne({ code: 'UG' })).__v, beforeMarket.__v);
    });
    await t.test('Customer dashboard data excludes internal conversations and keeps the rendered action version', async () => {
      const owned = await ticket(), { dispute } = await terminalDispute();
      const supportPage = await loadCustomerDashboardPage(req(buyer), 'support'), returnsPage = await loadCustomerDashboardPage(req(buyer), 'returns');
      const projected = supportPage.tickets.find(row => row.publicId === owned.publicId);
      assert.equal(projected.version, owned.__v); assert.equal(projected.notes[0].author, 'You'); assert.equal(projected.notes.length, 1);
      assert.doesNotMatch(JSON.stringify(supportPage), /PRIVATE_INTERNAL_TICKET/);
      assert.ok(returnsPage.disputes.some(row => row.publicId === dispute.publicId)); assert.doesNotMatch(JSON.stringify(returnsPage.disputes), /PRIVATE_CUSTOMER_REVIEW|PRIVATE_FINANCE_REFERRAL/);
    });
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
