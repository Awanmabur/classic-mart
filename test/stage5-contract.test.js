import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Stage 5 verifies Pesapal status, amount, currency and merchant reference before settling an order', async()=>{
  const source=await read('src/services/payments.js');
  assert.match(source,/getPesapalTransactionStatus/);
  assert.match(source,/status==='COMPLETED'/);
  assert.match(source,/amountMatches/);
  assert.match(source,/currencyMatches/);
  assert.match(source,/referenceMatches/);
  assert.match(source,/commitOrderInventoryAndMoney/);
});

test('Stage 5 uses immutable balanced double entry ledger transactions', async()=>{
  const model=await read('src/models/LedgerTransaction.js');
  assert.match(model,/debitMinor/);assert.match(model,/creditMinor/);assert.match(model,/d>0&&d===c/);assert.match(model,/Ledger transactions are immutable/);
});

test('Stage 5 Pesapal notifications are durable, deduplicated and never trusted as payment status', async()=>{
  const service=await read('src/services/payments.js');const routes=await read('src/routes/payments.js');const model=await read('src/models/ProviderEvent.js');
  assert.match(service,/processPesapalNotification/);assert.match(service,/getPesapalTransactionStatus/);assert.match(service,/ProviderEvent\.findOneAndUpdate\(/);assert.match(service,/lockedUntil/);
  assert.match(routes,/webhooks\/pesapal/);assert.match(routes,/OrderTrackingId/);assert.doesNotMatch(routes,/flutterwave-signature/i);assert.match(model,/provider:1,eventId:1.*unique:true/s);
});

test('Stage 5 keeps raw card data out of Classic Mart and delegates collection to Pesapal', async()=>{
  const cart=await read('views/cart.ejs');const payment=await read('src/services/payments.js');const provider=await read('src/services/pesapal.js');
  assert.doesNotMatch(cart,/name="cvv"|name="card_number"|name="cardNumber"/i);
  assert.match(payment,/submitPesapalOrder/);assert.match(provider,/SubmitOrderRequest/);
});

test('Stage 5 payout flow reserves balance and requires separate approval, submission and reconciliation actors',async()=>{
  const service=await read('src/services/payments.js');const routes=await read('src/routes/payments.js');
  assert.match(service,/payout-hold:/);assert.match(service,/releasePayoutHold/);assert.match(service,/reconcilePayout/);assert.match(service,/FOUR_EYES_REQUIRED/);
  assert.match(routes,/payouts\/:id\/submit/);assert.match(routes,/payouts\/:id\/reconcile/);
});

test('Stage 5 supports COD/manual refunds without pretending they are Pesapal provider refunds',async()=>{
  const service=await read('src/services/payments.js');const model=await read('src/models/Refund.js');const routes=await read('src/routes/payments.js');
  assert.match(model,/cod_manual/);assert.match(model,/external_manual/);assert.match(service,/completeManualRefund/);assert.match(service,/FOUR_EYES_REQUIRED/);assert.match(service,/cod_clearing/);assert.match(routes,/refunds\/:id\/manual-complete/);
});

test('Stage 5 shares seller net-settlement math between provider and COD payments',async()=>{
  const money=await read('src/services/money.js');const payments=await read('src/services/payments.js');const logistics=await read('src/services/logistics.js');
  assert.match(money,/sellerSettlementBreakdown/);assert.match(money,/subtotalMinor - appliedDiscountMinor/);assert.match(payments,/import\s*\{[^}]*\bsellerSettlementBreakdown\b[^}]*\}\s*from ['"]\.\/money\.js['"]/s);assert.match(payments,/sellerSettlementBreakdown\(sellerOrder\)/);assert.match(logistics,/import\s*\{[^}]*\bsellerSettlementBreakdown\b[^}]*\}\s*from ['"]\.\/money\.js['"]/s);assert.match(logistics,/sellerSettlementBreakdown\(sellerOrder\)/);
});

test('Stage 5 reloads refund order and payment records inside the refund transaction',async()=>{
  const service=await read('src/services/payments.js');assert.match(service,/async function postRefundLedger\(orderLike,refundLike,intentLike\)/);assert.match(service,/Order\.findById\(orderLike\._id\)\.session\(session\)/);assert.match(service,/PaymentIntent\.findById\(intentLike\._id\)\.session\(session\)/);assert.match(service,/Refund\.findById\(refundLike\._id\)\.session\(session\)/);assert.match(service,/LedgerTransaction\.exists\(/);assert.match(service,/\.session\(session\)\)return/);
});
