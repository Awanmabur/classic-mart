import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
const { createSmsService } = await import('../src/services/sms.js');
const configuration = { mode: 'yoola', yoolaApiKey: 'private-delivery-fixture-key', yoolaSenderId: '' };
const recipient = { phone: '+256700000000', code: '583726', name: 'Fixture customer' };

function fixture(response) {
  const requests = [], events = [];
  const service = createSmsService({ configuration, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(response);
  }, log: { info: (fields, message) => events.push({ fields, message }), warn() {} } });
  return { service, requests, events };
}

test('delivery reports use the separate reference endpoint and send no recipient, message or OTP', async () => {
  const { service, requests } = fixture({ status: 'success', delivery_status: 'delivered' });
  assert.deepEqual(await service.getSmsDeliveryReport('YL-reference'), { state: 'delivered', delivered: true });
  assert.equal(requests.length, 1);
  const [{ url, options }] = requests;
  assert.equal(url, 'https://yoolasms.com/api/v1/delivery_report');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), { api_key: configuration.yoolaApiKey, message_id: 'YL-reference' });
});

test('a successful API acknowledgement without a delivery field never counts as delivered', async () => {
  for (const response of [{ status: 'success' }, { status: 'accepted' },
    { status: 'success', delivery_status: 'private unknown provider text' },
    { status: 'success', data: { delivery_status: 'delivered' } },
    { status: 'success', delivery_status: 'success' },
    { status: 'success', delivery_status: 'delivered', message_status: 'failed' },
    { status: 'success', delivery_status: 'delivered', delivery: 'unknown' },
    { status: 'success', delivery_status: true }]) {
    const { service } = fixture(response);
    assert.deepEqual(await service.getSmsDeliveryReport('YL-reference'), { state: 'unknown', delivered: false });
  }
});

test('only explicit reference delivery fields and recognized states classify a delivery receipt', async () => {
  for (const field of ['delivery_status', 'delivery', 'message_status']) {
    for (const [values, state] of [[['delivered'], 'delivered'],
      [['failed', 'undelivered', 'rejected'], 'failed'], [['pending', 'queued', 'sent', 'processing'], 'pending']]) {
      for (const value of values) {
        const { service } = fixture({ status: 'success', [field]: ` ${value.toUpperCase()} ` });
        assert.deepEqual(await service.getSmsDeliveryReport('YL-reference'), { state, delivered: state === 'delivered' });
      }
    }
  }
});

test('bad receipt references never contact Yoola and delivery lookup retains explicit rejection guards', async () => {
  const { service, requests } = fixture({ status: 'success', delivery_status: 'delivered' });
  for (const value of [null, 123, '', ' ', ' id', 'id\nprivate', 'x'.repeat(201)]) {
    await assert.rejects(service.getSmsDeliveryReport(value), { code: 'SMS_INVALID_RECEIPT' });
  }
  assert.equal(requests.length, 0);
  const rejected = fixture({ status: 'error', error_code: 'INVALID_API_KEY', delivery_status: 'delivered' });
  await assert.rejects(rejected.service.getSmsDeliveryReport('YL-reference'), { code: 'SMS_AUTH_FAILED' });
  assert.equal(rejected.requests.length, 1);
});

test('explicit receipt inspection reveals only allowlisted field paths/types and fixed status literals', async () => {
  const { service } = fixture({ status: 'success', data: {
    message_id: 508436, delivery_status: 'SENT', delivered: false,
    phone: recipient.phone, api_key: configuration.yoolaApiKey, message: `Private code ${recipient.code}`,
    private_customer_identifier: { status: 'delivered' },
  } });
  const result = await service.getSmsDeliveryReport('508436', { inspect: true });
  assert.equal(result.state, 'unknown', 'Inspection never promotes an unrecognized schema to delivery.');
  const entries = result.reportShape.entries;
  assert.ok(entries.some(entry => entry.path === '$.data.delivery_status' && entry.recognizedStatus === 'sent'));
  assert.ok(entries.some(entry => entry.path === '$.data.message_id' && entry.type === 'number'));
  assert.ok(entries.some(entry => entry.path === '$.data.delivered' && entry.reportedBoolean === false));
  assert.doesNotMatch(JSON.stringify(result.reportShape), /508436|583726|256700000000|private-delivery-fixture-key|private_customer_identifier|Private code/);
  const nested = fixture({ status: 'success', data: { report: { report: { report: { report: { status: 'delivered' } } } } } });
  const limited = await nested.service.getSmsDeliveryReport('YL-reference', { inspect: true });
  assert.equal(limited.reportShape.truncated, true);
  assert.ok(limited.reportShape.entries.length <= 60);
});

