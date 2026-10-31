import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { canonicalHost } from '../src/middleware/canonical-host.js';

const app = () => express().use(canonicalHost({ origin: 'https://classic-mart.com', enabled: true })).use((_req, res) => res.sendStatus(200));
test('www redirects to configured HTTPS apex and preserves country/product URLs', async () => {
  const response = await request(app()).get('/products/prd_one?country=UG').set('Host', 'www.classic-mart.com').expect(308);
  assert.equal(response.headers.location, 'https://classic-mart.com/products/prd_one?country=UG');
});
test('host headers cannot select a redirect destination and mutations are not redirected', async () => {
  await request(app()).get('/products').set('Host', 'classic-mart.com').set('X-Forwarded-Host', 'attacker.invalid').expect(200);
  await request(app()).get('/products').set('Host', 'attacker.invalid').expect(200);
  await request(app()).post('/checkout').set('Host', 'www.classic-mart.com').expect(200);
});
