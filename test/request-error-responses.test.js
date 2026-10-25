import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import mongoose from 'mongoose';
import { ClientOfflineError, ClientClosedError, SocketClosedUnexpectedlyError, TimeoutError } from 'redis';
import request from 'supertest';
import { errorHandler } from '../src/middleware/errors.js';
import { requestContext } from '../src/middleware/request.js';
import { createHttpLogging, requestErrorLogged } from '../src/middleware/http-logging.js';
import { logger } from '../src/config/logger.js';
import { safeLogFields } from '../src/core/logging.js';

function parserApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
  app.use(requestContext);
  app.use(express.json({ limit: '100b' }));
  app.use(express.urlencoded({ extended: false, limit: '100b', parameterLimit: 2 }));
  app.post('/api/probe', (_req, res) => res.json({ accepted: true }));
  app.post('/probe', (_req, res) => res.send('accepted'));
  app.use(errorHandler);
  return app;
}

test('malformed JSON gets a private400 with its request ID and no parser/source/body contents', async () => {
  const response = await request(parserApp()).post('/api/probe').set('Content-Type', 'application/json')
    .set('X-Request-ID', 'malformed-json-fixture').send('{"private-secret":').expect(400);
  assert.equal(response.body.error.code, 'REQUEST_BODY_INVALID');
  assert.equal(response.body.error.requestId, 'malformed-json-fixture');
  assert.match(response.headers['cache-control'], /no-store/);
  assert.match(response.headers['x-robots-tag'], /noindex/);
  assert.doesNotMatch(JSON.stringify(response.body), /private-secret|SyntaxError|entity\.parse/);
});

test('body and form field limits return413 rather than an internal server error', async () => {
  const app = parserApp();
  const large = await request(app).post('/api/probe').send({ privateValue: 'x'.repeat(150) }).expect(413);
  assert.equal(large.body.error.code, 'REQUEST_BODY_TOO_LARGE');
  const form = await request(app).post('/api/probe').type('form').send('one=1&two=2&three=3').expect(413);
  assert.equal(form.body.error.code, 'REQUEST_BODY_TOO_LARGE');
});

test('unsupported JSON character sets return415 and HTML failures can render before view/session locals', async () => {
  const app = parserApp();
  const encoding = await request(app).post('/api/probe').set('Content-Type', 'application/json; charset=iso-8859-1').send('{}').expect(415);
  assert.equal(encoding.body.error.code, 'REQUEST_ENCODING_UNSUPPORTED');
  const html = await request(app).post('/probe').set('Content-Type', 'application/json').set('Accept', 'text/html').send('{invalid').expect(400);
  assert.match(html.text, /REQUEST BODY INVALID/);
  assert.doesNotMatch(html.text, /\{invalid|SyntaxError/);
});

test('an error after headers were sent closes once without another render, header write or default raw-error handler', t => {
  const error = new Error('Stream interrupted');
  const diagnostics = [];
  t.mock.method(logger, 'error', (...args) => diagnostics.push(args));
  let closed = 0;
  const req = {};
  const response = { headersSent: true, destroy() { closed++; }, set() { assert.fail('Headers are already committed.'); }, status() { assert.fail('A second response must not be started.'); } };
  errorHandler(error, req, response, () => assert.fail('The default handler must not print the raw error.'));
  assert.equal(closed, 1);
  assert.equal(req[requestErrorLogged], true);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0][0].errorCode, 'RESPONSE_INTERRUPTED');
});