test('accepted-send diagnostics provide a usable receipt without exposing recipient, OTP, key or provider text', async () => {
  for (const [id, logged] of [['YL-reference', 'YL-reference'], [123, '123'], [null, undefined],
    [configuration.yoolaApiKey, undefined], [`YL-${recipient.code}`, undefined],
    [recipient.phone.slice(1), undefined], ['private provider text', undefined]]) {
    const { service, requests, events } = fixture({ status: 'success', message_id: id, message: 'private provider text' });
    const result = await service.sendPhoneVerificationCode(recipient);
    assert.equal(result.accepted, true);
    assert.equal(result.delivered, false);
    assert.equal(requests.length, 1, 'Logging never adds a send or a status request.');
    assert.equal(events.length, 1);
    assert.equal(events[0].fields.providerMessageId, logged);
    assert.equal(events[0].fields.deliveryStatus, 'unconfirmed');
    assert.equal(events[0].fields.receiptAvailable, id != null);
    assert.doesNotMatch(JSON.stringify(events), /private-delivery-fixture-key|583726|256700000000|private provider text|Fixture customer/);
  }
});

function cli(response, args = ['--message-id', 'YL-reference']) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://yoolasms.com/api/v1/delivery_report') throw new Error('UNEXPECTED_ENDPOINT');
      const body = JSON.parse(options.body);
      if (Object.keys(body).sort().join(',') !== 'api_key,message_id') throw new Error('UNEXPECTED_SEND');
      return Response.json(${JSON.stringify(response)});
    };
    await import('./scripts/verify-sms.js');
  `, 'sms-delivery-fixture', ...args], { cwd: process.cwd(), encoding: 'utf8', env: {
    ...process.env, NODE_ENV: 'test', SMS_MODE: 'yoola', YOOLA_API_KEY: configuration.yoolaApiKey, YOOLA_SENDER_ID: '',
  } });
}

test('the read-only CLI distinguishes delivered, failed, pending and unknown without leaking raw data', () => {
  for (const [response, state, status] of [
    [{ status: 'success', delivery_status: 'delivered' }, 'delivered', 0],
    [{ status: 'success', delivery_status: 'failed' }, 'failed', 1],
    [{ status: 'success', delivery_status: 'queued' }, 'pending', 3],
    [{ status: 'success', message: 'private provider text 583726' }, 'unknown', 3],
  ]) {
    const result = cli(response);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout, new RegExp(`Yoola delivery report: ${state}\\.`));
    assert.match(result.stdout, /No SMS was sent/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-delivery-fixture-key|583726|256700000000|private provider text/);
  }
  const inspected = cli({ status: 'success', data: { delivery_status: 'sent', phone: recipient.phone,
    api_key: configuration.yoolaApiKey, message: recipient.code } }, ['--message-id', '508436', '--inspect']);
  assert.equal(inspected.status, 3);
  assert.match(inspected.stdout, /Redacted delivery fields:/);
  assert.match(inspected.stdout, /"path":"\$\.data\.delivery_status","type":"string","recognizedStatus":"sent"/);
  assert.doesNotMatch(inspected.stdout + inspected.stderr, /private-delivery-fixture-key|583726|256700000000/);
  for (const args of [['--message-id'], ['--unknown'], ['--message-id', 'id', '--send'],
    ['--message-id', 'MESSAGE_ID'], ['--message-id', 'PROVIDER_MESSAGE_ID'],
    ['--message-id', 'MESSAGE_ID_FROM_YOOLA_HISTORY']]) {
    const result = cli({}, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_ENDPOINT|UNEXPECTED_SEND/);
  }
});
