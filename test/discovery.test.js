import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import discovery, { clearDiscoveryCache } from '../src/routes/discovery.js';
import { CmsContent, Product } from '../src/models/index.js';
import { SITE_URL } from '../src/services/seo.js';

const app = () => express().use(discovery).use((error, _request, response, _next) => response.status(error.status || 500).json({ code: error.code }));
test('public crawling and AI source discovery exclude private and duplicate pages', async () => {
  clearDiscoveryCache();
  const result = await request(app()).get('/robots.txt').expect(200);
  assert.match(result.text, /User-agent: \*\nAllow: \/\n/);
  assert.match(result.text, /Allow: \/sellers/);
  for (const path of ['/dashboard','/orders','/addresses','/wallet','/account','/api']) {
    assert.ok(result.text.includes(`Disallow: ${path}$\n`));
    assert.ok(result.text.includes(`Disallow: ${path}/\n`));
  }
  assert.ok(!result.text.includes('Disallow: /sellers'));
  assert.ok(!result.text.includes('Disallow: /categories'));
  const pages = await request(app()).get('/sitemaps/pages.xml').expect(200);
  assert.ok(pages.text.includes('/return-policy?country=UG</loc>'));
  assert.ok(pages.text.includes('/products?country=UG</loc>'));
  assert.ok(!pages.text.includes('/dashboard'));
  assert.ok(!pages.text.includes('/search'));
  const llms = await request(app()).get('/llms.txt').expect(200);
  assert.match(llms.text, /Prices, currency, inventory and delivery options can change/);
  assert.ok(llms.text.includes(`${SITE_URL}/sitemap.xml`));
  assert.match(llms.text, /does not grant account access/);
});
test('sitemaps use full public eligibility, bounded pagination, authoritative canonicals and cached results', async t => {
  clearDiscoveryCache();
  let calls = 0;
  t.mock.method(CmsContent, 'aggregate', () => ({ option: async () => [{ total: 0 }] }));
  t.mock.method(Product, 'aggregate', pipeline => ({ option: async options => {
    calls++;
    assert.equal(options.maxTimeMS, 15_000);
    assert.deepEqual(pipeline[0], { $match: { status: 'published', countries: 'UG' } });
    const serialized = JSON.stringify(pipeline);
    assert.ok(serialized.includes('"_publicStore.status":"verified"'));
    assert.ok(serialized.includes('"_publicCategory.active":true'));
    assert.ok(serialized.includes('"currency":"UGX"'));
    assert.ok(serialized.includes('moderation.firstApprovalByUserId'));
    if (pipeline.some(stage => stage.$facet)) return [{ products: [{ total: 1001 }], categories: [{ total: 1 }], sellers: [{ total: 1 }] }];
    const offset = pipeline.find(stage => stage.$skip !== undefined).$skip;
    assert.equal(pipeline.find(stage => stage.$limit).$limit, 1000);
    return offset === 1000 ? [{ publicId: 'prd_public', updatedAt: new Date('2026-10-07T00:00:00Z') }] : [];
  } }));
  const server = app();
  const index = await request(server).get('/sitemap.xml').set('Host', 'attacker.invalid').expect(200);
  assert.ok(index.text.includes('/products.xml?country=UG&amp;page=2'));
  assert.ok(index.text.includes('/categories.xml?country=UG&amp;page=1'));
  assert.ok(!index.text.includes('attacker.invalid'));
  await request(server).get('/sitemap.xml').expect(200);
  assert.equal(calls, 1, 'repeated index requests must share the cached aggregate');
  const page = await request(server).get('/sitemaps/products.xml?country=UG&page=2').expect(200);
  assert.ok(page.text.includes(`${SITE_URL}/products/prd_public?country=UG</loc>`));
  assert.match(page.text, /<lastmod>2026-10-07T00:00:00.000Z<\/lastmod>/);
  assert.match(page.headers['cache-control'], /public/);
  await request(server).get('/sitemaps/products.xml?page=3').expect(404);
  const priorCalls = calls;
  for (const query of ['page=-1','page=1&page=2','page=50001','country=UG&country=KE','country=ZZ','page=1&sort=price','page=1.5']) await request(server).get('/sitemaps/products.xml?' + query).expect(404);
  assert.equal(calls, priorCalls, 'invalid selectors must not reach the product query');
});
test('empty eligible catalogues advertise no nonexistent product/category/seller sitemaps', async t => {
  clearDiscoveryCache();
  t.mock.method(Product, 'aggregate', () => ({ option: async () => [{ products: [], categories: [], sellers: [] }] }));
  t.mock.method(CmsContent, 'aggregate', () => ({ option: async () => [{ total: 0 }] }));
  const index = await request(app()).get('/sitemap.xml').expect(200);
  assert.ok(!index.text.includes('/products.xml'));
  assert.ok(!index.text.includes('/categories.xml'));
  assert.ok(!index.text.includes('/sellers.xml'));
  assert.ok(index.text.includes('/articles.xml?country=UG'));
});
test('article discovery paginates active public revisions rather than truncating the journal feed', async t => {
  clearDiscoveryCache();
  t.mock.method(Product, 'aggregate', () => ({ option: async () => [{ products: [], categories: [], sellers: [] }] }));
  t.mock.method(CmsContent, 'aggregate', pipeline => ({ option: async () => {
    assert.deepEqual(pipeline[0].$match.country, { $in: ['UG', ''] });
    assert.deepEqual(pipeline[0].$match.activeVersion, { $gt: 0 });
    assert.ok(JSON.stringify(pipeline).includes('$$revision.version'));
    if (pipeline.some(stage => stage.$count)) return [{ total: 1001 }];
    assert.equal(pipeline.find(stage => stage.$skip !== undefined).$skip, 1000);
    assert.equal(pipeline.find(stage => stage.$limit).$limit, 1000);
    return [{ key: 'press.article.published-guide' }];
  } }));
  const index = await request(app()).get('/sitemap.xml').expect(200);
  assert.ok(index.text.includes('/articles.xml?country=UG&amp;page=2'));
  const page = await request(app()).get('/sitemaps/articles.xml?country=UG&page=2').expect(200);
  assert.ok(page.text.includes('/press/press.article.published-guide?country=UG</loc>'));
});
