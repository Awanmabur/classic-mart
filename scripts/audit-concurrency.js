import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { mongoDatabaseName, mongoUriWithDatabase } from '../src/core/mongo-uri.js';
import { PaymentIntent, Payout, ProcurementRun, Shipment, WarehouseTask } from '../src/models/index.js';

const baseUri = process.env.CONCURRENCY_MONGO_URI || process.env.MONGO_URI || '';
if (!baseUri) throw new Error('MONGO_URI or CONCURRENCY_MONGO_URI is required for the concurrency audit.');
const uri = process.env.CONCURRENCY_MONGO_URI || mongoUriWithDatabase(baseUri, 'classic-mart-concurrency-test');
const dbName = mongoDatabaseName(uri);
const appDbName = mongoDatabaseName(baseUri);
if (!/concurrency-test$/i.test(dbName)) throw new Error('Concurrency audit database name must end in concurrency-test.');
if (dbName === appDbName) throw new Error('Concurrency audit must never use the application database.');

function race(count, fn) { return Promise.allSettled(Array.from({ length: count }, (_, index) => fn(index))); }
function duplicateCount(results) { return results.filter((row) => row.status === 'rejected' && row.reason?.code === 11000).length; }

await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false });
try {
  await mongoose.connection.db.dropDatabase();
  await Promise.all([PaymentIntent.createIndexes(), Payout.createIndexes(), Shipment.createIndexes(), ProcurementRun.createIndexes(), WarehouseTask.createIndexes()]);

  const orderId = new mongoose.Types.ObjectId();
  const paymentResults = await race(20, (index) => PaymentIntent.collection.insertOne({
    publicId: `pay_race_${index}_${crypto.randomBytes(4).toString('hex')}`,
    orderId, orderPublicId: 'ord_race', idempotencyKey: `idem_${index}`,
    provider: 'pesapal', purpose: 'order_payment', method: 'pesapal', status: 'created',
    amountMinor: 1000, currency: 'UGX', activeKey: 'order:ord_race:active', createdAt: new Date(), updatedAt: new Date(),
  }));
  assert.equal(paymentResults.filter((row) => row.status === 'fulfilled').length, 1, 'Exactly one active payable intent may win.');
  assert.equal(duplicateCount(paymentResults), 19, 'All competing active payment intents must fail on the unique activeKey invariant.');

  const refundIntent = await PaymentIntent.create({
    publicId: `pay_refund_race_${crypto.randomBytes(5).toString('hex')}`,
    orderId: new mongoose.Types.ObjectId(), orderPublicId: 'ord_refund_race', country: 'UG', idempotencyKey: 'refund-race-payment',
    provider: 'sandbox', purpose: 'order_payment', method: 'card', status: 'succeeded', amountMinor: 1000, refundReservedMinor: 0, refundedMinor: 0, currency: 'UGX',
  });
  const refundReserveResults = await race(20, () => PaymentIntent.collection.updateOne(
    { _id: refundIntent._id, refundReservedMinor: 0, refundedMinor: 0, $expr: { $lte: [{ $add: [{ $ifNull: ['$refundReservedMinor', 0] }, { $ifNull: ['$refundedMinor', 0] }, 1000] }, '$amountMinor'] } },
    { $inc: { refundReservedMinor: 1000 } },
  ));
  const refundReservations = refundReserveResults.filter((row) => row.status === 'fulfilled').reduce((sum, row) => sum + Number(row.value.modifiedCount || 0), 0);
  assert.equal(refundReservations, 1, 'Exactly one concurrent refund may reserve the remaining captured payment.');
  let refundCounter = await PaymentIntent.findById(refundIntent._id).lean();
  assert.equal(refundCounter.refundReservedMinor, 1000);
  assert.equal(refundCounter.refundedMinor, 0);
  assert.ok(refundCounter.refundReservedMinor + refundCounter.refundedMinor <= refundCounter.amountMinor);

  const refundCompleteResults = await race(20, () => PaymentIntent.collection.updateOne(
    { _id: refundIntent._id, refundReservedMinor: { $gte: 1000 }, $expr: { $lte: [{ $add: [{ $ifNull: ['$refundedMinor', 0] }, 1000] }, '$amountMinor'] } },
    { $inc: { refundReservedMinor: -1000, refundedMinor: 1000 } },
  ));
  const refundCompletions = refundCompleteResults.filter((row) => row.status === 'fulfilled').reduce((sum, row) => sum + Number(row.value.modifiedCount || 0), 0);
  assert.equal(refundCompletions, 1, 'Exactly one concurrent completion may consume a reserved refund.');
  refundCounter = await PaymentIntent.findById(refundIntent._id).lean();
  assert.equal(refundCounter.refundReservedMinor, 0);
  assert.equal(refundCounter.refundedMinor, 1000);
  assert.ok(refundCounter.refundReservedMinor + refundCounter.refundedMinor <= refundCounter.amountMinor);

  const payoutId = new mongoose.Types.ObjectId();
  const payoutApproverId = new mongoose.Types.ObjectId();
  await Payout.collection.insertOne({
    _id: payoutId,
    publicId: `pyo_submit_race_${crypto.randomBytes(5).toString('hex')}`,
    idempotencyKey: `payout-submit-race-${crypto.randomBytes(6).toString('hex')}`,
    ownerUserId: new mongoose.Types.ObjectId(), requestedByUserId: new mongoose.Types.ObjectId(), payoutAccountId: new mongoose.Types.ObjectId(),
    amountMinor: 1000, currency: 'UGX', status: 'approved', approvedByUserId: payoutApproverId, approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  });
  const payoutSubmitters = Array.from({ length: 20 }, () => new mongoose.Types.ObjectId());
  const payoutClaimResults = await race(20, (index) => Payout.collection.updateOne(
    { _id: payoutId, status: 'approved', approvedByUserId: { $ne: payoutSubmitters[index] } },
    { $set: { status: 'submitting', submittedByUserId: payoutSubmitters[index], submissionStartedAt: new Date(), submissionAttemptId: crypto.randomUUID(), updatedAt: new Date() } },
  ));
  const payoutClaims = payoutClaimResults.filter((row) => row.status === 'fulfilled').reduce((sum, row) => sum + Number(row.value.modifiedCount || 0), 0);
  assert.equal(payoutClaims, 1, 'Exactly one finance operator may claim an approved payout for external submission.');
  const claimedPayout = await Payout.findById(payoutId).lean();
  assert.equal(claimedPayout.status, 'submitting');
  assert.ok(claimedPayout.submissionAttemptId, 'The payout submission claim must freeze an attempt ID for reconciliation.');

  const payoutDecisionId = new mongoose.Types.ObjectId();
  await Payout.collection.insertOne({
    _id: payoutDecisionId,
    publicId: `pyo_decision_race_${crypto.randomBytes(5).toString('hex')}`,
    idempotencyKey: `payout-decision-race-${crypto.randomBytes(6).toString('hex')}`,
    ownerUserId: new mongoose.Types.ObjectId(), requestedByUserId: new mongoose.Types.ObjectId(), payoutAccountId: new mongoose.Types.ObjectId(),
    amountMinor: 1000, currency: 'UGX', status: 'approved', approvedByUserId: payoutApproverId, approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  });
  const payoutDecisionResults = await race(20, (index) => index < 10
    ? Payout.collection.updateOne({_id:payoutDecisionId,status:'approved'},{$set:{status:'submitting',submittedByUserId:new mongoose.Types.ObjectId(),submissionStartedAt:new Date(),submissionAttemptId:crypto.randomUUID(),updatedAt:new Date()}})
    : Payout.collection.updateOne({_id:payoutDecisionId,status:'approved'},{$set:{status:'rejected',failureMessage:'Concurrent rejection test',updatedAt:new Date()}})
  );
  const payoutDecisions = payoutDecisionResults.filter((row) => row.status === 'fulfilled').reduce((sum, row) => sum + Number(row.value.modifiedCount || 0), 0);
  assert.equal(payoutDecisions, 1, 'Payout submission and rejection must be mutually exclusive decisions from the approved state.');
  const decidedPayout = await Payout.findById(payoutDecisionId).lean();
  assert.ok(['submitting','rejected'].includes(decidedPayout.status));

  const shipmentOrderId = new mongoose.Types.ObjectId();
  const outboundResults = await race(20, (index) => Shipment.collection.insertOne({
    publicId: `shp_out_${index}_${crypto.randomBytes(4).toString('hex')}`,
    orderId: shipmentOrderId, orderPublicId: 'ord_ship_race', kind: 'outbound', country: 'UG', mode: 'standard', status: 'ready', createdAt: new Date(), updatedAt: new Date(),
  }));
  assert.equal(outboundResults.filter((row) => row.status === 'fulfilled').length, 1, 'Exactly one outbound shipment may exist per order.');
  assert.equal(duplicateCount(outboundResults), 19);

  const returnRequestId = new mongoose.Types.ObjectId();
  const returnResults = await race(20, (index) => Shipment.collection.insertOne({
    publicId: `shp_ret_${index}_${crypto.randomBytes(4).toString('hex')}`,
    orderId: new mongoose.Types.ObjectId(), orderPublicId: `ord_ret_${index}`, kind: 'return', returnRequestId,
    country: 'UG', mode: 'standard', status: 'ready', createdAt: new Date(), updatedAt: new Date(),
  }));
  assert.equal(returnResults.filter((row) => row.status === 'fulfilled').length, 1, 'Exactly one return shipment may exist per return request.');
  assert.equal(duplicateCount(returnResults), 19);

  const templateId = new mongoose.Types.ObjectId();
  const organizationId = new mongoose.Types.ObjectId();
  const scheduledFor = new Date('2026-09-08T09:00:00.000Z');
  const procurementResults = await race(20, (index) => ProcurementRun.collection.insertOne({
    publicId: `prr_${index}_${crypto.randomBytes(4).toString('hex')}`, templateId, templatePublicId: 'prt_race', organizationId,
    scheduledFor, status: 'processing', createdAt: new Date(), updatedAt: new Date(),
  }));
  assert.equal(procurementResults.filter((row) => row.status === 'fulfilled').length, 1, 'Exactly one recurring procurement run may win per scheduled occurrence.');
  assert.equal(duplicateCount(procurementResults), 19);

  const orders = mongoose.connection.collection('orders');
  const reserveOrderId = new mongoose.Types.ObjectId();
  await orders.insertOne({ _id: reserveOrderId, publicId: 'ord_return_race', items: [{ linePublicId: 'ol_race', deliveredQuantity: 1, returnReservedQuantity: 0, returnedQuantity: 0 }] });
  const reserveResults = await race(20, () => orders.updateOne(
    { _id: reserveOrderId, items: { $elemMatch: { linePublicId: 'ol_race', deliveredQuantity: { $gte: 1 }, returnReservedQuantity: 0, returnedQuantity: 0 } } },
    { $inc: { 'items.$.returnReservedQuantity': 1 } },
  ));
  const modified = reserveResults.filter((row) => row.status === 'fulfilled').reduce((sum, row) => sum + Number(row.value.modifiedCount || 0), 0);
  assert.equal(modified, 1, 'Only one concurrent reservation may consume a delivered quantity of one.');
  const reserved = await orders.findOne({ _id: reserveOrderId });
  assert.equal(reserved.items[0].returnReservedQuantity, 1, 'Return reservation must never exceed delivered quantity.');

  const warehouseTask = await WarehouseTask.collection.insertOne({
    publicId: `wht_claim_race_${crypto.randomBytes(5).toString('hex')}`, type: 'pick', status: 'open', country: 'UG', warehousePublicId: 'wh_race', dueAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(),
  });
  const operatorIds = Array.from({ length: 20 }, () => new mongoose.Types.ObjectId());
  const claimResults = await race(20, (index) => WarehouseTask.collection.updateOne(
    { _id: warehouseTask.insertedId, status: 'open', $or: [{ assignedUserId: null }, { assignedUserId: { $exists: false } }] },
    { $set: { status: 'in_progress', assignedUserId: operatorIds[index], assignedAt: new Date(), updatedAt: new Date() } },
  ));
  const successfulClaims = claimResults.filter((row) => row.status === 'fulfilled').reduce((sum, row) => sum + Number(row.value.modifiedCount || 0), 0);
  assert.equal(successfulClaims, 1, 'Exactly one warehouse operator may atomically claim an open task.');

  console.log('Concurrency audit passed: payment intent, refund reservation/completion, payout submission/rejection claims, shipment, recurring procurement, return reservation and warehouse-claim invariants held under 20-way races.');
} finally {
  await mongoose.connection.db.dropDatabase().catch(() => {});
  await mongoose.disconnect();
}
