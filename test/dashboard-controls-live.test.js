import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import mongoose from 'mongoose';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.MEDIA_STORAGE_DRIVER = 'filesystem';
const uploadDir = `/tmp/classicmart-dashboard-controls-${crypto.randomBytes(8).toString('hex')}`;
process.env.UPLOAD_DIR = uploadDir;
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) {
  process.env[name] = crypto.randomBytes(32).toString('hex');
}
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const actionClasses = '.primary-button, .outline-button, .soft-button, .light-button, .ghost-light-button';
const textActions = `#pageHost :is(a, button):is(${actionClasses}):not(.seller-filter-submit), #pageHost button.plain-link, #pageHost .notification-list article > form > button`;
const csrf = html => {
  const match = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(match, 'The real authentication form must provide CSRF protection.');
  return match[1];
};

async function controlGeometry(page, selector = textActions) {
  return page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.checkVisibility() && node.textContent.trim()).map(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node), content = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      content.push(...range.getClientRects());
    }
    content.push(...[...node.querySelectorAll('svg')].map(icon => icon.getBoundingClientRect()));
    const left = Math.min(...content.map(rect => rect.left)), right = Math.max(...content.map(rect => rect.right));
    const top = Math.min(...content.map(rect => rect.top)), bottom = Math.max(...content.map(rect => rect.bottom));
    return { label: `${node.tagName.toLowerCase()}.${[...node.classList].join('.')} "${node.textContent.trim()}"`, width: box.width, height: box.height,
      blockStart: parseFloat(style.paddingTop), blockEnd: parseFloat(style.paddingBottom),
      inlineStart: parseFloat(style.paddingLeft), inlineEnd: parseFloat(style.paddingRight),
      horizontalOffset: Math.abs((left + right) / 2 - (box.left + box.right) / 2),
      verticalOffset: Math.abs((top + bottom) / 2 - (box.top + box.bottom) / 2),
      leftSpace: left - box.left, rightSpace: box.right - right,
      topSpace: top - box.top, bottomSpace: box.bottom - bottom,
      overflow: node.scrollWidth - node.clientWidth,
      icons: [...node.querySelectorAll('svg')].map(icon => ({ width: icon.getBoundingClientRect().width, expected: icon.getBoundingClientRect().height })) };
  }));
}

function geometryFailures(controls, context) {
  const failures = [];
  for (const control of controls) {
    const label = `${context}: ${control.label}`;
    const check = (valid, reason) => { if (!valid) failures.push(`${label}: ${reason}`); };
    check(control.width > 0 && control.height > 0, 'visible control has nonzero dimensions');
    check(control.horizontalOffset <= 2, `horizontal centering (${control.horizontalOffset}px offset)`);
    check(control.verticalOffset <= 3, `vertical centering (${control.verticalOffset}px offset)`);
    check(control.leftSpace >= 8 && control.rightSpace >= 8, `horizontal breathing room (${control.leftSpace}px / ${control.rightSpace}px)`);
    check(control.topSpace >= 5 && control.bottomSpace >= 5, `vertical breathing room (${control.topSpace}px / ${control.bottomSpace}px)`);
    check(control.overflow <= 1, 'label must not clip');
    for (const icon of control.icons) check(Math.abs(icon.width - icon.expected) <= 1, 'icon must keep its width');
  }
  return failures;
}

