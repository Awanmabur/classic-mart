import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;

function heroMarkup(html) {
  const beginning = html.indexOf('<div class="hero-slider"');
  const ending = html.indexOf('<div class="promo-stack">', beginning);
  assert.ok(beginning >= 0 && ending > beginning);
  return html.slice(beginning, ending);
}
const slideCount = html => (heroMarkup(html).match(/class="hero-slide /g) || []).length;

test('homepage hero uses real published CMS or available catalogue records and works without development CMS seeding',
  { skip: !uri, timeout: 180_000 }, async t => {
    assert.equal(new URL(uri).hostname, '127.0.0.1');
    assert.match(new URL(uri).pathname, /test|verification/i);
    const suffix = crypto.randomBytes(8).toString('hex');
    let server, browser;
    await mongoose.connect(uri, { dbName: 'classicmart_home_hero_test_' + suffix });
    try {
      const models = await import('../src/models/index.js');
      const { CountrySetting, User, Store, Warehouse, Category, Product, ProductVariant, ProductMedia, StockItem, CmsContent } = models;
      const { createApp } = await import('../src/app.js');
      const { clearStorefrontCache } = await import('../src/services/storefront.js');
      for (const Model of Object.values(mongoose.models)) await Model.init();
      await CountrySetting.create([
        { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
        { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      ]);
      const app = createApp(null);
      const client = request(app);
      let sequence = 0;
      const id = prefix => `${prefix}_hero_${suffix}_${++sequence}`;
      const owner = await User.create({ publicId: id('usr'), name: 'Hero catalogue owner', email: `hero-${suffix}@example.com`,
        emailNormalized: `hero-${suffix}@example.com`, phone: '+256700000151', phoneNormalized: '+256700000151',
        passwordHash: 'not-used-for-public-read-fixture', role: 'seller', status: 'active', country: 'UG', currency: 'UGX',
        emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const store = await Store.create({ publicId: id('str'), ownerUserId: owner._id, name: 'Hero source store', slug: id('hero-store'),
        country: 'UG', currency: 'UGX', status: 'verified' });
      const category = await Category.create({ publicId: id('cat'), name: 'Electronics', slug: 'electronics', countries: ['UG'] });
      const warehouse = await Warehouse.create({ publicId: id('whs'), ownerUserId: owner._id, storeId: store._id,
        name: 'Hero source warehouse', country: 'UG', city: 'Kampala', address: 'Owned local fixture' });
      const variants = [], products = [];
      const home = async () => { clearStorefrontCache(); return client.get('/').expect(200); };

      await t.test('a genuinely empty public catalogue has one honest empty-state banner and no false slider controls', async () => {
        const response = await home(), hero = heroMarkup(response.text);
        assert.match(hero, /data-hero-source="empty"/);
        assert.equal(slideCount(response.text), 1);
        assert.match(hero, /Find your next favourite/);
        assert.doesNotMatch(hero, /id="heroNext"|id="heroDots"|data-category-jump/);
        assert.equal(await CmsContent.countDocuments({}), 0);
      });

      await t.test('one in-stock published product gives one product slide while unavailable and draft products stay out', async () => {
        for (let index = 0; index < 4; index++) {
          const product = await Product.create({ publicId: id('prd'), ownerUserId: owner._id, storeId: store._id, categoryId: category._id,
            title: `Real hero product ${index}`, slug: 'hero-' + index, description: `Actual public product ${index} description.`,
            countries: ['UG'], status: index === 3 ? 'draft' : 'published', publishedAt: new Date(Date.now() + index) });
          const variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id,
            sku: `HERO-${suffix}-${index}`, title: 'Default', priceMinor: 45000 + index, currency: 'UGX', active: true });
          await ProductMedia.create({ publicId: id('med'), productId: product._id, storeId: store._id,
            source: 'seed_asset', originalName: 'wireless-headphones.svg', storageKey: id('image'), thumbnailStorageKey: id('thumbnail'),
            mimeType: 'image/webp', sizeBytes: 100, width: 200, height: 200, checksumSha256: 'a'.repeat(64), status: 'approved' });
          await StockItem.create({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id, variantId: variant._id,
            onHand: index === 0 || index === 3 ? 3 : 0 });
          products.push(product); variants.push(variant);
        }
        const response = await home(), hero = heroMarkup(response.text);
        assert.match(hero, /data-hero-source="catalogue"/);
        assert.equal(slideCount(response.text), 1);
        assert.match(hero, /Real hero product 0/);
        assert.doesNotMatch(hero, /Real hero product [123]|id="heroNext"/);
        assert.ok(hero.includes(`href="/products/${products[0].publicId}?country=UG"`));
        const detail = await client.get(`/products/${products[0].publicId}?country=UG`).expect(200);
        assert.match(detail.text, /Real hero product 0/);
      });

      await t.test('multiple available products create native server-rendered slide links without creating CMS content', async () => {
        await StockItem.updateMany({ variantId: { $in: variants.slice(0, 3).map(row => row._id) } }, { $set: { onHand: 3 } });
        const response = await home(), hero = heroMarkup(response.text);
        assert.equal(slideCount(response.text), 3);
        assert.match(hero, /id="heroPrev"/); assert.match(hero, /id="heroNext"/);
        assert.equal((hero.match(/data-slide="\d"/g) || []).length, 3);
        assert.ok(products.slice(0, 3).every(row => hero.includes(`/products/${row.publicId}?country=UG`)));
        assert.doesNotMatch(hero, /Real hero product 3/);
        assert.equal(await CmsContent.countDocuments({}), 0, 'The homepage must not seed marketing records as a side effect.');
      });

      await t.test('desktop and mobile animate and navigate the catalogue fallback even when no CMS rows exist', async () => {
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
        for (const width of [1366, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          try {
            const time = new Date('2026-10-25T00:00:00Z');
            await page.clock.install({ time }); await page.clock.pauseAt(new Date(time.getTime() + 1000));
            const response = await page.goto(base, { waitUntil: 'networkidle' });
            assert.equal(response.status(), 200);
            assert.equal(await page.locator('#heroSlider').getAttribute('data-hero-source'), 'catalogue');
            assert.equal(await page.locator('.hero-slide').count(), 3);
            const selected = () => page.locator('.hero-slide').evaluateAll(rows => rows.findIndex(row => row.classList.contains('is-active')));
            assert.equal(await selected(), 0);
            await page.clock.fastForward(5600);
            assert.equal(await selected(), 1, `${width}px: automatic rotation must start without seeded CMS.`);
            await page.locator('#heroDots button[data-slide="2"]').click({ position: { x: 1, y: 1 } });
            await page.clock.runFor(700);
            assert.equal(await selected(), 2);
            assert.equal(await page.locator('.hero-slide').first().getAttribute('aria-hidden'), 'true');
            assert.deepEqual(errors, []);
          } finally { await page.close(); }
        }
      });

      await t.test('saved product text cannot escape the homepage catalogue script boundary', async () => {
        const title = '</script><script id="heroInjection">window.heroInjected=true</script>';
        await Product.updateOne({ _id: products[0]._id }, { $set: { title } });
        try {
          const response = await home();
          assert.ok(!response.text.includes('<script id="heroInjection">'));
          const serialized = response.text.match(/<script\b[^>]*id="initialStorefrontData"[^>]*>([\s\S]*?)<\/script>/)?.[1];
          assert.ok(serialized);
          assert.ok(JSON.parse(serialized).products.some(product => product.name === title));
          assert.ok(!serialized.includes('<'));
        } finally {
          await Product.updateOne({ _id: products[0]._id }, { $set: { title: 'Real hero product 0' } });
          clearStorefrontCache();
        }
      });

      await t.test('maximum-length catalogue names and descriptions keep every hero product link inside its frame', async () => {
        const originals = products.slice(0, 3).map(product => ({ _id: product._id, title: product.title, description: product.description }));
        const titles = ['SKU' + 'X'.repeat(177), 'A detailed product name with specification '.repeat(5).slice(0, 180), 'Y'.repeat(180)];
        const priorIsolation = process.env.CLASSIC_MART_E2E_LOOPBACK_ISOLATION;
        process.env.CLASSIC_MART_E2E_LOOPBACK_ISOLATION = '1';
        const { createBrowserTestNetwork } = await import('../scripts/browser-test-network.js');
        try {
          await Product.bulkWrite(originals.map((product, index) => ({ updateOne: { filter: { _id: product._id },
            update: { $set: { title: titles[index], description: 'DescriptionWithoutSpaces'.repeat(250).slice(0, 5000) } } } })));
          clearStorefrontCache();
          for (const [index, width] of [1024, 1366, 390, 320].entries()) {
            const network = await createBrowserTestNetwork({ baseURL: `http://127.0.0.1:${server.address().port}`,
              workerIndex: 45, sequence: index + 1 });
            const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            try {
              const response = await page.goto(network.baseURL, { waitUntil: 'networkidle' });
              assert.equal(response.status(), 200);
              assert.equal(await page.locator('#heroSlider').getAttribute('data-hero-source'), 'catalogue');
              assert.equal(await page.locator('.hero-slide').count(), 3);
              for (let slide = 0; slide < 3; slide++) {
                await page.locator(`#heroDots button[data-slide="${slide}"]`).click();
                const active = page.locator('.hero-slide.is-active');
                await active.locator('.button').scrollIntoViewIfNeeded();
                await page.waitForFunction(() => {
                  const frame = document.getElementById('heroSlider').getBoundingClientRect();
                  const active = document.querySelector('.hero-slide.is-active').getBoundingClientRect();
                  return Math.abs(active.left - frame.left) <= 1;
                });
                const geometry = await active.evaluate(element => {
                  const heading = element.querySelector('h1, h2'), copy = element.querySelector('p');
                  const describe = node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; };
                  return { frame: describe(element.closest('#heroSlider')), heading: describe(heading), action: describe(element.querySelector('.button')),
                    headingClamp: getComputedStyle(heading).webkitLineClamp, bodyClamp: getComputedStyle(copy).webkitLineClamp,
                    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
                });
                assert.equal(geometry.headingClamp, '3'); assert.equal(geometry.bodyClamp, '3');
                assert.ok(geometry.horizontalOverflow <= 1, `${width}px slide ${slide}: unbroken catalogue text must not overflow the page.`);
                for (const name of ['heading', 'action']) {
                  assert.ok(geometry[name].left >= geometry.frame.left - 1 && geometry[name].right <= geometry.frame.right + 1,
                    `${width}px slide ${slide}: ${name} must fit horizontally within the hero.`);
                  assert.ok(geometry[name].top >= geometry.frame.top - 1 && geometry[name].bottom <= geometry.frame.bottom + 1,
                    `${width}px slide ${slide}: ${name} must stay visible vertically within the hero.`);
                }
                assert.ok((await active.locator('.button').getAttribute('href')).startsWith('/products/'));
              }
            } finally { await page.close(); await network.close(); }
          }
        } finally {
          await Product.bulkWrite(originals.map(product => ({ updateOne: { filter: { _id: product._id },
            update: { $set: { title: product.title, description: product.description } } } })));
          clearStorefrontCache();
          if (priorIsolation === undefined) delete process.env.CLASSIC_MART_E2E_LOOPBACK_ISOLATION;
          else process.env.CLASSIC_MART_E2E_LOOPBACK_ISOLATION = priorIsolation;
        }
      });

      await t.test('only active public revisions appear and the current market overrides an equal global key', async () => {
        const revision = (title, version = 1) => ({ version, title, body: 'Actual published editorial content.',
          data: { category: 'electronics', action: 'Read current electronics' }, reason: 'Owned publication read fixture', createdByUserId: owner._id });
        const shared = 'home.hero.shared';
        await CmsContent.create([
          { publicId: id('cms'), key: shared, type: 'hero', country: '', status: 'published', activeVersion: 1, revisions: [revision('Global active hero')] },
          { publicId: id('cms'), key: shared, type: 'hero', country: 'UG', status: 'draft', activeVersion: 0, revisions: [revision('Unpublished Uganda draft')] },
          { publicId: id('cms'), key: shared, type: 'hero', country: 'KE', status: 'published', activeVersion: 1, revisions: [revision('Foreign Kenya hero')] },
          { publicId: id('cms'), key: 'home.hero.future', type: 'hero', country: 'UG', status: 'scheduled', activeVersion: 0, scheduledVersion: 1,
            revisions: [{ ...revision('Not yet published future hero'), scheduledFor: new Date(Date.now() + 60_000) }] },
          { publicId: id('cms'), key: 'home.hero.current', type: 'hero', country: 'UG', status: 'scheduled', activeVersion: 1, scheduledVersion: 2,
            revisions: [revision('Current active revision'), { ...revision('Future replacement', 2), scheduledFor: new Date(Date.now() + 60_000) }] },
          { publicId: id('cms'), key: 'home.hero.archived', type: 'hero', country: 'UG', status: 'archived', activeVersion: 1, revisions: [revision('Archived hero')] },
        ]);
        let response = await home(), hero = heroMarkup(response.text);
        assert.match(hero, /data-hero-source="cms"/); assert.equal(slideCount(response.text), 2);
        assert.match(hero, /Global active hero/); assert.match(hero, /Current active revision/);
        assert.doesNotMatch(hero, /Unpublished Uganda|Foreign Kenya|Not yet published|Future replacement|Archived hero|Real hero product/);
        assert.ok(hero.includes('href="/products?country=UG&amp;category=electronics"'));
        await CmsContent.updateOne({ key: shared, country: 'UG' }, { $set: { status: 'published', activeVersion: 1 } });
        response = await home(); hero = heroMarkup(response.text);
        assert.match(hero, /Unpublished Uganda draft/);
        assert.doesNotMatch(hero, /Global active hero|Foreign Kenya/);
      });
    } finally {
      if (browser) await browser.close();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
    }
  });
