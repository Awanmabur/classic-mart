import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = '';
process.env.CLASSIC_MART_TEST_MONGO_OVERRIDE = '';
const { createApp } = await import('../src/app.js');
const app = createApp(null);

test('anonymous guide bootstraps a private CSRF session and accepts only its valid token', async () => {
  const client = request.agent(app);
  const session = await client.get('/api/v1/ai/guide/session').expect(200);
  assert.ok(session.body.csrfToken.length >= 32);
  assert.match(session.headers['cache-control'], /private/);
  assert.match(session.headers['cache-control'], /no-store/);
  assert.match(session.headers['x-robots-tag'], /noindex/);
  assert.equal(session.body.country, 'UG');
  await client.post('/api/v1/ai/guide').send({ message: 'Where can I change my password?' }).expect(403);
  const response = await client.post('/api/v1/ai/guide').set('X-CSRF-Token', session.body.csrfToken).send({ message: 'Where can I change my password?' }).expect(200);
  assert.equal(response.body.links[0].href, '/account/security');
  assert.equal(response.body.aiGenerated, false);
  assert.ok(!JSON.stringify(response.body).includes(session.body.csrfToken));
  await client.post('/api/v1/ai/guide').set('X-CSRF-Token', session.body.csrfToken).send({ message: 'x'.repeat(2001) }).expect(422);
  const other = request.agent(app);
  await other.post('/api/v1/ai/guide').set('X-CSRF-Token', session.body.csrfToken).send({ message: 'Hello' }).expect(403);
});
