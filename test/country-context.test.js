import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.LAUNCH_COUNTRIES = 'UG,KE';
const { createCountryContext } = await import('../src/middleware/country.js');
const { trustedProxyMatcher } = await import('../src/core/trusted-proxy.js');
const countries = [
  { code: 'UG', currency: 'UGX', active: true },
  { code: 'KE', currency: 'KES', active: true },
  { code: 'TZ', currency: 'TZS', active: false },
];
function app({ trusted = [], user, records = countries } = {}) {
  const application = express();
  application.use((req, _res, next) => { req.user = user; next(); });
  application.use(createCountryContext({ loadCountries: async () => records, trustedGeoProxyCidrs: trusted }));
  application.get('/', (req, res) => res.json({ code: req.country.code, currency: res.locals.currency, source: req.countrySource }));
  application.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
  return application;
}

test('country inference ignores spoofed forwarding headers unless the actual edge peer is configured', async () => {
  const untrusted = await request(app()).get('/').set('CF-IPCountry', 'KE').set('X-Forwarded-For', '173.245.48.1').expect(200);
  assert.equal(untrusted.body.code, 'UG');
  const otherPeer = await request(app({ trusted: ['173.245.48.0/20'] })).get('/').set('CF-IPCountry', 'KE').set('X-Forwarded-For', '173.245.48.1').expect(200);
  assert.equal(otherPeer.body.code, 'UG');
  const edge = await request(app({ trusted: ['127.0.0.0/8', '::1'] })).get('/').set('CF-IPCountry', 'KE').expect(200);
  assert.deepEqual(edge.body, { code: 'KE', currency: 'KES', source: 'edge' });
});

test('manual country overrides a saved preference; invalid/inactive values fall through to the trusted IP estimate', async () => {
  const application = app({ trusted: ['127.0.0.0/8', '::1'], user: { shoppingCountry: 'UG', country: 'UG', currency: 'UGX' } });
  const manual = await request(application).get('/').set('cookie', 'cm_country=KE').set('CF-IPCountry', 'UG').expect(200);
  assert.deepEqual(manual.body, { code: 'KE', currency: 'KES', source: 'selection' });
  const saved = await request(application).get('/').set('CF-IPCountry', 'KE').expect(200);
  assert.equal(saved.body.code, 'UG');
  const noPreference = app({ trusted: ['127.0.0.0/8', '::1'], user: { shoppingCountry: 'ZZ', country: 'UG' } });
  for (const cookie of ['cm_country=TZ', 'cm_country=%E0%A4%A', 'cm_country=ZZ']) {
    const result = await request(noPreference).get('/').set('cookie', cookie).set('CF-IPCountry', 'KE').expect(200);
    assert.equal(result.body.code, 'KE');
  }
  for (const invalid of ['XX', 'T1', 'TZ', 'KE,UG']) {
    const result = await request(app({ trusted: ['127.0.0.0/8', '::1'] })).get('/').set('CF-IPCountry', invalid).expect(200);
    assert.equal(result.body.code, 'UG');
  }
  await request(app({ records: [] })).get('/').expect(503, { code: 'COUNTRY_UNAVAILABLE' });
});

test('trusted edge CIDRs handle IPv4-mapped peers and IPv6 and reject blanket or malformed trust', () => {
  const matches = trustedProxyMatcher(['173.245.48.0/20', '2400:cb00::/32']);
  assert.equal(matches('::ffff:173.245.48.1'), true);
  assert.equal(matches('2400:cb00::1234'), true);
  assert.equal(matches('2400:ffff::1234'), false);
  assert.equal(matches('not-an-address'), false);
  for (const invalid of ['0.0.0.0/0', '::/0', 'true', 'loopback', '173.245.48.0/33', '2400:cb00::/129', '127.0.0.1/']) {
    assert.throws(() => trustedProxyMatcher([invalid]), /Trusted proxy ranges/);
  }
});
