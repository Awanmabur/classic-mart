import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
const { createSmsService } = await import('../src/services/sms.js');
const input = { phone: '+256700000000', name: 'Test recipient', code: '583726' };
const configuration = { mode: 'yoola', yoolaApiKey: 'private-fixture-api-key', yoolaSenderId: '' };

function client(response, extra = {}) {
  const events = [], requests = [];
  const service = createSmsService({ configuration: { ...configuration, ...extra },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : Response.json(response);
    },
    log: { warn: (fields, message) => events.push({ fields, message }) },
  });
  return { service, events, requests };
}

test('Yoola HTTP-200 rejections retain actionable categories without leaking provider data or replaying', async () => {
  const cases = [
    [{ status: 'error', error_code: 'INVALID_API_KEY', message: 'private-fixture-api-key 583726 +256700000000' }, 'SMS_AUTH_FAILED', 'authentication'],
    [{ status: 'error', message: 'Your API key is invalid: private-fixture-api-key' }, 'SMS_AUTH_FAILED', 'authentication'],
    [{ status: 'error', error: { code: 'insufficient_balance', message: 'secret account credit data' } }, 'SMS_CREDIT_REQUIRED', 'credit'],
    [{ status: 'failed', message: 'Insufficient SMS credits for request 583726' }, 'SMS_CREDIT_REQUIRED', 'credit'],
    [{ status: 'error', code: 'sender_not_approved', message: 'secret sender account' }, 'SMS_SENDER_REJECTED', 'sender'],
    [{ status: 'error', error: 'Sender ID is not approved for +256700000000' }, 'SMS_SENDER_REJECTED', 'sender'],
    [{ status: 'error', code: 'unsupported_network' }, 'SMS_RECIPIENT_REJECTED', 'recipient'],
    [{ status: 'failed', message: 'Invalid phone number +256700000000' }, 'SMS_RECIPIENT_REJECTED', 'recipient'],
    [{ status: 'error', code: 'rate_limit_exceeded' }, 'SMS_PROVIDER_RATE_LIMITED', 'rate_limit'],
    [{ status: 'error', message: 'Too many requests' }, 'SMS_PROVIDER_RATE_LIMITED', 'rate_limit'],
    [{ status: 'unknown', message_id: 'id', message: 'private-fixture-api-key 583726 +256700000000' }, 'SMS_DELIVERY_FAILED', 'rejected'],
  ];
  for (const [response, code, reason] of cases) {
    const { service, events, requests } = client(response);
    await assert.rejects(service.sendPhoneVerificationCode(input), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.details, { provider: 'yoola', operation: 'send', reason, httpStatus: 200 });
      assert.equal(error.cause, undefined, 'Raw provider errors must not become error causes.');
      assert.doesNotMatch(JSON.stringify(error), /private-fixture-api-key|583726|256700000000|secret sender|secret account/);
      return true;
    });
    assert.equal(requests.length, 1, 'A rejected or ambiguous billed request is never automatically replayed.');
    assert.deepEqual(events, [{ fields: { provider: 'yoola', operation: 'send', reason, httpStatus: 200, errorCode: code },
      message: 'SMS provider request failed' }]);
    assert.doesNotMatch(JSON.stringify(events), /private-fixture-api-key|583726|256700000000/);
  }
});

test('known HTTP failures remain actionable with HTML or malformed provider bodies', async () => {
  for (const [status, code] of [[401, 'SMS_AUTH_FAILED'], [403, 'SMS_AUTH_FAILED'], [402, 'SMS_CREDIT_REQUIRED'], [429, 'SMS_PROVIDER_RATE_LIMITED']]) {
    const { service, requests } = client(() => new Response('private-fixture-api-key 583726', { status }));
    await assert.rejects(service.verifySmsConfiguration(), { code });
    assert.equal(requests.length, 1);
  }
});

test('configured sender follows the official optional sender schema and invalid senders never contact Yoola', async () => {
  const { service, requests } = client({ status: ' success ', message_id: 'YL-fixture' }, { yoolaSenderId: 'ClassicMart' });
  assert.equal((await service.sendPhoneVerificationCode(input)).accepted, true);
  assert.deepEqual(JSON.parse(requests[0].options.body), { api_key: 'private-fixture-api-key', phone: '256700000000',
    message: 'Classic Mart verification code: 583726. It expires in 10 minutes. Do not share this code.', sender: 'ClassicMart' });
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.cache, 'no-store');
  for (const sender of ['Unapproved Space', 'MoreThan11Letters', 'brand\nname', 'brand/name']) {
    const invalid = client({ status: 'success', message_id: 'id' }, { yoolaSenderId: sender });
    await assert.rejects(invalid.service.sendPhoneVerificationCode(input), { code: 'SMS_SENDER_NOT_CONFIGURED' });
    assert.equal(invalid.requests.length, 0);
    assert.equal(invalid.events.length, 0);
  }
});

test('MFA sends an explicit five-minute sign-in/security message and never equates acceptance with verification', async () => {
  const { service, requests } = client({ status: 'accepted', message_id: 'YL-mfa-fixture' });
  const result = await service.sendMfaVerificationCode(input);
  assert.equal(result.accepted, true);
  assert.equal(result.delivered, false);
  assert.equal(result.developmentCode, undefined);
  const sent = JSON.parse(requests[0].options.body);
  assert.equal(sent.message, 'Classic Mart sign-in/security code: 583726. It expires in 5 minutes. Do not share this code.');
  assert.equal(sent.phone, '256700000000');
  for (const expiresInMinutes of [0, 11, 5.5, '5', Infinity]) {
    await assert.rejects(service.sendMfaVerificationCode({ ...input, expiresInMinutes }), { code: 'SMS_INVALID_REQUEST' });
  }
  assert.equal(requests.length, 1, 'Invalid MFA expiry cannot send a second code.');
  const development = client({}, { mode: 'log' });
  assert.deepEqual(await development.service.sendMfaVerificationCode(input), { delivered: false, developmentCode: '583726' });
  assert.equal(development.requests.length, 0);
});

test('timeouts and known connection failures stay private and are never retried', async () => {
  for (const [error, code, reason] of [
    [new DOMException('private-fixture-api-key', 'TimeoutError'), 'SMS_REQUEST_TIMEOUT', 'timeout'],
    [Object.assign(new Error('583726 +256700000000'), { cause: { code: 'ENOTFOUND' } }), 'SMS_NETWORK_FAILED', 'network'],
    [Object.assign(new Error('private-fixture-api-key'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), 'SMS_REQUEST_TIMEOUT', 'timeout'],
  ]) {
    const { service, requests, events } = client(error);
    await assert.rejects(service.sendMfaVerificationCode(input), failure => {
      assert.equal(failure.code, code);
      assert.equal(failure.details.reason, reason);
      assert.doesNotMatch(failure.message, /private-fixture-api-key|583726|256700000000/);
      assert.equal(failure.cause, undefined);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(events), /private-fixture-api-key|583726|256700000000/);
  }
});

test('malformed acknowledgements cannot make MFA delivery successful and log only fixed diagnostic categories', async () => {
  for (const response of [{ status: 'success' }, { status: 'success', message_id: 123 }, { status: 'success', message_id: 'id\n583726' },
    { status: 'success', message_id: 'id', success: false }, { status: 'success', message_id: 'id', error: 'private-fixture-api-key' }]) {
    const { service, events, requests } = client(response);
    await assert.rejects(service.sendMfaVerificationCode(input), { code: 'SMS_DELIVERY_FAILED' });
    assert.equal(requests.length, 1);
    assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(events), /private-fixture-api-key|583726/);
  }
});

test('the SMS verification CLI prints actionable safe help for HTTP-200 auth rejection and exits nonzero', () => {
  const fixtureUrl = new URL('../scripts/verify-sms.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', [
    'globalThis.fetch = async () => Response.json({status:"error", error_code:"INVALID_API_KEY", message:"private-fixture-api-key 583726 +256700000000"});',
    `await import(process.argv[1]);`,
  ].join('\n'), fixtureUrl], { cwd: process.cwd(), encoding: 'utf8', env: {
    ...process.env, NODE_ENV: 'test', SMS_MODE: 'yoola', YOOLA_API_KEY: 'private-fixture-api-key', YOOLA_SENDER_ID: '',
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SMS_AUTH_FAILED/);
  assert.match(result.stderr, /Check the API key and account access/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-fixture-api-key|583726|256700000000/);
});
