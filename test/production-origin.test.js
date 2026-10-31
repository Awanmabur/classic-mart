import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionOrigin } from '../src/core/production-origin.js';

test('production requires an actual HTTPS domain rather than publishing placeholder canonical links', () => {
  for (const value of [undefined,'broken','http://shop.company.ug','https://classicmart.example','https://shop.example.com',
    'https://shop.invalid','https://localhost','https://127.0.0.1','https://[::1]','https://2130706433',
    'https://shop.local','https://service.internal','https://shop.test','https://shop.company.ug/path',
    'https://person:secret@shop.company.ug','https://shop.company.ug?key=value','https://shop.company.ug#fragment']) {
    assert.throws(() => assertProductionOrigin(value), Error, String(value));
  }
  assert.equal(assertProductionOrigin('https://shop.company.ug'), 'https://shop.company.ug');
  assert.equal(assertProductionOrigin('https://market.company.co.ke/'), 'https://market.company.co.ke');
});
