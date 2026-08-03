import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.TOKEN_PEPPER = 'test-token-pepper-with-at-least-32-characters';
process.env.DATA_ENCRYPTION_KEY =
  '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

const {
  calculateQualityScore,
  formatMinorUnits,
  inspectProductContent,
  parseCatalogueCsv,
  toMinorUnits,
} = await import('../src/services/catalogue.js');

test('rejects executable and restricted catalogue content', () => {
  assert.throws(
    () =>
      inspectProductContent({
        title: 'Counterfeit watch',
        description: 'A long enough product description for review.',
      }),
    /restricted marketplace term/i,
  );
  assert.throws(
    () =>
      inspectProductContent({
        title: 'Normal title',
        description: '<script>alert(1)</script> product description',
      }),
    /executable content/i,
  );
});

test('quality score is deterministic and capped', () => {
  const complete = calculateQualityScore({
    title: 'Well described wireless headphones',
    description: 'A'.repeat(200),
    tags: ['wireless', 'audio', 'travel', 'music', 'battery', 'comfort'],
    variantCount: 2,
    mediaCount: 4,
    hasBrand: true,
  });
  const incomplete = calculateQualityScore({
    title: 'Item',
    description: 'Short description text',
  });
  assert.equal(complete, 100);
  assert.ok(incomplete < complete);
});

test('money conversion respects zero-decimal currencies', () => {
  assert.equal(toMinorUnits('1250', 'UGX'), 1250);
  assert.equal(toMinorUnits('12.50', 'KES'), 1250);
  assert.match(formatMinorUnits(1250, 'UGX'), /1,250/);
  assert.throws(() => toMinorUnits('-1', 'UGX'), /valid non-negative price/i);
});

test('CSV parser validates its contract before import', () => {
  const rows = parseCatalogueCsv(
    'title,description,category,sku,price\n' +
      '"Wireless Headphones","A detailed product description for this item.","electronics","SKU-001","125000"',
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].errors, []);
  assert.equal(rows[0].sku, 'SKU-001');
  assert.throws(
    () => parseCatalogueCsv('name,description,category,sku,price\nx,y,z,a,1'),
    /header must be/i,
  );
});
