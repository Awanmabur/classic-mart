import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSellerSampleStages, publicEligibilityStages } from '../src/services/storefront.js';

const uganda = { code: 'UG', currency: 'UGX', name: 'Uganda', locale: 'en-UG' };

test('directory sampling applies every marketplace eligibility stage before per-store cap', () => {
  const stages = publicSellerSampleStages(uganda);
  const eligibility = publicEligibilityStages(uganda);
  assert.deepEqual(stages.slice(0, eligibility.length), eligibility,
    'Never sample first then check whether products were approved or market-eligible.');
  const group = stages[eligibility.length + 1].$group;
  assert.equal(group._id, '$storeId');
  assert.deepEqual(group.products.$topN, {
    n: 8, sortBy: { publishedAt: -1, _id: -1 }, output: { _id: '$_id', storeId: '$storeId', publishedAt: '$publishedAt', _publicCategory: '$_publicCategory' }
  });
  assert.ok(stages.some(stage => stage.$unwind === '$products'));
  assert.ok(stages.some(stage => stage.$replaceRoot?.newRoot === '$products'));
  assert.ok(stages.some(stage => stage.$project?.['_publicCategory.name'] === 1),
    'Display accurate public category labels without leaking internal moderation or stock fields.');
  assert.equal(stages.some(stage => '$limit' in stage), false,
    'Global limits can let one large seller hide every other seller thumbnail.');
});

test('sampling cap is validated per-store and does not permit unbounded queries', () => {
  for (const count of [1, 4, 8]) {
    assert.equal(publicSellerSampleStages(uganda, count).find(stage => stage.$group).$group.products.$topN.n, count);
  }
  for (const count of [0, -1, 9, Infinity, 0.5, null, '8']) {
    assert.throws(() => publicSellerSampleStages(uganda, count), RangeError);
  }
});

test('per-store sample uses deterministic publication ordering to avoid unstable tiles', () => {
  const stages = publicSellerSampleStages(uganda);
  const top = stages.find(stage => stage.$group?.products?.$topN).$group.products.$topN;
  assert.deepEqual(top.sortBy, { publishedAt: -1, _id: -1 });
  assert.equal(stages.at(-1).$sort.storeId, 1);
});
