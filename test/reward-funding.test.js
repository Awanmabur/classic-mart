import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateSellerLineSettlement, refundSettlementSlice, validateOrderFunding } from '../src/services/money.js';
import { allocateRewardGoodsMinor } from '../src/services/checkout-benefits.js';

test('reward funding preserves a cash minor unit for every purchased unit and conserves each rounding slice', () => {
  const original = [{ quantity: 3, lineTotalMinor: 101 }, { quantity: 2, lineTotalMinor: 67 }, { quantity: 1, lineTotalMinor: 19 }];
  for (let funding = 0; funding <= 181; funding++) {
    const shares = allocateRewardGoodsMinor(funding, original);
    assert.equal(shares.reduce((sum, amount) => sum + amount, 0), funding);
    const lines = allocateSellerLineSettlement(original, { discountMinor: funding, lineDiscounts: shares,
      linePlatformContributions: shares, platformFeeMinor: 9 });
    for (const line of lines) {
      assert.ok(line.customerPaidMinor >= line.quantity);
      const reversed = { grossMinor: 0, platformContributionMinor: 0, platformFeeMinor: 0, sellerReceivableMinor: 0 };
      for (let offset = 0; offset < line.customerPaidMinor; offset++) {
        const slice = refundSettlementSlice(line, offset, 1);
        assert.equal(slice.grossMinor + slice.platformContributionMinor, slice.platformFeeMinor + slice.sellerReceivableMinor);
        assert.ok(slice.sellerReceivableMinor >= 0);
        for (const key of Object.keys(reversed)) reversed[key] += slice[key];
      }
      assert.equal(reversed.grossMinor, line.customerPaidMinor);
      assert.equal(reversed.platformContributionMinor, line.platformContributionMinor);
      assert.equal(reversed.platformFeeMinor, line.platformFeeMinor);
      assert.equal(reversed.sellerReceivableMinor, line.sellerReceivableMinor);
    }
  }
  assert.throws(() => allocateRewardGoodsMinor(182, original), error => error.code === 'REWARD_CASH_FLOOR');
  assert.throws(() => allocateRewardGoodsMinor(-1, original), error => error.code === 'REWARD_QUOTE_INVALID');
});

test('funded order validation rejects unbalanced, cross-market, duplicated and altered seller snapshots', () => {
  const source = { linePublicId: 'line_a', storePublicId: 'store_a', variantPublicId: 'variant_a', quantity: 2, lineTotalMinor: 1000 };
  const order = { country: 'UG', totals: { totalMinor: 900, shippingMinor: 100, taxMinor: 0, currency: 'UGX' },
    fundingSnapshot: { rewardGoodsMinor: 200, rewardShippingMinor: 50, clubShippingMinor: 50, totalMinor: 300, grossShippingMinor: 200 }, items: [source] };
  const [line] = allocateSellerLineSettlement([{ ...source, orderLineId: source.linePublicId }], { discountMinor: 200, platformFeeMinor: 50,
    lineDiscounts: [200], linePlatformContributions: [200] });
  const seller = { country: 'UG', currency: 'UGX', storePublicId: 'store_a', subtotalMinor: 1000, discountMinor: 200, platformFeeMinor: 50, items: [line] };
  assert.deepEqual(validateOrderFunding(order, [seller]), { rewardGoodsMinor: 200, shippingContributionMinor: 100, totalMinor: 300, grossShippingMinor: 200 });
  const reject = value => assert.throws(() => validateOrderFunding(order, [value]), error => ['ORDER_FUNDING_INVALID', 'ORDER_FUNDING_UNBALANCED', 'SELLER_SETTLEMENT_SNAPSHOT_MISSING'].includes(error.code));
  reject({ ...seller, currency: 'KES' });
  reject({ ...seller, items: [line, line] });
  reject({ ...seller, items: [{ ...line, orderLineId: 'another_line' }] });
  reject({ ...seller, items: [{ ...line, sellerReceivableMinor: line.sellerReceivableMinor - 1 }] });
  reject({ ...seller, subtotalMinor: 1001 });
  assert.throws(() => validateOrderFunding({ ...order, fundingSnapshot: { ...order.fundingSnapshot, totalMinor: 301 } }, [seller]), error => error.code === 'ORDER_FUNDING_INVALID');
});
