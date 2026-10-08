import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.SMS_MODE = 'esms';
process.env.ESMS_API_KEY = 'esms_test_fixture';
process.env.ESMS_SENDER_ID = 'ClassicMart';
const { sendPhoneVerificationCode, verifySmsConfiguration } = await import('../src/services/sms.js');
const input = { phone: '+256700000000', name: 'Customer', code: '123456' };

test('eSMS uses documented HTTPS bearer protocol and distinguishes acceptance from delivery', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options };
    return Response.json({ id: 'message-fixture', status: 'submitted' });
  });
  const result = await sendPhoneVerificationCode(input);
  assert.equal(request.url, 'https://sms.esmsafrica.io/api/messages/send');
  assert.equal(request.options.headers.Authorization, 'Bearer esms_test_fixture');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), {to:input.phone,text:'Classic Mart verification code: 123456. It expires in 10 minutes. Do not share this code.',sender_id:'ClassicMart'});
  assert.equal(result.accepted, true);
  assert.equal(result.delivered, false);
});

test('eSMS rejects failed, malformed and nonaccepted responses without exposing secrets or retrying', async t => {
  for (const response of [{status:'failed',id:'id'},{status:'scheduled',id:'id'},{status:'submitted'},{status:'unknown',id:'id'}]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(sendPhoneVerificationCode(input), {code:'SMS_DELIVERY_FAILED'});
    assert.equal(mock.mock.callCount(),1);
    mock.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => {throw new Error('SECRET_PROVIDER_DETAIL');});
  await assert.rejects(sendPhoneVerificationCode(input), e => e.code==='SMS_DELIVERY_FAILED'&&!e.message.includes('SECRET_PROVIDER_DETAIL'));
});

test('eSMS balance verification sends no message and validates its response', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url,'https://sms.esmsafrica.io/api/balance');
    assert.equal(options.method,'GET');
    assert.equal(options.body,undefined);
    return Response.json({balance:10,currency:'UGX'});
  });
  assert.deepEqual(await verifySmsConfiguration(),{authenticated:true,creditAvailable:true});
});

test('eSMS rejects invalid phone numbers and codes before network access', async t => {
  const mock = t.mock.method(globalThis,'fetch',async()=>{throw new Error('must not call');});
  await assert.rejects(sendPhoneVerificationCode({...input,phone:'0700000000'}),{code:'SMS_INVALID_REQUEST'});
  await assert.rejects(sendPhoneVerificationCode({...input,code:'bad'}),{code:'SMS_INVALID_REQUEST'});
  assert.equal(mock.mock.callCount(),0);
});


test('eSMS reports actionable errors without exposing provider response details', async t => {
  for (const [status, code] of [[401, 'SMS_AUTH_FAILED'], [403, 'SMS_AUTH_FAILED'], [402, 'SMS_CREDIT_REQUIRED'], [429, 'SMS_PROVIDER_RATE_LIMITED']]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'SECRET_PROVIDER_DETAIL' }, { status }));
    await assert.rejects(sendPhoneVerificationCode(input), error => error.code === code && !error.message.includes('SECRET_PROVIDER_DETAIL'));
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});

test('eSMS balance accepts the provider decimal representation and rejects malformed values', async t => {
  for (const value of [10, '10.50', '0']) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ balance: value, currency: 'UGX' }));
    assert.equal((await verifySmsConfiguration()).creditAvailable, Number(value) > 0); mock.mock.restore();
  }
  for (const value of ['', null, 'invalid', []]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ balance: value, currency: 'UGX' }));
    await assert.rejects(verifySmsConfiguration(), { code: 'SMS_DELIVERY_FAILED' }); mock.mock.restore();
  }
});
