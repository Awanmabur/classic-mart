import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { canonicalUrl, hasDuplicateQuery, isPrivatePath, jsonForHtml, pageSeo, productSeo, SITE_URL } from '../src/services/seo.js';
import { seoContext } from '../src/middleware/seo.js';

const uganda = { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG' };
const page = (path, query = '', country = uganda) => ({ path, originalUrl: path + query, country, protocol: 'https', get: () => 'attacker.invalid' });
test('canonical domain comes from BASE_URL and country selectors remain market-specific', () => {
  const ug = productSeo(page('/products/prd_safe', '?utm_source=test'), { id: 'prd_safe', name: 'Desk lamp', description: 'Adjustable table lamp', price: 50000, currency: 'UGX', stock: 1, variants: [] });
  assert.equal(ug.canonical, `${SITE_URL}/products/prd_safe?country=UG`);
  assert.ok(!ug.jsonLd.includes('attacker.invalid'));
  assert.equal(canonicalUrl('/products/prd_safe?sort=price#fragment', 'KE'), `${SITE_URL}/products/prd_safe?country=KE`);
  assert.equal(new URL(canonicalUrl('//attacker.invalid/path', 'UG')).origin, new URL(SITE_URL).origin);
  assert.equal(canonicalUrl('/about', 'KE'), `${SITE_URL}/about`);
  assert.notEqual(canonicalUrl('/products/prd_safe', 'UG'), canonicalUrl('/products/prd_safe', 'KE'));
});
test('offers describe individual variant prices and stock without inventing reviews or brand', () => {
  const product = { id: 'prd_lamp', name: 'Desk lamp', description: 'Study lamp', brand: 'Independent', currency: 'UGX', price: 30000, stock: 4,
    variants: [{ sku: 'LAMP-A', price: 30000, currency: 'UGX', stock: 0 }, { sku: 'LAMP-B', price: 45000, currency: 'UGX', stock: 4 }] };
  const metadata = productSeo(page('/products/prd_lamp'), product);
  const schema = JSON.parse(metadata.jsonLd)['@graph'][0];
  assert.equal(schema['@type'], 'Product');
  assert.equal(schema.offers[0].availability, 'https://schema.org/OutOfStock');
  assert.equal(schema.offers[1].availability, 'https://schema.org/InStock');
  assert.equal(schema.offers[0].price, '30000');
  assert.equal(schema.offers[1].price, '45000');
  assert.ok(!schema.aggregateRating);
  assert.ok(!schema.brand);
  const reviewed = JSON.parse(productSeo(page('/products/prd_lamp'), { ...product, reviews: 2, rating: 4.5 }).jsonLd)['@graph'][0];
  assert.equal(reviewed.aggregateRating.reviewCount, 2);
});
test('search/filter/private duplicates are noindex and tracking parameters are canonicalized away', () => {
  for (const path of ['/search','/cart','/checkout','/account/profile','/seller/products','/business/documents/id','/login']) assert.equal(pageSeo(page(path)).noindex, true, path);
  assert.equal(isPrivatePath('/sellers/verified-store'), false);
  assert.equal(isPrivatePath('/promoters/verified-person'), false);
  for (const query of ['?q=lamp','?category=electronics','?page=2','?sort=price','?country=UG&country=KE']) assert.equal(hasDuplicateQuery(page('/products', query)), true, query);
  assert.equal(pageSeo(page('/products', '?country=UG&utm_source=newsletter')).noindex, false);
});
test('schema JSON remains valid and cannot terminate a script element', () => {
  const text = '</script><script>alert(1)</script>\u2028\u2029';
  const serialized = jsonForHtml({ name: text });
  assert.ok(!serialized.includes('<'));
  assert.equal(JSON.parse(serialized).name, text);
});
test('explicit country URLs set a matching anonymous API preference without shared caching', async () => {
  const app = express().use((req, res, next) => { req.country = uganda; next(); }).use(seoContext).get('/products', (_req, res) => res.json(res.locals.seo)).use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
  const result = await request(app).get('/products?country=UG').expect(200);
  assert.equal(result.body.canonical, `${SITE_URL}/products?country=UG`);
  assert.match(result.headers['set-cookie'][0], /^cm_country=UG;/);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  for (const query of ['country=ZZ','country=ug','country=UG&country=UG']) await request(app).get('/products?' + query).expect(404);
  const filtered = await request(app).get('/products?sort=price').expect(200);
  assert.match(filtered.headers['x-robots-tag'], /noindex/);
});

test('public marketplace metadata emphasizes actual shopping, sellers, promoter commissions and assistant without keyword stuffing', () => {
  const home = pageSeo(page('/'));
  const promoters = pageSeo(page('/promoters'));
  const sellers = pageSeo(page('/sellers'));
  assert.match(home.title, /Shop Products, Sell & Earn as a Promoter/);
  assert.match(home.description, /eligible products for commissions without owning stock/i);
  assert.match(promoters.description, /qualifying sales/i);
  assert.match(sellers.description, /verified Classic Mart sellers/i);
  assert.equal(home.canonical, SITE_URL + '/');
  assert.ok(!home.noindex);
  const parsed = JSON.parse(home.jsonLd);
  assert.ok(parsed['@graph'].some(item => item['@type'] === 'Organization' && item.url === SITE_URL + '/'));
  assert.ok(parsed['@graph'].some(item => item['@type'] === 'WebSite' && item.url === SITE_URL + '/'));
  assert.ok(!home.description.includes('guaranteed income'));
  assert.ok(!home.description.includes('best cheapest'));
  assert.equal(canonicalUrl('/sitemap.xml'), SITE_URL + '/sitemap.xml');
});
