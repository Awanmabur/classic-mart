import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { publicCache } from '../src/routes/public.js';

function probe({ authenticated = false, cookies = false, initialNoStore = false } = {}) {
  const app = express();
  app.get('/probe', (req, res) => {
    if (authenticated) req.user = { publicId: 'usr_1', name: 'Private shopper' };
    if (cookies) res.cookie('sid', 'opaque');
    if (initialNoStore) res.set('Cache-Control', 'private, no-store');
    publicCache(res);
    res.status(200).type('html').send('<p>Marketplace</p>');
  });
  return app;
}

test('signed-in marketplace HTML is private even on normally public routes', async () => {
  const response = await request(probe({ authenticated: true })).get('/probe').expect(200);
  assert.match(response.headers['cache-control'], /private/);
  assert.match(response.headers['cache-control'], /no-store/);
  assert.match(response.headers.vary, /Cookie/);
  assert.match(response.headers.vary, /CF-IPCountry/);
});

test('guest marketplace HTML keeps a short public cache without an auth identity', async () => {
  const response = await request(probe()).get('/probe').expect(200);
  assert.match(response.headers['cache-control'], /public/);
  assert.match(response.headers['cache-control'], /max-age=10/);
});

test('response setting a session cookie is never promoted to shared public caching', async () => {
  const response = await request(probe({ cookies: true })).get('/probe').expect(200);
  assert.ok(!response.headers['cache-control']?.includes('public'));
});

test('explicit private no-store cannot be overwritten by public cache helper', async () => {
  const response = await request(probe({ initialNoStore: true })).get('/probe').expect(200);
  assert.match(response.headers['cache-control'], /no-store/);
  assert.ok(!response.headers['cache-control']?.includes('public'));
});
