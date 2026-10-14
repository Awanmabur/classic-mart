import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createLogger } from '../src/config/logger.js';
import { maintenanceFailures, safeError, safeRequest, safeSecurityEventPath, securityEventPath } from '../src/core/logging.js';
import { createHttpLogging, requestErrorLogged } from '../src/middleware/http-logging.js';
import { securityEventExportPayload, signSecurityEvent, verifySecurityEventIntegrity, writeSecurityEvent } from '../src/services/security.js';
import { SecurityEvent } from '../src/models/index.js';

function captureLogger() {
  const records = [];
  const destination = new Writable({ write(chunk, _encoding, done) { records.push(JSON.parse(String(chunk))); done(); } });
  return { records, log: createLogger({ production: true, level: 'debug' }, destination) };
}

function request(overrides = {}) {
  return {
    id: 'request-id-123', method: 'GET', path: '/reset-password/private-reset-token',
    url: '/reset-password/private-reset-token?code=private-code',
    originalUrl: '/reset-password/private-reset-token?code=private-code',
    route: { path: '/reset-password/:token' },
    headers: { authorization: 'Bearer private-auth', cookie: 'session=private-cookie' },
    body: { email: 'private@example.test', password: 'private-password' },
    ...overrides,
  };
}

function complete(middleware, req, statusCode = 200, { interrupted = false } = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  let nextCalls = 0;
  middleware(req, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  if (!interrupted) response.emit('finish');
  response.emit('close');
}

test('production structured logs whitelist HTTP and Error diagnostics and redact nested credentials', () => {
  const { log, records } = captureLogger();
  const error = new Error('duplicate private@example.test password=private-password mongodb://user:private-db@host/database');
  error.code = 11000;
  error.providerPayload = { token: 'private-provider-token', user: { email: 'private@example.test' } };
  error.cause = new Error('Bearer private-cause-token');
  log.error({ req: request(), res: { statusCode: 500, headers: { 'set-cookie': 'private-set-cookie' } }, err: error, nested: { layers: [{ authorization: 'private-header', deeper: { passwordHash: 'private-hash', apiKey: 'private-key' } }] } }, 'Request failed');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].req, { id: 'request-id-123', method: 'GET', route: '/reset-password/:token' });
  assert.deepEqual(records[0].res, { statusCode: 500 });
  assert.equal(records[0].err.type, 'Error');
  assert.equal(records[0].err.code, 11000);
  assert.match(records[0].err.stack, /logging-production\.test\.js:\d+:\d+/);
  assert.equal(records[0].err.message, undefined);
  assert.equal(records[0].err.providerPayload, undefined);
  assert.doesNotMatch(JSON.stringify(records), /private-|private@|mongodb:\/\//);
});

test('ordinary successful HTTP, probes and routine 4xx are quiet by default; 5xx and interruptions remain visible', () => {
  const { log, records } = captureLogger();
  const middleware = createHttpLogging({ log, accessLogs: false });
  for (const path of ['/', '/health/live', '/assets/app.css']) complete(middleware, request({ path }), 200);
  for (const status of [400, 401, 403, 404, 422, 429]) complete(middleware, request(), status);
  assert.equal(records.length, 0);
  complete(middleware, request(), 503);
  complete(middleware, request(), 200, { interrupted: true });
  assert.deepEqual(records.map((record) => record.level), [50, 40]);
  assert.equal(records[0].route, '/reset-password/:token');
  assert.equal(records[0].statusCode, 503);
  assert.doesNotMatch(JSON.stringify(records), /private-/);
});

test('Pino cannot promote an implicit raw Error message into the log message', () => {
  const { log, records } = captureLogger();
  const error = new Error('private-reset-token private@example.test');
  log.error(error);
  log.error({ err: error });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.msg), ['Error diagnostic', 'Error diagnostic']);
  assert.doesNotMatch(JSON.stringify(records), /private-reset-token|private@example/);
});

test('HTTP fallback avoids duplicate handled errors; opt-in access logs still withhold health/static successes and all raw targets', () => {
  const { log, records } = captureLogger();
  const middleware = createHttpLogging({ log, accessLogs: true });
  const handled = request();
  handled[requestErrorLogged] = true;
  complete(middleware, handled, 500);
  complete(middleware, request({ path: '/health/ready' }), 200);
  complete(middleware, request({ path: '/assets/app.css' }), 200);
  for (const path of ['/favicon.png', '/sw.js', '/styles.css', '/script.js', '/manifest.webmanifest']) complete(middleware, request({ path }), 200);
  assert.equal(records.length, 0);
  complete(middleware, request(), 200);
  complete(middleware, request({ route: undefined }), 404);
  assert.deepEqual(records.map((record) => record.level), [30, 40]);
  assert.equal(records[1].route, '[unmatched]');
  assert.doesNotMatch(JSON.stringify(records), /private-|authorization|cookie|body|originalUrl/);
});

test('security events sign route templates and withhold old raw paths from SIEM export', async (context) => {
  context.mock.method(SecurityEvent, 'create', async (event) => event);
  const event = await writeSecurityEvent(request({ ip: '127.0.0.1', get: () => '' }), 'authentication.failure', { category: 'authentication', result: 'failure' });
  assert.equal(event.path, 'route:/reset-password/:token');
  assert.equal(verifySecurityEventIntegrity(event), true);
  assert.equal(securityEventExportPayload(event).path, 'route:/reset-password/:token');
  const legacy = { ...event, path: '/reset-password/private-reset-token?code=private-code' };
  legacy.integrity = signSecurityEvent(legacy);
  assert.equal(verifySecurityEventIntegrity(legacy), true);
  assert.equal(securityEventExportPayload(legacy).path, '[unmatched]');
  assert.equal(verifySecurityEventIntegrity(legacy), true, 'export leaves signed evidence unchanged');
  assert.doesNotMatch(JSON.stringify(securityEventExportPayload(legacy)), /private-/);
  assert.equal(securityEventPath(request({ route: undefined })), '[unmatched]');
  assert.equal(safeSecurityEventPath('/raw-token-path'), '[unmatched]');
});

test('non-Error rejections and arbitrary Error properties cannot leak secrets; partial maintenance failures remain visible', () => {
  assert.deepEqual(safeError('private-rejection'), { type: 'NonErrorRejection' });
  assert.deepEqual(safeRequest(request({ route: undefined })).route, '[unmatched]');
  assert.deepEqual(maintenanceFailures({ alerts: { checked: 100, triggered: 0, passCompleted: true }, siem: { sent: 0, failed: 0, dead: 0 } }), {});
  assert.deepEqual(maintenanceFailures({ notifications: { processed: 10, failed: 2 }, stage10: { jobs: { failed: 1, exhausted: 3 } }, invariants: { critical: 1, high: 2, scanToken: 'private-scan-token' } }), { 'notifications.failed': 2, 'stage10.jobs.failed': 1, 'stage10.jobs.exhausted': 3, 'invariants.critical': 1, 'invariants.high': 2 });
});
