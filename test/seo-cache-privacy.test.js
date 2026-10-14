import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = '';
process.env.CLASSIC_MART_TEST_MONGO_OVERRIDE = '';
const { createApp } = await import('../src/app.js');
const app = createApp(null);
const assertPrivate = response => {
  const directives = new Set(String(response.headers['cache-control'] || '').toLowerCase().split(/,\s*/));
  assert.ok(directives.has('private') && directives.has('no-store'),'Session HTML must be private and no-store.');
  assert.equal(directives.has('public'),false);
};

test('public catalogue cache varies on all market preference inputs', async () => {
  for (const path of ['/products', '/categories', '/sellers', '/press']) {
    const response = await request(app).get(path).expect(200);
    const vary = String(response.headers.vary || '').toLowerCase().split(/,\s*/);
    assert.ok(vary.includes('cookie'), path);
    assert.ok(vary.includes('cf-ipcountry'), path);
    assertPrivate(response);
  }
});

test('explicit market preference and error responses cannot become shared cached pages', async () => {
  const country = await request(app).get('/products?country=UG').expect(200);
  assert.match(country.headers['set-cookie'][0], /^cm_country=UG;/);
  assertPrivate(country);
  const missing = await request(app).get('/products/prd_absent_publication').expect(404);
  assertPrivate(missing);
  assert.match(missing.headers['x-robots-tag'], /noindex/);
});