test('real Mongo selection/network failures before session locals return safe503 with Retry-After, one diagnostic and their request ID', async t => {
  const diagnostics = [];
  t.mock.method(logger, 'error', (...args) => diagnostics.push(args));
  const secret = 'private-database-credential';
  const originalErrors = [
    new mongoose.mongo.MongoServerSelectionError(`getaddrinfo ENOTFOUND atlas-private.mongodb.net mongodb://user:${secret}@atlas-private.mongodb.net/app`, { error: null }),
    new mongoose.mongo.MongoNetworkError(`connect ECONNREFUSED mongodb://user:${secret}@127.0.0.1:27017/app`),
    new mongoose.Error.MongooseServerSelectionError(`private topology ${secret}`),
  ];
  for (const [index, original] of originalErrors.entries()) {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
    app.use(requestContext);
    app.use(createHttpLogging({ log: { error() { assert.fail('Failure already has a structured diagnostic.'); }, warn() { assert.fail('Failure already has a structured diagnostic.'); } } }));
    // A session-store callback fails before loadUser/viewLocals execute.
    app.use((_req, _res, next) => next(original));
    app.use(errorHandler);
    for (const accept of ['application/json', 'text/html']) {
      const response = await request(app).get('/account/security').set('Accept', accept).set('X-Request-ID', `mongo-outage-${index}`).expect(503);
      assert.equal(response.headers['retry-after'], '30');
      assert.match(response.headers['cache-control'], /no-store/);
      assert.match(response.headers['x-robots-tag'], /noindex/);
      assert.match(response.text, /cannot reach its database/);
      assert.doesNotMatch(response.text, /private-database-credential|atlas-private|mongodb:|ENOTFOUND|ECONNREFUSED|MongoServerSelectionError/);
      if (accept === 'application/json') {
        assert.equal(response.body.error.code, 'DATABASE_UNAVAILABLE');
        assert.equal(response.body.error.requestId, `mongo-outage-${index}`);
      } else assert.match(response.text, /DATABASE UNAVAILABLE/);
    }
  }
  assert.equal(diagnostics.length, 6);
  for (const [fields] of diagnostics) {
    assert.equal(fields.statusCode, 503);
    assert.equal(fields.errorCode, 'DATABASE_UNAVAILABLE');
    const logged = JSON.stringify(safeLogFields(fields, { production: true }));
    assert.doesNotMatch(logged, /private-database-credential|atlas-private|mongodb:/);
    assert.match(logged, /mongo-outage-/);
  }
});

test('an error name or message imitating Mongo does not reclassify an unrelated programming error as an outage', async t => {
  t.mock.method(logger, 'error', () => {});
  const app = express();
  app.use(requestContext);
  app.get('/api/probe', (_req, _res, next) => {
    const error = new Error('MongoServerSelectionError getaddrinfo ENOTFOUND');
    error.name = 'MongoServerSelectionError';
    next(error);
  });
  app.use(errorHandler);
  const response = await request(app).get('/api/probe').expect(500);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  assert.equal(response.headers['retry-after'], undefined);
});

test('typed Redis outages and the fail-closed shared limiter return safe503 instead of permitting protected requests', async t => {
  t.mock.method(logger, 'error', () => {});
  const limiter = new Error('Shared rate limit store is not ready.');
  limiter.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
  for (const outage of [new ClientOfflineError(), new ClientClosedError(), new SocketClosedUnexpectedlyError(), new TimeoutError('Private Redis host: redis://private-credential@host'), limiter]) {
    const app = express();
    app.use(requestContext);
    app.use((_req, _res, next) => next(outage));
    app.get('/api/protected', () => assert.fail('The unavailable security store cannot allow a protected action.'));
    app.use(errorHandler);
    const response = await request(app).get('/api/protected').expect(503);
    assert.equal(response.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(response.headers['retry-after'], '30');
    assert.doesNotMatch(response.text, /private-credential|redis:|offline|rate limit|Redis host/);
  }
});

test('a real partial HTTP failure closes the connection and records one sanitized error without an extra interruption log', async t => {
  const diagnostics = [];
  t.mock.method(logger, 'error', (...args) => diagnostics.push(args));
  const app = express();
  app.use(requestContext);
  app.use(createHttpLogging({ log: { error() { assert.fail('Failure already logged.'); }, warn() { assert.fail('Partial response failure already logged.'); } } }));
  app.get('/stream', (_req, res, next) => {
    res.write('partial');
    setImmediate(() => next(new Error('secret stream target mongodb://user:private-stream-secret@host/app')));
  });
  app.use(errorHandler);
  app.use((_error, _req, _res, _next) => assert.fail('The default handler must not receive raw stream errors.'));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    await new Promise((resolve, reject) => {
      const client = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/stream' }, response => {
        response.resume();
        response.once('aborted', resolve);
        response.once('end', () => reject(new Error('The failed partial response must not complete successfully.')));
      });
      client.once('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
    });
    assert.equal(diagnostics.length, 1);
    const fields = safeLogFields(diagnostics[0][0], { production: true });
    assert.equal(fields.errorCode, 'RESPONSE_INTERRUPTED');
    assert.doesNotMatch(JSON.stringify(fields), /private-stream-secret|mongodb:/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
