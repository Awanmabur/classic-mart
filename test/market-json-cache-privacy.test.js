import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { noStoreMarketJson } from '../src/middleware/market-json-cache.js';

test('anonymous country selection cannot reach a shared cache', async () => {
  const app = express().get('/market', (_req, res) => noStoreMarketJson(res).json({
    country: 'UG', currency: 'UGX', items: [],
  }));
  const response = await request(app).get('/market').set('Cookie', 'cm_country=UG').expect(200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.match(response.headers.vary, /Cookie/);
  assert.match(response.headers.vary, /CF-IPCountry/);
  assert.equal(response.body.country, 'UG');
});

test('all country and session-sensitive storefront GET APIs use no-store', () => {
  const route = readFileSync(new URL('../src/routes/storefront.js', import.meta.url), 'utf8');
  const endpoints = [
    '/api/v1/storefront/navigation',
    '/api/v1/storefront/catalogue',
    '/api/v1/storefront/search',
    '/api/v1/storefront/products/:productId',
    '/api/v1/storefront/sellers',
    '/api/v1/storefront/sellers/:slug',
    '/api/v1/storefront/promoters',
    '/api/v1/storefront/promoters/:id',
    '/api/v1/storefront/state',
    '/api/v1/storefront/autocomplete',
    '/api/v1/storefront/products/:productId/questions',
  ];
  for (const endpoint of endpoints) {
    const start = route.indexOf("'"+endpoint+"'");
    assert.ok(start !== -1, 'missing '+endpoint);
    const next = route.indexOf('router.', start + endpoint.length);
    const section = route.slice(start, next < 0 ? undefined : next);
    assert.match(section, /noStoreMarketJson\(response\)/, endpoint+' must not use a shared cache');
  }
  assert.doesNotMatch(route, /['"]public, max-age=/,
    'No country-sensitive dynamic storefront API response may be shared cached');
});
