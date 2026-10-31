import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { requestWithQuery } from '../src/core/request-scope.js';

test('scoped queries preserve a real Express request and its server authority without mutating the original query', async () => {
  const app = express();
  app.use(express.json());
  app.post('/source', (req, res) => {
    req.user = { publicId: 'current-staff' };
    req.session = { tokenVersion: 7 };
    req.sessionID = 'current-session';
    req.device = { publicId: 'current-device' };
    Object.defineProperty(req, 'requiredOperationalWorkspace', { value: 'admin' });
    const original = req.query;
    const scoped = requestWithQuery(req, { country: 'UG' });
    assert.equal(scoped.query.country, 'UG');
    assert.equal(scoped.query.search, 'saved source');
    assert.equal(req.query.country, 'KE');
    assert.deepEqual(req.query, original);
    assert.notEqual(scoped.query, original);
    assert.equal(scoped.user, req.user);
    assert.equal(scoped.session, req.session);
    assert.equal(scoped.sessionID, req.sessionID);
    assert.equal(scoped.device, req.device);
    assert.equal(scoped.requiredOperationalWorkspace, 'admin');
    assert.equal(scoped.get('x-source-check'), 'current-request');
    assert.equal(Object.getPrototypeOf(scoped), req);
    res.json({ country: scoped.query.country, workspace: scoped.requiredOperationalWorkspace });
  });
  const response = await request(app).post('/source?country=KE&search=saved%20source&requiredOperationalWorkspace=finance')
    .set('x-source-check', 'current-request').send({ requiredOperationalWorkspace: 'moderation' }).expect(200);
  assert.deepEqual(response.body, { country: 'UG', workspace: 'admin' });
});

test('scoping a plain trusted core request retains non-enumerable session context', () => {
  const source = { query: { country: 'KE', record: 'saved-record' }, user: { publicId: 'trusted-core' } };
  Object.defineProperties(source, { sessionID: { value: 'trusted-session' }, device: { value: { publicId: 'trusted-device' } },
    requiredOperationalWorkspace: { value: 'admin' } });
  const scoped = requestWithQuery(source, { country: 'UG' });
  assert.equal(scoped.sessionID, source.sessionID);
  assert.equal(scoped.device, source.device);
  assert.equal(scoped.requiredOperationalWorkspace, 'admin');
  assert.deepEqual(scoped.query, { country: 'UG', record: 'saved-record' });
  assert.deepEqual(source.query, { country: 'KE', record: 'saved-record' });
});
