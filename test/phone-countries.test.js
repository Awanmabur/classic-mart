import test from 'node:test';
import assert from 'node:assert/strict';
import { getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { getPhoneCountries } from '../src/services/phone-countries.js';
import { spawnSync } from 'node:child_process';
import { canonicalPhone } from '../src/core/phone.js';

test('phone selector derives its complete country list and codes from phone metadata', () => {
  const countries = getPhoneCountries();
  assert.deepEqual(countries.map(row => row.code).sort(), getCountries().sort());
  assert.ok(countries.length > 200);
  assert.ok(countries.every(row => row.name && row.phonePrefix === `+${getCountryCallingCode(row.code)}`));
  assert.equal(canonicalPhone('2025550123', 'US'), '+12025550123');
  assert.throws(() => canonicalPhone('202555012', 'US'), { code: 'INVALID_PHONE' });
  assert.throws(() => canonicalPhone('202555012345678', 'US'), { code: 'INVALID_PHONE' });
  assert.throws(() => canonicalPhone('+256700000000', 'US'), { code: 'INVALID_PHONE' });
});

test('an eSMS key selects the real adapter when SMS_MODE is omitted', () => {
  const settings = { ...process.env, NODE_ENV: 'test', ESMS_API_KEY: 'esms_test_fixture' };
  delete settings.SMS_MODE;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const { env } = await import('./src/config/env.js'); console.log(env.sms.mode)"], { cwd: process.cwd(), env: settings, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'esms');
});
