import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.AI_ENABLED = 'false';
for (const key of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) {
  process.env[key] = crypto.randomBytes(32).toString('hex');
}
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => {
  const match = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(match, 'The actual authenticated page supplies CSRF.');
  return match[1];
};
const denied = error => [403, 404, 409].includes(error.status);

test('Country Admin Support uses genuine country grants, browser sessions and saved requester conversations',
  { skip: !uri, timeout: 240_000 }, async t => {
    const parsed = new URL(uri);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.port, '27019');
    assert.match(parsed.pathname, /verification|test/i);
    await mongoose.connect(uri, { dbName: `classicmart_country_support_test_${suffix}` });
    const transports = [];
    try {
      const { createApp } = await import('../src/app.js');
      const { User, PlatformGrant, CountrySetting, Device, SupportTicket, Order, AuditLog, Notification, OutboxEvent } = await import('../src/models/index.js');
      const { hashPassword, hashToken } = await import('../src/core/crypto.js');
      const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
      const support = await import('../src/services/country-admin-support-pages.js');
      const { supportTicketCustomerDto, prepareSupportTicketDelivery, customerReplySupportTicket, mutateSupportTicket } = await import('../src/services/support-ticket-pages.js');
      await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
      await CountrySetting.create([
        { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
        { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
        { code: 'TZ', name: 'Unassigned shopping market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', active: true },
      ]);
      const app = createApp(null), password = `Country-Support-${suffix}-A1!`, passwordHash = await hashPassword(password);
      let sequence = 0, actorSequence = 0;
      const id = kind => `${kind}_csupport_${suffix}_${++sequence}`;
      async function actor({ role = 'customer', grantRole = null, countries = ['UG'], country = 'UG', shoppingCountry = 'TZ', mfa = Boolean(grantRole) } = {}) {
        const index = ++actorSequence, email = `country-support-${suffix}-${index}@example.com`;
        const phone = '+25670' + String(index).padStart(7, '0');
        let user = await User.create({ publicId: id('usr'), name: `Country Support ${index}`, email, emailNormalized: email,
          phone, phoneNormalized: phone, passwordHash, role, country, shoppingCountry, operationalCountries: ['TZ'],
          platformAccessManagedAt: grantRole ? new Date() : undefined,
          emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
          consents: { terms: true, privacy: true, recordedAt: new Date() } });
        const grant = grantRole ? await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role: grantRole,
          operationalCountries: countries, status: 'active', startsAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 86_400_000), reason: 'Isolated Country Admin Support verification.',
          approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() }) : null;
        let secret;
        if (mfa) {
          secret = (await beginMfaEnrollment(user._id, password)).secret;
          await confirmMfaEnrollment(user._id, totpCode(secret, { time: Date.now() - 30_000 }));
          const enrolled = await User.findById(user._id).select('+security.mfaSecretEncrypted');
          assert.ok(enrolled.security.mfaEnabled);
          assert.match(enrolled.security.mfaSecretEncrypted, /^v1:/);
        }
        const transport = new http.Agent({ localAddress: `127.0.0.${index + 60}`, keepAlive: false });
        transports.push(transport);
        const agent = request.agent(app).use(req => req.agent(transport));
        const page = await agent.get('/login').expect(200);
        let signedIn = await agent.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302);
        if (mfa) {
          assert.equal(signedIn.headers.location, '/mfa');
          const challenge = await agent.get('/mfa').expect(200);
          signedIn = await agent.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
        }
        const cookie = (signedIn.headers['set-cookie'] || []).find(value => value.startsWith('cm.sid='));
        assert.ok(cookie, 'Real login creates the authenticated browser session.');
        const signedCookie = decodeURIComponent(cookie.split(';')[0].slice('cm.sid='.length));
        const sessionID = signedCookie.slice(2, signedCookie.lastIndexOf('.'));
        const device = await Device.findOne({ userId: user._id, revokedAt: null }).select('+sessionHash');
        assert.ok(device);
        assert.equal(device.sessionHash, hashToken(sessionID));
        user = await User.findById(user._id);
        return { user, grant, agent, sessionID, device, tokenVersion: user.security.tokenVersion };
      }
      async function core(entry, { publicId, body = {}, query = {} } = {}) {
        const user = await User.findById(entry.user._id);
        return { id: id('req'), user, sessionID: entry.sessionID, device: entry.device,
          session: { userId: String(user._id), tokenVersion: entry.tokenVersion }, query,
          params: publicId ? { publicId } : {}, body, ip: '127.0.0.61', get: () => 'CountrySupportLive/1.0' };
      }
      async function fixture({ owner, country = 'UG', status = 'open', priority = 'normal', queue = 'orders',
        subject = 'Saved delivery question', order = null, overdue = false, createdAt = new Date(Date.now() - 3_600_000) } = {}) {
        return SupportTicket.create({ publicId: id('tkt'), userId: owner?.user?._id, country, category: 'order', subject,
          status, priority, queue, source: 'customer', orderId: order?._id, orderPublicId: order?.publicId,
          slaDueAt: new Date(Date.now() + (overdue ? -1 : 1) * 3_600_000), createdAt,
          notes: [{ message: 'Please review this actual saved delivery question.', actorUserId: owner?.user?._id, internal: false, at: createdAt }] });
      }
      async function orderFixture(owner, country = 'UG') {
        const currency = country === 'KE' ? 'KES' : 'UGX';
        return Order.create({ publicId: id('ord'), idempotencyKey: id('checkout'), checkoutId: id('checkout'),
          cartPublicId: id('crt'), sessionKey: id('session'), userId: owner.user._id, country,
          status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', deliveryMethod: 'standard', paymentMethod: 'cod',
          contact: { fullName: 'SUPPORT_ORDER_CONTACT_PRIVATE', email: 'support-order-private@example.com', phone: '+256700123456',
            address: 'SUPPORT_ORDER_ADDRESS_PRIVATE', city: 'Kampala', country },
          totals: { subtotalMinor: 10_000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10_000, currency },
          items: [{ linePublicId: id('oli'), productId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(),
            storeId: new mongoose.Types.ObjectId(), reservationPublicId: id('rsv'), productPublicId: id('prd'), variantPublicId: id('var'),
            storePublicId: id('str'), title: 'Persisted order item', variantTitle: 'Standard', sku: id('sku'),
            quantity: 1, deliveredQuantity: 1, unitPriceMinor: 10_000, lineTotalMinor: 10_000, currency }],
          reservationExpiresAt: new Date(Date.now() + 86_400_000) });
      }
      const latest = row => SupportTicket.findOne({ publicId: row.publicId || row });
      async function act(entry, row, action, body = {}) {
        const current = await latest(row);
        return support.countryAdminSupportAction(await core(entry, { publicId: current.publicId, body: { version: current.__v, ...body } }), action);
      }
      async function revisions(entry) {
        const [user, device, grant, market] = await Promise.all([
          User.findById(entry.user._id).lean(), Device.findById(entry.device._id).lean(),
          PlatformGrant.findById(entry.grant._id).lean(), CountrySetting.findOne({ code: 'UG' }).lean(),
        ]);
        return { user: user.__v, device: device.__v, grant: grant.__v, market: market.__v };
      }
      const admin = await actor({ grantRole: 'country_admin' });
      const contender = await actor({ grantRole: 'country_admin' });
      const foreignAdmin = await actor({ grantRole: 'country_admin', countries: ['KE'] });
      const multiAdmin = await actor({ grantRole: 'country_admin', countries: ['UG', 'KE'] });
      const superAdmin = await actor({ grantRole: 'super_admin', countries: ['*'] });
      const supportOperator = await actor({ grantRole: 'support' });
      const foreignSupport = await actor({ grantRole: 'support', countries: ['KE'] });
      const revokedSupport = await actor({ grantRole: 'support' });
      const buyer = await actor({ country: 'KE' }), otherBuyer = await actor();
      assert.equal(admin.user.role, 'customer');
      assert.equal(supportOperator.user.role, 'customer');
      assert.equal(admin.user.shoppingCountry, 'TZ');
      const order = await orderFixture(buyer), foreignOrder = await orderFixture(buyer, 'KE');
      const ticket = await fixture({ owner: buyer, order });
      const foreign = await fixture({ owner: buyer, country: 'KE', order: foreignOrder, subject: 'FOREIGN_KE_SUPPORT_ONLY' });
      await fixture({ owner: buyer, status: 'waiting_customer' });
      await fixture({ owner: buyer, status: 'escalated' });
      await fixture({ owner: buyer, status: 'closed' });
      await fixture({ owner: buyer, overdue: true });
      const tiedAt = new Date(Date.now() - 7_200_000);
      await SupportTicket.insertMany(Array.from({ length: 31 }, (_, index) => ({
        publicId: id('tkt'), userId: buyer.user._id, country: 'UG', category: 'order', source: 'customer',
        subject: index === 0 ? '=HYPERLINK("https://example.invalid","saved ticket")' : `Bulk saved support ${index}`,
        status: 'open', priority: 'normal', queue: 'orders', slaDueAt: new Date(Date.now() + 3_600_000), createdAt: tiedAt,
        notes: [{ message: 'Saved requester message for tied-date pagination.', actorUserId: buyer.user._id, internal: false, at: tiedAt }],
      })));

      await t.test('canonical Admin page and safe detail use ticket country instead of shopping country and block other workspaces', async () => {
        const before = (await latest(ticket)).toObject();
        const html = await admin.agent.get('/admin/support?record=' + ticket.publicId).expect(200);
        assert.match(html.text, /data-dashboard-workspace="admin"/);
        assert.match(html.text, /data-dashboard-page="admin-support"/);
        assert.match(html.headers['cache-control'], /no-store/);
        assert.match(html.headers['x-robots-tag'], /noindex/);
        assert.match(html.text, /Claim ticket|Claim Ticket/);
        assert.ok(html.text.includes('/admin/orders?country=UG&amp;record=' + encodeURIComponent(order.publicId)), 'The original order opens the canonical connected Admin order detail.');
        assert.doesNotMatch(html.text, /Development preview|id="roleSwitcher"/);
        const detail = await admin.agent.get('/admin/support/' + ticket.publicId).set('accept', 'application/json').expect(200);
        assert.equal(detail.body.pageId, 'admin-support');
        assert.equal(detail.body.kind, 'support');
        assert.equal(detail.body.context.country, 'UG');
        assert.equal(detail.body.selected.publicId, ticket.publicId);
        assert.equal(detail.body.selected.country, 'UG');
        assert.equal(detail.body.selected.requester.name, buyer.user.name);
        assert.equal(detail.body.selected.requester.publicId, buyer.user.publicId);
        assert.match(detail.body.selected.requester.emailMasked, /\*\*\*/);
        assert.equal(detail.body.selected.order.publicId, order.publicId);
        assert.equal(detail.body.selected.owner, null);
        assert.equal(detail.body.selected.ownedByActor, false);
        assert.equal(detail.body.selected.canClaim, true);
        assert.ok('assignment' in detail.body.selected);
        assert.deepEqual((await latest(ticket)).toObject(), before, 'Read requests do not change the original conversation.');
        const serialized = JSON.stringify(detail.body);
        for (const forbidden of ['passwordHash', 'security', 'sessionHash', 'tokenVersion', 'requesterEmailEncrypted', 'actorUserId',
          'assignedUserId', 'SUPPORT_ORDER_CONTACT_PRIVATE', 'SUPPORT_ORDER_ADDRESS_PRIVATE', buyer.user.email, buyer.user.phone,
          String(buyer.user._id), String(admin.user._id), String(order._id), foreign.publicId]) {
          assert.ok(!serialized.includes(forbidden), forbidden);
        }
        for (const entry of [superAdmin, supportOperator, buyer]) {
          await entry.agent.get('/admin/support').set('accept', 'application/json').expect(403);
          await assert.rejects(support.loadCountryAdminSupportPage(await core(entry)), error => error.status === 403);
        }
        await admin.agent.get('/admin/support/' + foreign.publicId).set('accept', 'application/json').expect(404);
        await foreignAdmin.agent.get('/admin/support/' + ticket.publicId).set('accept', 'application/json').expect(404);
        await admin.agent.get('/admin/support?country=TZ').set('accept', 'application/json').expect(403);
        await admin.agent.get('/admin/support?country=KE').set('accept', 'application/json').expect(403);
      });

      await t.test('complete metrics and tied-date keyset pages exceed 25 records without duplicate or foreign entries', async () => {
        const first = await admin.agent.get('/admin/support').set('accept', 'application/json').expect(200);
        assert.equal(first.body.page.total, 36);
        assert.equal(first.body.items.length, 25);
        assert.deepEqual(first.body.metrics.map(row => row.label), ['Open tickets', 'Waiting for requester', 'Escalations', 'Overdue tickets']);
        assert.deepEqual(first.body.metrics.map(row => Number(row.value)), [35, 1, 1, 1]);
        assert.equal(first.body.page.hasMore, true);
        assert.ok(first.body.pagination.nextHref.startsWith('/admin/support?'));
        const next = await admin.agent.get(first.body.pagination.nextHref).set('accept', 'application/json').expect(200);
        assert.equal(next.body.page.total, 36);
        assert.equal(next.body.items.length, 11);
        assert.equal(next.body.page.hasMore, false);
        const seen = [...first.body.items, ...next.body.items].map(row => row.publicId);
        assert.equal(new Set(seen).size, 36);
        assert.ok(!seen.includes(foreign.publicId));
        const all = await multiAdmin.agent.get('/admin/support?country=').set('accept', 'application/json').expect(200);
        assert.equal(all.body.page.total, 37);
        assert.equal(all.body.context.currency, null);
        const waiting = await admin.agent.get('/admin/support?status=waiting_customer&queue=orders&priority=normal&assignment=unassigned')
          .set('accept', 'application/json').expect(200);
        assert.equal(waiting.body.page.total, 1);
        const overdue = await admin.agent.get('/admin/support?overdue=1').set('accept', 'application/json').expect(200);
        assert.equal(overdue.body.page.total, 1);
        const search = await admin.agent.get('/admin/support?search=Bulk%20saved%20support').set('accept', 'application/json').expect(200);
        assert.equal(search.body.page.total, 30);
        for (const query of ['country=UG&country=KE', 'status=open&status=closed', 'status[]=open', 'queue=invalid',
          'priority=invalid', 'assignment=other', 'overdue=true', 'after=broken', 'record[]=ticket']) {
          await admin.agent.get('/admin/support?' + query).set('accept', 'application/json').expect(422);
        }
        await admin.agent.get('/admin/support?record=' + foreign.publicId).set('accept', 'application/json').expect(404);
      });

      await t.test('CSRF and explicit versions protect ownership; genuine racing claims commit one assignment', async () => {
        const page = await admin.agent.get('/admin/support/' + ticket.publicId).expect(200);
        await admin.agent.post('/admin/support/' + ticket.publicId + '/action').type('form')
          .send({ action: 'claim', version: ticket.__v }).expect(403);
        await admin.agent.post('/admin/support/' + ticket.publicId + '/action').set('accept', 'application/json').type('form')
          .send({ _csrf: csrf(page.text), action: 'claim', version: 999 }).expect(409);
        await admin.agent.post('/admin/support/' + ticket.publicId + '/action').set('accept', 'application/json').type('form')
          .send({ _csrf: csrf(page.text), action: 'claim' }).expect(422);
        const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) => core(index % 2 ? admin : contender,
          { publicId: ticket.publicId, body: { version: ticket.__v } })));
        const outcomes = await Promise.allSettled(attempts.map(req => support.countryAdminSupportAction(req, 'claim')));
        assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
        assert.equal(outcomes.filter(row => row.status === 'rejected').length, 5);
        const claimed = await latest(ticket);
        assert.equal(claimed.status, 'in_progress');
        assert.equal(claimed.assignmentHistory.filter(row => row.action === 'claim').length, 1);
        assert.equal(await AuditLog.countDocuments({ targetPublicId: ticket.publicId }), 1);
        const winner = String(claimed.assignedUserId) === String(admin.user._id) ? admin : contender;
        const loser = winner === admin ? contender : admin;
        await assert.rejects(support.countryAdminSupportAction(await core(winner, { publicId: claimed.publicId,
          body: { version: ticket.__v } }), 'release'), error => error.status === 409);
        await assert.rejects(act(loser, claimed, 'reply', { message: 'Unowned reply must fail.' }), error => error.status === 409);
        await assert.rejects(act(loser, claimed, 'release'), error => error.status === 409);
        await act(winner, claimed, 'release');
        assert.equal(String((await latest(ticket)).assignedUserId || ''), '');
        await act(admin, claimed, 'claim');
        const mine = await admin.agent.get('/admin/support?assignment=mine&record=' + ticket.publicId).set('accept', 'application/json').expect(200);
        assert.equal(mine.body.page.total, 1);
        assert.equal(mine.body.selected.owner.publicId, admin.user.publicId);
        assert.equal(mine.body.selected.ownedByActor, true);
        assert.equal(mine.body.selected.canClaim, false);
      });

      await t.test('internal notes stay private while public replies persist a real requester notification and safe delivery event', async () => {
        const beforeEvents = await OutboxEvent.countDocuments({ aggregatePublicId: ticket.publicId });
        const beforeNotices = await Notification.countDocuments({ userId: buyer.user._id });
        await act(admin, ticket, 'reply', { message: 'COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE', internal: true });
        const internal = await latest(ticket);
        assert.equal(internal.notes.at(-1).internal, true);
        assert.equal(await OutboxEvent.countDocuments({ aggregatePublicId: ticket.publicId }), beforeEvents);
        assert.equal(await Notification.countDocuments({ userId: buyer.user._id }), beforeNotices);
        assert.ok(!JSON.stringify(supportTicketCustomerDto(internal)).includes('COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE'));
        const visibleMessage = 'Your saved delivery question is under review. Please confirm the delivery detail.';
        const page = await admin.agent.get('/admin/support/' + ticket.publicId).expect(200);
        await admin.agent.post('/admin/support/' + ticket.publicId + '/action').set('accept', 'application/json').type('form')
          .send({ _csrf: csrf(page.text), action: 'reply', version: internal.__v, message: visibleMessage, internal: 'false', status: 'waiting_customer' })
          .expect(200);
        const visible = await latest(ticket);
        assert.equal(visible.status, 'waiting_customer');
        assert.equal(visible.notes.at(-1).message, visibleMessage);
        assert.equal(visible.notes.at(-1).internal, false);
        assert.equal(await OutboxEvent.countDocuments({ aggregatePublicId: ticket.publicId, type: 'support.ticket_reply' }), beforeEvents + 1);
        assert.equal(await Notification.countDocuments({ userId: buyer.user._id, type: 'support_reply' }), beforeNotices + 1);
        const event = await OutboxEvent.findOne({ aggregatePublicId: ticket.publicId, type: 'support.ticket_reply' });
        const eventJson = JSON.stringify(event.toObject());
        assert.ok(!eventJson.includes(visibleMessage));
        assert.ok(!eventJson.includes(buyer.user.email));
        assert.ok(!eventJson.includes('COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE'));
        const delivery = await prepareSupportTicketDelivery(event);
        assert.ok(delivery, 'The existing delivery authorization accepts the genuine current Country Admin sender.');
        assert.equal(delivery.email, buyer.user.email);
        assert.ok(delivery.text.includes(visibleMessage));
        assert.ok(!delivery.text.includes('COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE'));
        const customer = supportTicketCustomerDto(visible);
        assert.equal(customer.notes.at(-1).message, visibleMessage);
        for (const field of ['history', 'assignmentHistory', 'assignedUserId', 'requesterEmailEncrypted', 'owner']) assert.ok(!(field in customer));
        await assert.rejects(customerReplySupportTicket(await core(otherBuyer), ticket.publicId,
          { version: visible.__v, message: 'Another customer cannot replace the original requester.' }), error => error.status === 404);
        const buyerPage = await buyer.agent.get('/support').expect(200);
        assert.ok(buyerPage.text.includes(visibleMessage), 'The existing connected Customer support page displays the saved public reply.');
        assert.ok(!buyerPage.text.includes('COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE'));
        const response = await buyer.agent.post('/api/v1/support/tickets/' + ticket.publicId + '/reply').set('x-csrf-token', csrf(buyerPage.text))
          .send({ version: visible.__v, message: 'The saved requester confirms the missing delivery detail.', internal: true }).expect(200);
        assert.equal(response.body.ticket.status, 'in_progress');
        assert.equal(response.body.ticket.notes.at(-1).internal, false);
        assert.ok(!JSON.stringify(response.body).includes('COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE'));
        const detail = await support.loadCountryAdminSupportPage(await core(admin, { query: { record: ticket.publicId } }));
        assert.ok(detail.selected.notes.some(note => note.message === 'COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE' && note.internal === true));
        assert.ok(detail.selected.notes.some(note => note.message === 'The saved requester confirms the missing delivery detail.' && note.internal === false));
        assert.ok(detail.selected.history.length >= 3);
      });

      await t.test('priority, queue, escalation, resolution and reopening preserve the original requester and order', async () => {
        const work = await fixture({ owner: buyer, order });
        await act(admin, work, 'claim');
        await act(admin, work, 'update', { priority: 'urgent', queue: 'payments', country: 'KE',
          userId: String(otherBuyer.user._id), assignedUserId: String(contender.user._id), orderPublicId: foreignOrder.publicId, status: 'closed' });
        const updated = await latest(work);
        assert.equal(updated.priority, 'urgent');
        assert.equal(updated.queue, 'payments');
        assert.equal(updated.slaDueAt.getTime(), updated.createdAt.getTime() + 4 * 3_600_000);
        assert.equal(updated.country, 'UG');
        assert.equal(updated.orderPublicId, order.publicId);
        assert.equal(String(updated.userId), String(buyer.user._id));
        assert.equal(String(updated.assignedUserId), String(admin.user._id));
        assert.equal(updated.status, 'in_progress');
        await act(admin, work, 'status', { status: 'escalated', message: 'The saved payment question needs specialist review.' });
        assert.equal((await latest(work)).status, 'escalated');
        await assert.rejects(act(admin, work, 'resolve'), error => error.status === 422);
        await act(admin, work, 'resolve', { message: 'The recorded delivery issue has been reviewed and resolved.' });
        const resolved = await latest(work);
        assert.equal(resolved.status, 'resolved');
        assert.ok(resolved.resolvedAt);
        await assert.rejects(act(admin, work, 'reply', { message: 'A resolved conversation needs reopening first.' }), error => error.status === 409);
        await assert.rejects(act(contender, work, 'reopen', { message: 'A non-owner cannot reopen the staff workflow.' }), error => error.status === 409);
        await act(admin, work, 'reopen', { message: 'The original saved requester question needs one more review.' });
        const reopened = await latest(work);
        assert.equal(reopened.status, 'open');
        assert.equal(reopened.resolvedAt, undefined);
        assert.ok(reopened.reopenedAt);
        assert.equal(reopened.orderPublicId, order.publicId);
        assert.ok(reopened.workflowHistory.some(row => row.action === 'reopened'));
        await act(admin, work, 'release');
        assert.equal(String((await latest(work)).assignedUserId || ''), '');
      });

      await t.test('transfer accepts a managed stored-customer Support operator and rejects revoked, foreign or unqualified recipients', async () => {
        const transfer = await fixture({ owner: buyer });
        await act(admin, transfer, 'claim');
        await PlatformGrant.updateOne({ _id: revokedSupport.grant._id }, { $set: { status: 'revoked' }, $inc: { __v: 1 } });
        for (const recipient of [foreignSupport, revokedSupport, buyer]) {
          const before = (await latest(transfer)).toObject();
          await assert.rejects(act(admin, transfer, 'transfer', { recipient: recipient.user.publicId }), denied);
          assert.deepEqual((await latest(transfer)).toObject(), before);
        }
        await act(admin, transfer, 'transfer', { recipient: supportOperator.user.publicId });
        const assigned = await latest(transfer);
        assert.equal(String(assigned.assignedUserId), String(supportOperator.user._id));
        assert.equal((await User.findById(supportOperator.user._id)).role, 'customer');
        assert.equal(assigned.assignmentHistory.at(-1).action, 'transfer');
        assert.ok(await Notification.exists({ userId: supportOperator.user._id, type: 'support_assignment', country: 'UG' }));
        const supportPage = await supportOperator.agent.get('/support/queue?record=' + transfer.publicId).set('accept', 'application/json').expect(200);
        assert.equal(supportPage.body.selected.ownedByActor, true);
        await assert.rejects(act(admin, transfer, 'reply', { message: 'The former owner cannot reply after transfer.' }), error => error.status === 409);
        const actualSupport = await mutateSupportTicket(await core(supportOperator), transfer.publicId,
          { version: assigned.__v, action: 'reply', message: 'The assigned Support operator has reviewed this saved case.', internal: true });
        assert.equal(actualSupport.notes.at(-1).internal, true);
        assert.equal(actualSupport.ownedByActor, true);
      });

      await t.test('malformed original order links, foreign order tampering and self-requester conflicts deny changes atomically', async () => {
        const missing = await fixture({ owner: buyer });
        await SupportTicket.updateOne({ _id: missing._id }, { $set: { orderPublicId: id('ord_missing') } });
        const tampered = await fixture({ owner: buyer, order: foreignOrder });
        const wrongRequesterOrder = await orderFixture(otherBuyer);
        const wrongRequester = await fixture({ owner: buyer, order: wrongRequesterOrder });
        const self = await fixture({ owner: admin });
        for (const row of [missing, tampered, wrongRequester, self]) {
          const before = (await latest(row)).toObject(), sourceRevisions = await revisions(admin);
          const audits = await AuditLog.countDocuments({ targetPublicId: row.publicId });
          const events = await OutboxEvent.countDocuments({ aggregatePublicId: row.publicId });
          await assert.rejects(act(admin, row, 'claim'), denied);
          assert.deepEqual((await latest(row)).toObject(), before);
          assert.deepEqual(await revisions(admin), sourceRevisions);
          assert.equal(await AuditLog.countDocuments({ targetPublicId: row.publicId }), audits);
          assert.equal(await OutboxEvent.countDocuments({ aggregatePublicId: row.publicId }), events);
        }
      });

      await t.test('required audit failure rolls back the public reply, ownership sources, outbox and requester notification', async () => {
        const work = await fixture({ owner: buyer, order });
        await act(admin, work, 'claim');
        const before = (await latest(work)).toObject(), beforeRevisions = await revisions(admin);
        const orderBefore = (await Order.findById(order._id)).toObject();
        const auditCount = await AuditLog.countDocuments({ targetPublicId: work.publicId });
        const eventCount = await OutboxEvent.countDocuments({ aggregatePublicId: work.publicId });
        const noticeCount = await Notification.countDocuments({ userId: buyer.user._id });
        const originalCreate = AuditLog.create;
        AuditLog.create = async () => { throw new Error('Country Admin Support audit unavailable'); };
        try {
          await assert.rejects(act(admin, work, 'reply', { message: 'A reply without its required audit must never persist.',
            internal: false, status: 'waiting_customer' }), /Country Admin Support audit unavailable/);
        } finally {
          AuditLog.create = originalCreate;
        }
        assert.deepEqual((await latest(work)).toObject(), before);
        assert.deepEqual(await revisions(admin), beforeRevisions);
        assert.deepEqual((await Order.findById(order._id)).toObject(), orderBefore);
        assert.equal(await AuditLog.countDocuments({ targetPublicId: work.publicId }), auditCount);
        assert.equal(await OutboxEvent.countDocuments({ aggregatePublicId: work.publicId }), eventCount);
        assert.equal(await Notification.countDocuments({ userId: buyer.user._id }), noticeCount);
      });

      await t.test('current grants, real devices, token versions, MFA and source country configuration reject stale access', async () => {
        for (const boundary of ['grant', 'device', 'token', 'mfa', 'scope']) {
          const entry = await actor({ grantRole: 'country_admin' });
          const work = await fixture({ owner: buyer }), before = (await latest(work)).toObject();
          const req = await core(entry, { publicId: work.publicId, body: { version: work.__v }, query: { record: work.publicId } });
          if (boundary === 'grant') await PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { status: 'revoked' }, $inc: { __v: 1 } });
          if (boundary === 'device') await Device.updateOne({ _id: entry.device._id }, { $set: { revokedAt: new Date() }, $inc: { __v: 1 } });
          if (boundary === 'token') await User.updateOne({ _id: entry.user._id }, { $inc: { 'security.tokenVersion': 1, __v: 1 } });
          if (boundary === 'mfa') await User.updateOne({ _id: entry.user._id }, { $set: { 'security.mfaEnabled': false }, $inc: { __v: 1 } });
          if (boundary === 'scope') await PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { operationalCountries: ['KE'] }, $inc: { __v: 1 } });
          await assert.rejects(support.loadCountryAdminSupportPage(req), denied);
          await assert.rejects(support.countryAdminSupportAction(req, 'claim'), denied);
          assert.deepEqual((await latest(work)).toObject(), before, boundary);
        }
        const work = await fixture({ owner: buyer }), before = (await latest(work)).toObject();
        const req = await core(multiAdmin, { publicId: work.publicId, body: { version: work.__v }, query: { country: 'UG', record: work.publicId } });
        await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false }, $inc: { __v: 1 } });
        try {
          await assert.rejects(support.loadCountryAdminSupportPage(req), denied);
          await assert.rejects(support.countryAdminSupportAction(req, 'claim'), denied);
          assert.deepEqual((await latest(work)).toObject(), before);
        } finally {
          await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true }, $inc: { __v: 1 } });
        }
      });

      await t.test('CSV neutralizes formulas, excludes foreign and private fields and stops when its current grant is revoked', async () => {
        class Response extends EventEmitter {
          constructor() { super(); this.data = ''; this.destroyed = false; this.writableEnded = false; this.headers = {}; }
          type(value) { this.headers.type = value; return this; }
          set(key, value) { if (typeof key === 'object') Object.assign(this.headers, key); else this.headers[key] = value; return this; }
          write(value) { this.data += value; return true; }
          end() { this.writableEnded = true; }
        }
        const exported = await admin.agent.get('/admin/support/export.csv').expect(200);
        assert.match(exported.headers['content-type'], /text\/csv/);
        assert.match(exported.headers['cache-control'], /no-store/);
        assert.ok(exported.text.includes("'=HYPERLINK("));
        assert.ok(exported.text.includes('""https://example.invalid""'));
        for (const forbidden of [foreign.publicId, 'FOREIGN_KE_SUPPORT_ONLY', 'COUNTRY_ADMIN_INTERNAL_NOTE_PRIVATE',
          buyer.user.email, buyer.user.phone, 'SUPPORT_ORDER_CONTACT_PRIVATE', 'SUPPORT_ORDER_ADDRESS_PRIVATE',
          'requesterEmailEncrypted', 'sessionHash', String(buyer.user._id)]) assert.ok(!exported.text.includes(forbidden), forbidden);
        const filtered = new Response();
        await support.streamCountryAdminSupportCsv(await core(admin, { query: { search: 'Bulk saved support' } }), filtered);
        assert.equal(filtered.writableEnded, true);
        assert.ok(filtered.data.includes('Bulk saved support'));
        assert.ok(!filtered.data.includes(ticket.publicId));
        const multiCountry = await actor({ grantRole: 'country_admin', countries: ['UG', 'KE'] }), allCountries = new Response();
        await support.streamCountryAdminSupportCsv(await core(multiCountry, { query: { country: '' } }), allCountries);
        const exportAudits = await AuditLog.find({ actorId: multiCountry.user._id, action: 'country_admin.support_exported' }).lean();
        assert.deepEqual(exportAudits.map(row => row.country).sort(), ['KE', 'UG'], 'An all-market export records audit evidence in every actual authorized market.');
        assert.ok(allCountries.data.includes(foreign.publicId));
        const exportAdmin = await actor({ grantRole: 'country_admin' }), stopped = new Response();
        let writes = 0;
        stopped.write = function (value) {
          this.data += value;
          if (++writes === 2) {
            PlatformGrant.updateOne({ _id: exportAdmin.grant._id }, { $set: { status: 'revoked' }, $inc: { __v: 1 } })
              .then(() => this.emit('drain'), error => this.emit('error', error));
            return false;
          }
          return true;
        };
        await assert.rejects(support.streamCountryAdminSupportCsv(await core(exportAdmin), stopped), error => error.status === 403);
        assert.equal(writes, 2);
        assert.equal(stopped.writableEnded, false);
        assert.ok(!stopped.data.includes(foreign.publicId));
      });
    } finally {
      for (const transport of transports) transport.destroy();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });
