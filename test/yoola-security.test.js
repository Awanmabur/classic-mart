import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
process.env.NODE_ENV = 'test';
process.env.SMS_MODE = 'yoola';
process.env.YOOLA_API_KEY = 'yoola_test_fixture';
const { sendPhoneVerificationCode, verifySmsConfiguration } = await import('../src/services/sms.js');
const input = { phone: '+256700000000', name: 'Customer', code: '123456' };

test('Yoola uses the owner existing HTTPS JSON protocol and distinguishes acceptance from delivery', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options };
    return Response.json({ message_id: 'message-fixture', status: 'success' });
  });
  const result = await sendPhoneVerificationCode(input);
  assert.equal(request.url, 'https://yoolasms.com/api/v1/send');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), {
    api_key: 'yoola_test_fixture', phone: '256700000000',
    message: 'Classic Mart verification code: 123456. It expires in 10 minutes. Do not share this code.',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.delivered, false);
  assert.equal(result.providerId, 'message-fixture');
});

test('Yoola requires a positive acknowledgement and rejects malformed receipt metadata', async t => {
  const invalid = [
    {}, [], null, { status: 'failed', message_id: 'id' }, { status: 'scheduled', message_id: 'id' },
    { status: 'delivered', message_id: 'id' }, { status: 'success', message_id: '' },
    { status: 'success', message_id: ' ' }, { status: 'success', message_id: -1 },
    { status: 'success', message_id: 1.5 }, { status: 'success', message_id: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'success', message_id: true }, { status: 'success', message_id: {} },
    { status: 'success', errors: ['SECRET_PROVIDER_DETAIL'] },
    { status: 'success', message_id: 'x'.repeat(201) }, { status: 'success', message_id: 'id\nsecret' },
    { status: 'success', message_id: 'id', error: 'SECRET_PROVIDER_DETAIL' },
    { status: 'success', message_id: 'id', success: false },
  ];
  for (const response of invalid) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(sendPhoneVerificationCode(input), error => error.code === 'SMS_DELIVERY_FAILED' && !error.message.includes('SECRET_PROVIDER_DETAIL'));
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
  for (const status of ['success', 'accepted', 'queued', 'ok', 'SUCCESS']) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ status, message_id: 'id' }));
    const result = await sendPhoneVerificationCode(input);
    assert.equal(result.accepted, true); assert.equal(result.delivered, false);
    mock.mock.restore();
  }
});

test('explicit sending acceptance does not depend on optional string tracking metadata or verify a phone', async t => {
  for (const receipt of [{}, { message_id: null }, { message_id: 123 }, { message_id: 0 }, { message_id: Number.MAX_SAFE_INTEGER }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'success', ...receipt }));
    const result = await sendPhoneVerificationCode(input);
    assert.equal(result.accepted, true);
    assert.equal(result.delivered, false);
    assert.equal(result.developmentCode, undefined);
    assert.equal(result.providerId, receipt.message_id == null ? undefined : String(receipt.message_id));
    assert.equal(Object.hasOwn(result, 'providerId'), receipt.message_id != null, 'No identifier may be invented.');
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('Yoola account authentication probe sends no SMS and makes no unverified credit claim', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://yoolasms.com/api/v1/balance');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { api_key: 'yoola_test_fixture' });
    return Response.json({ status: 'success', arbitrary_balance_format: 'unknown' });
  });
  assert.deepEqual(await verifySmsConfiguration(), { authenticated: true, creditAvailable: null });
  assert.equal(mock.mock.callCount(), 1);
});

test('Yoola account authentication fails closed for missing or negative status', async t => {
  for (const response of [{}, { balance: 10 }, { status: 'error' }, { status: 'queued' }, { status: 'success', error: 'SECRET' }, { status: 'ok', success: false }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(verifySmsConfiguration(), { code: 'SMS_DELIVERY_FAILED' });
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});

test('Yoola rejects invalid phone numbers and codes before network access', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  for (const phone of ['0700000000', '+256700', '+256700000000123456', '+256700000000\n']) {
    await assert.rejects(sendPhoneVerificationCode({ ...input, phone }), { code: 'SMS_INVALID_REQUEST' });
  }
  for (const code of ['bad', '12345', '1234567', '123456\n']) {
    await assert.rejects(sendPhoneVerificationCode({ ...input, code }), { code: 'SMS_INVALID_REQUEST' });
  }
  assert.equal(mock.mock.callCount(), 0);
});

test('Yoola sanitizes provider errors, forbids redirects and never retries ambiguous sends', async t => {
  for (const [status, code] of [[401, 'SMS_AUTH_FAILED'], [403, 'SMS_AUTH_FAILED'], [402, 'SMS_CREDIT_REQUIRED'], [429, 'SMS_PROVIDER_RATE_LIMITED'], [302, 'SMS_DELIVERY_FAILED'], [503, 'SMS_DELIVERY_FAILED']]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response('SECRET_PROVIDER_DETAIL', { status }));
    await assert.rejects(sendPhoneVerificationCode(input), error => error.code === code && !error.message.includes('SECRET_PROVIDER_DETAIL'));
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('SECRET_PROVIDER_DETAIL 123456 yoola_test_fixture'); });
  await assert.rejects(sendPhoneVerificationCode(input), error => error.code === 'SMS_DELIVERY_FAILED' && !/SECRET|123456|yoola_test_fixture/.test(error.message));
  assert.equal(mock.mock.callCount(), 1);
});

test('Yoola bounds provider response bodies and rejects malformed JSON', async t => {
  for (const makeResponse of [
    () => new Response('not json'),
    () => new Response('x'.repeat(16_385)),
    () => new Response('{}', { headers: { 'content-length': '16385' } }),
    () => new Response(null),
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => makeResponse());
    await assert.rejects(sendPhoneVerificationCode(input), { code: 'SMS_DELIVERY_FAILED' });
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});

test('disabled Yoola or a missing key cannot contact a provider or mark delivery successful', () => {
  for (const settings of [{ SMS_MODE: 'disabled', YOOLA_API_KEY: 'configured-but-disabled' }, { SMS_MODE: 'yoola', YOOLA_API_KEY: '' }]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.fetch = () => { throw new Error('UNEXPECTED_NETWORK'); };
      const { sendPhoneVerificationCode, verifySmsConfiguration } = await import('./src/services/sms.js');
      for (const operation of [() => sendPhoneVerificationCode(${JSON.stringify(input)}), verifySmsConfiguration]) {
        try { await operation(); process.exit(2); } catch (error) {
          if (error.code !== 'SMS_NOT_CONFIGURED') throw error;
        }
      }
    `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', ...settings }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('SMS verification CLI reports account authentication without credit or delivery promises', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = async () => Response.json({ status: 'success' });
    await import('./scripts/verify-sms.js');
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', SMS_MODE: 'yoola', YOOLA_API_KEY: 'yoola_test_fixture' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Yoola authenticated/);
  assert.match(result.stdout, /Credit availability is unknown/);
  assert.match(result.stdout, /No SMS was sent/);
  assert.match(result.stdout, /delivery has not been verified/);
  assert.doesNotMatch(result.stdout, /yoola_test_fixture/);
});
