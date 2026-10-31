import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'The real page must provide a CSRF token.');
  return token[1];
};

test('all nine Support destinations use current grants, real MFA and the approved responsive workspace', { skip: !uri, timeout: 300_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_support_navigation_test_${suffix}` });
  let server, browser;
  try {
    const { createApp } = await import('../src/app.js');
    const { User, Store, CountrySetting, PlatformGrant, Category, Product, ProductVariant, Order, PaymentIntent, SupportTicket, Dispute, ReturnRequest, Review, Device, LedgerAccount, LoyaltyAccount } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { SUPPORT_LIVE_ROUTES } = await import('../src/dashboard/support-routes.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
      { code: 'TZ', name: 'Unassigned Support navigation market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', active: true },
    ]);
    const password = `Support-Navigation-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    let sequence = 0;
    async function actor(role, { managed = false, enroll = false, countries = ['UG', 'KE'], country = 'UG', name } = {}) {
      const index = ++sequence, email = `support-navigation-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_snav_${suffix}_${index}`, name: name || `Navigation Support Actor ${index}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, country, currency: 'TZS', shoppingCountry: 'TZ', operationalCountries: countries,
        platformAccessManagedAt: managed ? new Date() : undefined, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_snav_${suffix}_${index}`, userId: user._id, role: 'support', operationalCountries: countries,
        status: 'active', startsAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 86400000), reason: 'Isolated Support workspace navigation verification.',
        approvalPublicId: `apr_snav_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let secret, codes;
      if (enroll) {
        const enrollment = await beginMfaEnrollment(user._id, password); secret = enrollment.secret;
        // Enrollment accepts the immediately previous authenticator window. The real
        // login below consumes the current code, exercising replay protection without sleeps.
        const confirmed = await confirmMfaEnrollment(user._id, totpCode(secret, { time: Date.now() - 30000 })); codes = confirmed.codes;
      }
      return { user, grant, secret, codes };
    }
    function agent() {
      const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 110}`, keepAlive: false }); transports.push(transport);
      return request.agent(app).use(req => req.agent(transport));
    }
    async function login(entry, { challenge = true } = {}) {
      const client = agent(), form = await client.get('/login').expect(200);
      const response = await client.post('/login').type('form').send({ email: entry.user.email, password, _csrf: csrf(form.text) }).expect(302);
      if (challenge) {
        assert.equal(response.headers.location, '/mfa');
        const challengePage = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(entry.secret), _csrf: csrf(challengePage.text) }).expect(302);
      }
      return { client, response };
    }
    const owner = await actor('customer', { managed: true });
    const initial = await login(owner, { challenge: false }), client = initial.client;
    assert.equal(initial.response.headers.location, '/support/overview', 'The active Support grant controls landing despite a customer compatibility mirror.');
    const securityPath = '/account/security?next=%2Fsupport%2Foverview';

    await t.test('real enrollment preserves Support continuation, recovery codes and the current grant', async () => {
      await client.get('/support/overview').expect(302).expect('location', securityPath);
      await client.get('/support/overview').set('Accept', 'application/json').expect(403);
      let page = await client.get(securityPath).expect(200);
      assert.match(page.text, /data-dashboard-workspace="support"/);
      assert.match(page.text, /name="next" value="\/support\/overview"/);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: '/support/overview' }).expect(403);
      assert.equal(await pendingMfaEnrollment(owner.user._id), null);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: '/support/overview', _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      const enrollment = await pendingMfaEnrollment(owner.user._id); owner.secret = enrollment.secret;
      page = await client.get(securityPath).expect(200);
      await client.post('/account/mfa/confirm').type('form').send({ code: 'invalid', next: '/support/overview', _csrf: csrf(page.text) }).expect(302).expect('location', securityPath);
      assert.equal((await User.findById(owner.user._id)).security.mfaEnabled, false);
      page = await client.get(securityPath).expect(200);
      owner.enrollmentCode = totpCode(owner.secret, { time: Date.now() - 30000 });
      await client.post('/account/mfa/confirm').type('form').send({ code: owner.enrollmentCode, next: '/support/overview', _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      page = await client.get(securityPath).expect(200);
      assert.match(page.text, /href="\/support\/overview">Continue to Support workspace<\/a>/);
      owner.codes = [...page.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].map(match => match[1]);
      assert.equal(owner.codes.length, 10);
      assert.equal((await User.findById(owner.user._id)).role, 'customer', 'Enrollment does not rewrite the account identity mirror.');
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
      const repeat = await client.get(securityPath).expect(200);
      assert.equal([...repeat.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].length, 0);
      await client.post('/logout').type('form').send({ _csrf: csrf(repeat.text) }).expect(302);
      const loginPage = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email: owner.user.email, password, _csrf: csrf(loginPage.text) }).expect(302).expect('location', '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: owner.enrollmentCode, _csrf: csrf(challenge.text) }).expect(422);
      await client.post('/mfa').type('form').send({ code: totpCode(owner.secret), _csrf: csrf(challenge.text) }).expect(302).expect('location', '/support/overview');
    });

    const now = new Date(), fixtures = {};
    const category = await Category.create({ publicId: `cat_snav_${suffix}`, name: 'Navigation catalogue', slug: `snav-${suffix}`, active: true, countries: ['UG','KE','TZ'] });
    for (const [country, currency, amountMinor] of [['UG','UGX',12000],['KE','KES',3400],['TZ','TZS',990000]]) {
      const buyer = await actor('customer', { country, name: `Navigation Customer ${country}` });
      const seller = await actor('seller', { country });
      const store = await Store.create({ publicId: `str_snav_${country.toLowerCase()}_${suffix}`, ownerUserId: seller.user._id,
        name: `Navigation Store ${country}`, slug: `snav-${country.toLowerCase()}-${suffix}`, country, currency, status: 'verified', verifiedAt: now });
      const product = await Product.create({ publicId: `prd_snav_${country.toLowerCase()}_${suffix}`, ownerUserId: seller.user._id, storeId: store._id,
        categoryId: category._id, title: `Navigation Product ${country}`, slug: `snav-product-${country.toLowerCase()}-${suffix}`,
        description: 'Persisted product for real order support navigation.', countries: [country], status: 'published', publishedAt: now });
      const variant = await ProductVariant.create({ publicId: `var_snav_${country.toLowerCase()}_${suffix}`, productId: product._id, storeId: store._id,
        sku: `SNAV-${country}-${suffix}`, title: 'Default', priceMinor: amountMinor, currency, active: true });
      const order = await Order.create({ publicId: `ord_snav_${country.toLowerCase()}_${suffix}_persisted_order_reference`, userId: buyer.user._id, country,
        sessionKey: `snav_order_${country}_${suffix}`, idempotencyKey: `snav-order-${country}-${suffix}`, checkoutId: `snav-checkout-${country}-${suffix}`,
        cartPublicId: `crt_snav_${country.toLowerCase()}_${suffix}`, deliveryMethod: 'standard', paymentMethod: 'cod', reservationExpiresAt: new Date(Date.now()+86400000),
        status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', contact: { fullName: buyer.user.name, email: buyer.user.email, phone: buyer.user.phone,
          address: 'SUPPORT_PRIVATE_CUSTOMER_ADDRESS', city: 'Navigation City', country, note: 'SUPPORT_PRIVATE_CUSTOMER_NOTE' },
        totals: { subtotalMinor: amountMinor, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: amountMinor, currency },
        items: [{ linePublicId: `lin_snav_${country.toLowerCase()}_${suffix}`, productId: product._id, variantId: variant._id, storeId: store._id,
          reservationPublicId: `rsv_snav_${country.toLowerCase()}_${suffix}`, productPublicId: product.publicId, variantPublicId: variant.publicId, storePublicId: store.publicId,
          title: product.title, variantTitle: variant.title, sku: variant.sku, quantity: 1, deliveredQuantity: 1, unitPriceMinor: amountMinor, unitCostMinor: 900,
          costSnapshotStatus: 'captured', lineTotalMinor: amountMinor, currency }] });
      await PaymentIntent.create({ publicId: `pay_snav_${country.toLowerCase()}_${suffix}`, orderId: order._id, orderPublicId: order.publicId, country, currency,
        idempotencyKey: `snav-payment-${country}-${suffix}`, provider: 'cod', method: 'cod', status: 'succeeded', amountMinor, paidAt: now });
      const ticket = await SupportTicket.create({ publicId: `tkt_snav_${country.toLowerCase()}_${suffix}_persisted_ticket_reference`, userId: buyer.user._id,
        requesterName: buyer.user.name, orderId: order._id, orderPublicId: order.publicId, country, category: 'order', subject: `Recorded ${country} order assistance`,
        status: 'open', priority: 'high', queue: 'orders', slaDueAt: new Date(Date.now()+3600000), notes: [
          { message: `Customer public message ${country}`, actorUserId: buyer.user._id, internal: false },
          { message: `SUPPORT_INTERNAL_NOTE_${country}`, actorUserId: owner.user._id, internal: true }],
        workflowHistory: [{ action: 'created', actorUserId: buyer.user._id, toStatus: 'open' }] });
      const dispute = await Dispute.create({ publicId: `dsp_snav_${country.toLowerCase()}_${suffix}_persisted_dispute_reference`, userId: buyer.user._id,
        orderId: order._id, orderPublicId: order.publicId, country, category: 'delivery', subject: `Recorded ${country} escalation`, description: 'Recorded case for order escalation.',
        status: 'investigating', priority: 'high', events: [{ type: 'dispute.opened', message: 'Customer public escalation', actorUserId: buyer.user._id, visibility: 'customer' },
          { type: 'support.internal', message: `SUPPORT_PRIVATE_DISPUTE_NOTE_${country}`, actorUserId: owner.user._id, visibility: 'internal' }] });
      const returned = await ReturnRequest.create({ publicId: `ret_snav_${country.toLowerCase()}_${suffix}_persisted_return_reference`, userId: buyer.user._id,
        orderId: order._id, orderPublicId: order.publicId, country, status: 'requested', reason: 'damaged', details: 'Recorded customer return request.', resolution: 'refund',
        eligibleUntil: new Date(Date.now()+86400000), policyVersion: 'navigation-test', items: [{ orderLineId: order.items[0].linePublicId,
          productId: product._id, variantId: variant._id, storeId: store._id, storePublicId: store.publicId, productPublicId: product.publicId, variantPublicId: variant.publicId,
          title: product.title, quantity: 1, unitPriceMinor: amountMinor, requestedRefundMinor: amountMinor }] });
      const review = await Review.create({ publicId: `rev_snav_${country.toLowerCase()}_${suffix}_persisted_review_reference`, userId: buyer.user._id,
        orderId: order._id, orderPublicId: order.publicId, productId: product._id, productPublicId: product.publicId, country, rating: 4,
        title: `Recorded ${country} customer review`, body: 'Persisted verified customer review context.', verifiedPurchase: true, status: 'disputed', disputeReason: 'Recorded review authenticity concern' });
      fixtures[country] = { customer: buyer.user, ticket, order, returned, dispute, review };
    }

    await t.test('all nine private live pages have canonical aliases and approved Support navigation', async () => {
      assert.equal(Object.keys(SUPPORT_LIVE_ROUTES).length, 9);
      for (const [id, href] of Object.entries(SUPPORT_LIVE_ROUTES)) {
        const page = await client.get(href).set('Accept', 'text/html').expect(200);
        assert.match(page.text, /data-dashboard-workspace="support"/);
        assert.ok(page.text.includes(`data-dashboard-page="${id}"`), id);
        assert.match(page.text, /support-live\.css/);
        assert.doesNotMatch(page.text, /Development preview|Not available yet|id="roleSwitcher"|<h3>Classic Club<\/h3>|SUPPORT_PRIVATE_CUSTOMER_(?:ADDRESS|NOTE)/);
        assert.match(page.headers['cache-control'], /no-store/);
        assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
        await client.get('/dashboard/' + id + '?country=UG&search=retained%20query').expect(308).expect('location', href + '?country=UG&search=retained%20query');
      }
    });

    await t.test('country filters use assigned markets, masked contacts and explicit lookup', async () => {
      const overview = (await client.get('/support/overview').set('Accept','application/json').expect(200)).body;
      assert.deepEqual(overview.context.countries.map(row=>row.code).sort(), ['KE','UG']);
      const directory = await client.get('/support/customers').set('Accept','application/json').expect(200);
      assert.equal(directory.body.rows.length, 0, 'Support cannot browse an unfiltered customer directory.');
      for (const href of Object.values(SUPPORT_LIVE_ROUTES)) {
        const query = new URLSearchParams({ country:'UG', ...(href==='/support/customers'?{search:'Navigation Customer'}:{}), ...(href==='/support/reports'?{report:'tickets'}:{}) });
        const response = await client.get(href+'?'+query).set('Accept','application/json').expect(200);
        assert.equal(response.body.context.country, 'UG'); assert.equal(response.body.context.currency, 'UGX');
        const text = JSON.stringify(response.body);
        for (const row of Object.values(fixtures.TZ)) assert.ok(!text.includes(row.publicId), href+' unassigned reference');
        for (const row of Object.values(fixtures.KE)) assert.ok(!text.includes(row.publicId), href+' selected-country reference');
        assert.doesNotMatch(text, /SUPPORT_PRIVATE_CUSTOMER_(?:ADDRESS|NOTE)/);
        assert.ok(!text.includes(fixtures.UG.customer.email)); assert.ok(!text.includes(fixtures.UG.customer.phone));
        await client.get(href+'?country=TZ').set('Accept','application/json').expect(403);
      }
      await client.get('/support/queue?country=UG&country=KE').set('Accept','application/json').expect(422);
      await client.get('/support/reports?country[bad]=UG').set('Accept','application/json').expect(422);
      await client.get('/support/customers?search=ab').set('Accept','application/json').expect(422);
      const lookup = (await client.get('/support/customers?country=UG&search=Navigation%20Customer').set('Accept','application/json').expect(200)).body;
      assert.ok(lookup.rows.some(row=>row.id===fixtures.UG.customer.publicId));
      assert.equal(await LedgerAccount.countDocuments({ownerType:'customer',ownerPublicId:owner.user.publicId}), 0);
      assert.equal(await LoyaltyAccount.countDocuments({userId:owner.user._id}), 0);
    });

    await t.test('selected records remain scoped and customer pages exclude internal Support discussions', async () => {
      for (const [href, field] of [['/support/queue','ticket'],['/support/customers','customer'],['/support/orders','order'],
        ['/support/returns','returned'],['/support/escalations','dispute'],['/support/reviews','review']]) {
        await client.get(href+'?country=UG&record='+fixtures.TZ[field].publicId).set('Accept','application/json').expect(404);
        await client.get(href+'?country=UG&record='+fixtures.KE[field].publicId).set('Accept','application/json').expect(404);
      }
      const buyer = { user: fixtures.UG.customer }, { client: buyerClient } = await login(buyer, { challenge: false });
      for (const href of ['/support','/account/returns']) {
        const response = await buyerClient.get(href).expect(200);
        assert.match(response.text, /data-dashboard-workspace="customer"/);
        assert.doesNotMatch(response.text, /SUPPORT_INTERNAL_NOTE_|SUPPORT_PRIVATE_DISPUTE_NOTE_/);
      }
      const customerSupport = await buyerClient.get('/support').expect(200);
      await Dispute.updateOne({ _id: fixtures.UG.dispute._id }, { $set: { status:'resolved', resolvedAt:new Date() } });
      const decisionVersion = (await Dispute.findById(fixtures.UG.dispute._id)).__v;
      const appeal = await buyerClient.post('/api/v1/disputes/'+fixtures.UG.dispute.publicId+'/appeal').set('Accept','application/json')
        .send({ _csrf:csrf(customerSupport.text), version:decisionVersion, message:'Customer asks for an independently reviewed appeal.' }).expect(200);
      assert.doesNotMatch(JSON.stringify(appeal.body), /SUPPORT_PRIVATE_DISPUTE_NOTE_/);
      assert.ok(appeal.body.dispute.events.every(event=>event.visibility!=='internal'));
      await Dispute.updateOne({ _id: fixtures.UG.dispute._id }, { $set: { status:'investigating' }, $unset:{resolvedAt:1} });
    });

    await t.test('real page actions point to supported canonical destinations', async () => {
      for (const href of ['/support/overview','/support/reports?report=tickets','/support/orders','/support/reviews']) {
        const { body } = await client.get(href).set('Accept','application/json').expect(200);
        const actions = [...(body.priorities||[]),...(body.workflow||[]),...(body.rows||[]),body.create||{}];
        const destinations = [...new Set(actions.map(row=>row.href).filter(value=>typeof value==='string'&&value.startsWith('/support/')))];
        for (const destination of destinations) await client.get(destination).expect(200);
      }
    });

    await t.test('expired grants, changed tokens, revoked devices and disabled MFA deny existing sessions', async () => {
      for (const [name, change, status] of [
        ['expired grant',entry=>PlatformGrant.updateOne({_id:entry.grant._id},{$set:{expiresAt:new Date(Date.now()-1000)}}),403],
        ['suspended account',entry=>User.updateOne({_id:entry.user._id},{$set:{status:'suspended'}}),401],
        ['changed token',entry=>User.updateOne({_id:entry.user._id},{$inc:{'security.tokenVersion':1}}),401],
        ['revoked devices',entry=>Device.updateMany({userId:entry.user._id,revokedAt:null},{$set:{revokedAt:new Date(),revokedReason:'Support navigation revocation test'}}),401],
        ['disabled MFA',entry=>User.updateOne({_id:entry.user._id},{$set:{'security.mfaEnabled':false}}),403],
      ]) {
        const entry=await actor('customer',{managed:true,enroll:true}), {client:existingClient}=await login(entry);
        await existingClient.get('/support/overview').set('Accept','application/json').expect(200);
        await change(entry);
        for (const destination of Object.values(SUPPORT_LIVE_ROUTES)) await existingClient.get(destination).set('Accept','application/json').expect(status);
      }
    });

    await t.test('CSV export stops before its first data row when the original grant narrows during backpressure', async () => {
      const { streamSupportReportCsv } = await import('../src/services/support-report-pages.js');
      const entry=await actor('customer',{managed:true,enroll:true}), current=await User.findById(entry.user._id);
      const readRequest={id:'req_snav_stream_'+suffix,user:current,session:{tokenVersion:current.security.tokenVersion},query:{report:'tickets',country:''},
        ip:'127.0.0.18',get:()=> 'SupportNavigationExport/1.0'};
      const output=new EventEmitter(), chunks=[];
      output.destroyed=false; output.set=()=>output; output.end=()=>assert.fail('A revoked broader export cannot finish.');
      output.write=value=>{
        chunks.push(String(value));
        if(chunks.length===1){
          queueMicrotask(()=>{void PlatformGrant.updateOne({_id:entry.grant._id},{$set:{operationalCountries:['UG']}})
            .then(()=>output.emit('drain'),error=>output.emit('error',error));});
          return false;
        }
        return true;
      };
      await assert.rejects(streamSupportReportCsv(readRequest,output,'support-reports'),error=>error.code==='SUPPORT_SCOPE_CHANGED');
      assert.equal(chunks.length,1,'Only safe CSV column headers may be written before access changes.');
      for(const market of ['UG','KE','TZ']) assert.ok(!chunks.join('').includes(fixtures[market].ticket.publicId));
    });

    await t.test('other primary workspaces cannot render any Support page even with administrative support permissions', async () => {
      for (const role of ['customer', 'seller', 'promoter', 'finance', 'country_admin', 'super_admin']) {
        const other = await actor(role, { enroll: true, countries: role === 'super_admin' ? ['*'] : ['UG', 'KE'] });
        const { client: otherClient } = await login(other);
        for (const href of Object.values(SUPPORT_LIVE_ROUTES)) await otherClient.get(href).set('Accept', 'application/json').expect(403);
        assert.equal(await Store.countDocuments({ ownerUserId: other.user._id }), 0, role + ' read does not provision a store.');
      }
    });

    await t.test('personal account pages keep all nine Support menu destinations and real account security', async () => {
      for (const href of ['/account/security', '/account/messages']) {
        const page = await client.get(href).expect(200);
        assert.match(page.text, /data-dashboard-workspace="support"/);
        assert.doesNotMatch(page.text, /<h3>Classic Club<\/h3>|id="roleSwitcher"|Development preview/);
        for (const destination of Object.values(SUPPORT_LIVE_ROUTES)) assert.ok(page.text.includes(`href="${destination}"`), href + ':' + destination);
      }
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
      assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: owner.user.publicId }), 0);
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const width of [1366, 390]) await t.test(`all approved Support pages and settings sections show readable actual records at ${width}px`, async () => {
      const browserActor = await actor('customer', { managed: true, enroll: true });
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.goto(base + '/login');
        await page.locator('input[name="email"]').fill(browserActor.user.email);
        await page.locator('input[name="password"]').fill(password);
        await Promise.all([page.waitForURL(base + '/mfa'), page.locator('form[action="/login"] button[type="submit"]').click()]);
        await page.locator('form[action="/mfa"] input[name="code"]').fill(totpCode(browserActor.secret));
        await Promise.all([page.waitForURL(base + '/support/overview'), page.locator('form[action="/mfa"] button[type="submit"]').click()]);
        for (const [id, href] of Object.entries(SUPPORT_LIVE_ROUTES)) {
          const response = await page.goto(base + href + (id === 'support-reports' ? '?country=UG&report=tickets' : id === 'support-customers' ? '?country=UG&search=Navigation%20Customer' : '?country=UG'));
          assert.equal(response.status(), 200, href);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'support');
          assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), id);
          assert.equal(await page.locator('.side-navigation a[href^="/support/"]').count(), 9);
          assert.equal(await page.locator('#roleSwitcher').count(), 0);
          const layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            overflowing: [...document.querySelectorAll('.role-page *')].map(node => { const box = node.getBoundingClientRect(); return { tag: node.tagName, classes: node.className,
              right: Math.round(box.right), width: Math.round(box.width), text: node.textContent.trim().slice(0, 100) }; }).filter(node => node.width > 0 && node.right > innerWidth + 1).slice(0, 8) }));
          if (layout.scrollWidth > width + 1) await page.screenshot({ path: `/tmp/classicmart-${id}-${width}-overflow.png`, fullPage: true, animations: 'disabled' });
          assert.ok(layout.scrollWidth <= width + 1, href + ' page overflow: ' + JSON.stringify(layout));
          assert.equal(await page.locator('.role-page h1').isVisible(), true, href + ' heading');
          if (id === 'support-settings') {
            assert.equal(await page.locator('.role-settings-nav a').count(), 5);
            for (const section of ['profile', 'business', 'payments', 'notifications', 'security']) {
              const tab = page.locator(`.role-settings-nav a[href*="section=${section}"]`);
              assert.equal(await tab.count(), 1, 'Real settings section: ' + section);
              await tab.scrollIntoViewIfNeeded();
              await Promise.all([page.waitForNavigation(), tab.click()]);
              assert.equal(new URL(page.url()).searchParams.get('section'), section);
              assert.equal(await page.locator('.role-settings-panel.active').count(), 1);
              assert.equal(await page.locator('.role-settings-panel.active').isVisible(), true);
              assert.equal(await page.locator('.role-settings-panel.active').getAttribute('data-role-settings-panel'), section);
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Support settings ' + section + ' overflow');
            }
          } else {
            assert.equal(await page.locator('.role-metric-grid .role-metric').count(), 4, href + ' metrics');
            assert.equal(await page.locator('.role-metric-grid').evaluate(node => getComputedStyle(node).gap), width === 1366 ? '12px' : '9px');
            if (id === 'support-overview') {
              assert.equal(await page.locator('.role-welcome').count(), 1); assert.equal(await page.locator('.role-overview-grid').count(), 1); assert.equal(await page.locator('.role-bottom-grid').count(), 1);
              const status = await page.locator('.role-welcome-score strong').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth,
                height: node.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight) }));
              assert.ok(status.scrollWidth <= status.width + 1, 'Support control status stays inside its approved circle.');
              assert.ok(status.height <= status.lineHeight + 1, 'Support control status remains on one readable line.');
            } else {
              assert.equal(await page.locator('.role-content-grid').count(), 1);
              assert.equal(await page.locator('.role-progress-card').count(), 1); assert.equal(await page.locator('.role-activity-panel').count(), 1);
              if (width === 1366) assert.match(await page.locator('.role-content-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns), /292px$/);
            }
          }
          const recordValue = ({ 'support-queue':fixtures.UG.ticket.publicId, 'support-customers':fixtures.UG.customer.publicId,
            'support-orders':fixtures.UG.order.publicId, 'support-returns':fixtures.UG.returned.publicId, 'support-disputes':fixtures.UG.dispute.publicId,
            'support-reviews':fixtures.UG.review.publicId, 'support-reports':fixtures.UG.ticket.publicId })[id];
          if (recordValue) {
            const record = page.locator('.role-table tbody td').filter({ hasText: recordValue }).first();
            assert.equal(await record.count(), 1, href + ' actual persisted sample'); assert.equal(await record.isVisible(), true);
            if (width === 390) {
              const readability = await record.evaluate(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { width: box.width,
                height: box.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, whiteSpace: style.whiteSpace }; });
              assert.ok(readability.width > 200 && readability.height >= 20, href + ' mobile record uses readable card space');
              assert.ok(readability.scrollWidth <= readability.clientWidth + 1, href + ' full record text wraps without clipping');
              assert.notEqual(readability.whiteSpace, 'nowrap');
            }
          }
          if (['support-overview','support-queue','support-customers','support-settings'].includes(id)) await page.screenshot({ path: `/tmp/classicmart-${id}-${width}.png`, fullPage: true, animations: 'disabled' });
        }
        await page.goto(base + '/account/security');
        assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'support');
        assert.equal(await page.locator('.side-navigation a[href^="/support/"]').count(), 9);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Support personal security overflow');
        assert.equal((await User.findById(browserActor.user._id)).role, 'customer');
        assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: browserActor.user.publicId }), 0);
      } finally { await context.close(); }
    });

    await t.test('grant scope changes and revocation take effect in the existing authenticated session', async () => {
      const { loadSupportReportPage } = await import('../src/services/support-report-pages.js');
      const { renderSupportPage } = await import('../src/dashboard/support-page-view.js');
      const currentActor = await User.findById(owner.user._id);
      const readRequest = { user: currentActor, session: { tokenVersion: currentActor.security.tokenVersion }, query: {}, accepts: () => 'json' };
      const oldReport = await loadSupportReportPage(readRequest, 'support-overview');
      assert.ok(oldReport.context.countries.some(row => row.code === 'KE'), 'The report snapshot initially contains an authorized Kenya group.');
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { operationalCountries: ['UG'] } });
      await assert.rejects(renderSupportPage(readRequest, { json: () => assert.fail('A report loaded before scope narrowing must not be sent.') }, 'support-overview', oldReport),
        error => [403, 409].includes(error.status), 'Final rendering must reject Support rows produced under an obsolete broader grant.');
      const scoped = (await client.get('/support/overview').set('Accept', 'application/json').expect(200)).body;
      assert.deepEqual(scoped.context.countries.map(row => row.code), ['UG']);
      assert.equal(scoped.context.currency, 'UGX');
      for (const href of Object.values(SUPPORT_LIVE_ROUTES)) await client.get(href + '?country=KE').set('Accept', 'application/json').expect(403);
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
      await User.updateOne({ _id: owner.user._id }, { $set: { role: 'support' } });
      for (const href of Object.values(SUPPORT_LIVE_ROUTES)) await client.get(href).set('Accept', 'application/json').expect(403);
      const account = await client.get('/account/security').expect(200);
      assert.match(account.text, /data-dashboard-workspace="customer"/);
      assert.ok(!account.text.includes('href="/support/overview"'), 'A revoked Support mirror does not preserve Support navigation.');
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const transport of transports) transport.destroy();
    try { await Promise.all(Object.values(mongoose.models).map(Model => Model.init())); await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});