test('live dashboard text actions keep centered labels, breathing room and rounded photos on every connected page', { skip: !uri, timeout: 600_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_dashboard_controls_test_${suffix}` });
  let browser, server;
  try {
    const { createApp } = await import('../src/app.js');
    const { User, Store, StoreMember, CountrySetting, PlatformGrant, Warehouse, PromoterVerification,
      Category, Product, ProductVariant, ProductMedia, StockItem, CustomerCatalogueState, Notification, SupportTicket } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { putMediaObject } = await import('../src/services/object-storage.js');
    const { CUSTOMER_ROUTES } = await import('../src/dashboard/customer-routes.js');
    const { SELLER_LIVE_ROUTES } = await import('../src/dashboard/seller-routes.js');
    const { PROMOTER_LIVE_ROUTES } = await import('../src/dashboard/promoter-routes.js');
    const { FINANCE_LIVE_ROUTES } = await import('../src/dashboard/finance-routes.js');
    const { SUPPORT_LIVE_ROUTES } = await import('../src/dashboard/support-routes.js');
    const { MODERATION_LIVE_ROUTES } = await import('../src/dashboard/moderation-routes.js');
    const { COUNTRY_ADMIN_LIVE_ROUTES } = await import('../src/dashboard/country-admin-routes.js');
    const { WAREHOUSE_ROUTES } = await import('../src/dashboard/warehouse-routes.js');
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const password = `Controls-${suffix}-A1!`, passwordHash = await hashPassword(password);
    const roles = [
      ['customer', CUSTOMER_ROUTES], ['seller', SELLER_LIVE_ROUTES], ['promoter', PROMOTER_LIVE_ROUTES],
      ['finance', FINANCE_LIVE_ROUTES], ['support', SUPPORT_LIVE_ROUTES], ['moderator', MODERATION_LIVE_ROUTES],
      ['admin', COUNTRY_ADMIN_LIVE_ROUTES], ['warehouse', WAREHOUSE_ROUTES],
    ];
    const members = [];
    for (const [index, [workspace, routes]] of roles.entries()) {
      const managed = ['finance', 'support', 'moderator', 'admin', 'warehouse'].includes(workspace);
      const email = `controls-${suffix}-${index}@example.com`, phone = '+25670' + String(index + 1).padStart(7, '0');
      const user = await User.create({ publicId: `usr_controls_${suffix}_${index}`, name: `Controls ${workspace}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role: managed ? 'customer' : workspace, country: 'UG', shoppingCountry: 'UG', currency: 'UGX', locale: 'en-UG',
        ...(managed ? { platformAccessManagedAt: new Date() } : {}), emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
        onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
      let warehouse, store;
      if (['seller', 'warehouse'].includes(workspace)) {
        store = await Store.create({ publicId: `str_controls_${suffix}_${index}`, ownerUserId: user._id, name: `Controls ${workspace} Store`,
          slug: `controls-${suffix}-${index}`, country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
        await StoreMember.create({ publicId: `stm_controls_${suffix}_${index}`, storeId: store._id, userId: user._id,
          role: 'owner', status: 'active', invitedByUserId: user._id, acceptedAt: new Date() });
        warehouse = await Warehouse.create({ publicId: `wh_controls_${suffix}_${index}`, storeId: store._id, ownerUserId: user._id,
          name: 'Controls Warehouse', country: 'UG', city: 'Kampala', address: 'Controls fixture address' });
      }
      if (managed) await PlatformGrant.create({ publicId: `pgr_controls_${suffix}_${index}`, userId: user._id,
        role: workspace === 'admin' ? 'country_admin' : workspace, operationalCountries: ['UG'],
        warehouseScopes: warehouse ? [warehouse.publicId] : [], status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
        reason: 'Isolated live dashboard control layout verification.', approvalPublicId: `apr_controls_${suffix}_${index}`, approvedByUserId: user._id });
      if (workspace === 'promoter') await PromoterVerification.create({ publicId: `prv_controls_${suffix}`, userId: user._id, country: 'UG',
        status: 'verified', channels: ['whatsapp'], niches: ['Home'], audienceSize: 100, disclosureAcceptedAt: new Date() });
      let recoveryCode;
      if (workspace !== 'customer') {
        const enrollment = await beginMfaEnrollment(user._id, password);
        const confirmed = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
        recoveryCode = confirmed.codes[0];
      }
      members.push({ workspace, routes, email, recoveryCode, user, store, warehouse });
    }
    // Persist a real public catalogue item, private seller detail, wishlist and
    // unread notification so the audit includes populated controls and photos.
    const seller = members.find(member => member.workspace === 'seller'), customer = members[0];
    const category = await Category.create({ publicId: `cat_controls_${suffix}`, name: 'Controls catalogue', slug: `controls-${suffix}`, active: true, countries: ['UG'] });
    const product = await Product.create({ publicId: `prd_controls_${suffix}`, storeId: seller.store._id, ownerUserId: seller.user._id, categoryId: category._id,
      title: 'Controls fixture product with a deliberately long catalogue title', slug: `controls-${suffix}`, description: 'A persisted product for responsive button and photo verification.',
      countries: ['UG'], status: 'published', publishedAt: new Date() });
    const variant = await ProductVariant.create({ publicId: `var_controls_${suffix}`, productId: product._id, storeId: seller.store._id,
      sku: `CONTROLS-${suffix}`, title: 'Standard', priceMinor: 12500, currency: 'UGX', active: true });
    await StockItem.create({ publicId: `stk_controls_${suffix}`, storeId: seller.store._id, variantId: variant._id, warehouseId: seller.warehouse._id, onHand: 20 });
    const bytes = await sharp({ create: { width: 160, height: 160, channels: 3, background: '#f4d0b2' } }).webp().toBuffer();
    const key = `${product.publicId}/layout-fixture.webp`;
    await putMediaObject(key, bytes, { contentType: 'image/webp' });
    await ProductMedia.create({ publicId: `pmd_controls_${suffix}`, productId: product._id, storeId: seller.store._id,
      storageKey: key, thumbnailStorageKey: key, mimeType: 'image/webp', sizeBytes: bytes.length, width: 160, height: 160,
      checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex'), altText: 'Controls catalogue photo', status: 'approved' });
    await CustomerCatalogueState.create({ userId: customer.user._id, wishlistProductIds: [product._id] });
    await Notification.create({ publicId: `ntf_controls_${suffix}`, userId: customer.user._id, country: 'UG', type: 'account',
      title: 'Review your account preferences before your next order', body: 'A persisted notification for responsive action verification.' });
    await SupportTicket.create({ publicId: `tkt_controls_${suffix}`, userId: customer.user._id, country: 'UG', category: 'account',
      subject: 'Help reviewing account preferences', status: 'open', slaDueAt: new Date(Date.now() + 3_600_000),
      notes: [{ message: 'Please help me review my account preferences.', actorUserId: customer.user._id, internal: false }] });
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    for (const [index, member] of members.entries()) await t.test(`${member.workspace} connected pages at 1366px, 390px and 320px`, async () => {
      // Independent applications retain the real per-IP limiter without making
      // eight sequential users share one application's 240-request window.
      server = createApp(null).listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, reducedMotion: 'reduce' });
      const transport = new http.Agent({ localAddress: `127.0.0.${index + 110}`, keepAlive: false });
      try {
        const page = await context.newPage();
        const browserErrors = [];
        let activeVisit = `${member.workspace} setup`;
        page.on('pageerror', error => browserErrors.push(`${activeVisit} (${page.url()}): ${error.message}`));
        // Each actor uses its own loopback transport. Keep the production
        // 12-attempt limiter enabled while obtaining genuine password/MFA
        // sessions for eight independent users, then use those in Chromium.
        const client = request.agent(server).use(req => req.agent(transport));
        const login = await client.get('/login').expect(200);
        let authenticated = await client.post('/login').type('form').send({ email: member.email, password, _csrf: csrf(login.text) }).expect(302);
        if (member.recoveryCode) {
          assert.equal(authenticated.headers.location, '/mfa');
          const challenge = await client.get('/mfa').expect(200);
          authenticated = await client.post('/mfa').type('form').send({ code: member.recoveryCode, _csrf: csrf(challenge.text) }).expect(302);
        }
        const cookies = (authenticated.headers['set-cookie'] || []).map(header => {
          const pair = header.split(';')[0], separator = pair.indexOf('=');
          return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: base };
        });
        assert.ok(cookies.length > 0, 'Password/MFA completion must issue the real session cookie.');
        await context.addCookies(cookies);
        if (member.workspace === 'customer') {
          await page.goto(base + '/wishlist');
          await Promise.all([page.waitForURL(base + '/cart'), page.locator('[data-cart-add]').first().click()]);
          assert.equal(await page.locator('.cart-item').count(), 1, 'The catalogue action persists a real cart item.');
        }
        const detail = member.workspace === 'seller' ? `/seller/products/${product.publicId}`
          : member.workspace === 'moderator' ? `/moderation/products/${product.publicId}`
            : member.workspace === 'admin' ? `/admin/products/${product.publicId}` : null;
        const hrefs = [...new Set([...Object.values(member.routes), ...(detail ? [detail] : []), '/account/security', '/account/privacy', '/account/apps', '/account/messages'])];
        let checked = 0, photoCount = 0;
        const failures = [];
        for (const width of [1366, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const href of hrefs) {
            activeVisit = `${member.workspace} ${href} at ${width}px`;
            const response = await page.goto(base + href);
            assert.equal(response.status(), 200, `${member.workspace} ${href}`);
            assert.equal(await page.locator('body').getAttribute('data-dashboard-live'), 'true', href);
            assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), member.workspace, href);
            await page.locator('link[href*="/approved-dashboard/live-controls.css"]').waitFor({ state: 'attached' });
            if (member.workspace === 'customer' && href === '/support') {
              for (const summary of await page.locator('#pageHost .ticket-list details > summary').all()) await summary.click();
            }
            const controls = await controlGeometry(page);
            failures.push(...geometryFailures(controls, `${member.workspace} ${href} at ${width}px`));
            checked += controls.length;
            const stackedForms = await page.locator('#pageHost .dashboard-form:has(> .soft-button)').evaluateAll(forms => forms.filter(form => form.checkVisibility()).map(form => {
              const box = form.getBoundingClientRect(), submit = form.querySelector(':scope > .soft-button').getBoundingClientRect();
              const fields = [...form.querySelectorAll(':scope > label')].map(label => label.getBoundingClientRect());
              return { left: box.left, width: box.width, submitLeft: submit.left, submitTop: submit.top,
                fieldBottom: Math.max(...fields.map(field => field.bottom)), fieldWidths: fields.map(field => field.width) };
            }));
            for (const form of stackedForms) {
              if (Math.abs(form.submitLeft - form.left) > 1 || form.submitTop < form.fieldBottom + 5 || form.fieldWidths.some(field => Math.abs(field - form.width) > 1)) {
                failures.push(`${member.workspace} ${href} at ${width}px: form submit must follow full-width fields without implicit side columns (${JSON.stringify(form)})`);
              }
            }
            const uploads = await page.locator('#pageHost .role-upload-box:has(> .soft-button)').evaluateAll(boxes => boxes.map(box => {
              const bounds = box.getBoundingClientRect(), submit = box.querySelector(':scope > .soft-button').getBoundingClientRect();
              const copy = box.querySelector(':scope > p')?.getBoundingClientRect();
              return { centered: Math.abs((submit.left + submit.right - bounds.left - bounds.right) / 2) <= 1,
                followsCopy: !copy || submit.top >= copy.bottom };
            }));
            if (uploads.some(upload => !upload.centered || !upload.followsCopy)) failures.push(`${member.workspace} ${href} at ${width}px: upload action must stay centered below its instructions`);
            const photos = await page.locator('#pageHost :is(.product-image img, .wishlist-item img, .category-card img, .cart-item > img, .seller-product-image)').evaluateAll(nodes =>
              nodes.filter(node => node.checkVisibility()).map(node => parseFloat(getComputedStyle(node).borderTopLeftRadius)));
            assert.ok(photos.every(radius => radius >= 12), href + ' rounded catalogue photos');
            photoCount += photos.length;
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            if (overflow > 1) failures.push(`${activeVisit}: document overflows horizontally by ${overflow}px`);
            if (href === Object.values(member.routes)[0]) {
              await page.screenshot({ path: `/tmp/classicmart-ui-repair-${member.workspace}-${width}.png`, fullPage: true, animations: 'disabled' });
            }
          }
        }
        assert.ok(checked > 0, `${member.workspace} actually exercised text controls`);
        if (['customer', 'seller', 'moderator', 'admin'].includes(member.workspace)) assert.ok(photoCount > 0, `${member.workspace} actually exercised catalogue photos`);
        assert.deepEqual(browserErrors, [], `${member.workspace} browser page errors:\n${browserErrors.join('\n')}`);
        assert.deepEqual(failures, [], `${member.workspace} invalid controls:\n${failures.join('\n')}`);
        t.diagnostic(`${member.workspace}: ${hrefs.length} real pages, ${checked} controls and ${photoCount} photos checked across three widths.`);
      } finally {
        transport.destroy();
        await context.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        server = null;
      }
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    try { await mongoose.connection.dropDatabase(); } finally {
      await mongoose.disconnect();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  }
});
