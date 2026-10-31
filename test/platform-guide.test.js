import test from 'node:test';
import assert from 'node:assert/strict';
import { guideIntent, platformGuide } from '../src/services/platform-guide.js';

const country = { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG' };
test('guide parses spoken budgets without inventing currency conversion', () => {
  assert.deepEqual(guideIntent('Find me a speaker under UGX 200,000', 'UGX'), { query: 'speaker', destination: null, maxPrice: 200000, currencyMismatch: false });
  assert.equal(guideIntent('laptop below 1.5m').maxPrice, 1500000);
  const foreign = guideIntent('find a speaker under USD 200', 'UGX');
  assert.equal(foreign.currencyMismatch, true);
  assert.equal(foreign.maxPrice, null);
});
test('navigation guide resolves real protected destinations without invoking catalogue or mutations', async () => {
  const result = await platformGuide({ country }, 'Where do I change my password?', { search() { throw new Error('unnecessary database call'); } });
  assert.equal(result.links[0].href, '/account/security');
  assert.equal(result.aiGenerated, false);
  assert.equal(result.products.length, 0);
});
test('guide uses selected-country catalogue, stock and exact current price for its answer', async () => {
  let calls = 0;
  const result = await platformGuide({ country }, 'find speaker under UGX 200,000', { async search(selected, input) {
    calls++; assert.equal(selected, country); assert.equal(input.query, 'speaker');
    return { products: [
      { id: 'prd_ok', name: '<script>speaker</script>', currency: 'UGX', price: 150000, stock: 2, seller: { name: 'Verified shop' } },
      { id: 'prd_over', name: 'Expensive', currency: 'UGX', price: 300000, stock: 2 },
      { id: 'prd_empty', name: 'Sold out', currency: 'UGX', price: 100000, stock: 0 },
      { id: 'prd_other', name: 'Wrong currency', currency: 'USD', price: 10, stock: 1 },
    ] };
  } });
  assert.equal(calls, 1); assert.deepEqual(result.products.map(p => p.id), ['prd_ok']);
  assert.equal(result.products[0].price, 150000);
  assert.equal(result.products[0].href, '/products/prd_ok?country=UG');
  assert.match(result.answer, /150,000/);
  assert.equal(result.aiGenerated, false);
});
