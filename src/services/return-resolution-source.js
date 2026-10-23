import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { EvidenceDocument, LedgerAccount, LedgerTransaction, PaymentIntent, Refund, ReturnRequest, Shipment, Warehouse, WarehouseTask } from '../models/index.js';
import { shipmentSource } from './delivery-source.js';

const same = (a, b) => String(a || '') === String(b || '');
const invalid = () => new AppError('The inspected goods or original payment changed. Review the actual sources again.', 409, 'RETURN_RESOLUTION_SOURCE_CHANGED');
const date = value => value ? new Date(value).toISOString() : null;
const identifier = value => String(value || '');

/** A pickup receipt is the actual assigned carrier handover, with its ready photo. */
export async function returnPickupReceipt(row, order, { session = null } = {}) {
  const shipment = await Shipment.findOne({ publicId: row.returnShipmentPublicId, returnRequestId: row._id,
    orderId: order._id, orderPublicId: order.publicId, country: row.country, kind: 'return', status: 'delivered',
    deliveredAt: mongoose.trusted({ $type: 'date' }), pickedUpAt: mongoose.trusted({ $type: 'date' }),
    assignedAt: mongoose.trusted({ $type: 'date' }), 'proof.type': 'otp', 'proof.reference': 'verified' }).session(session);
  if (!shipment?.deliveryUserId || !shipment.proof.recordedAt) throw invalid();
  const cutoff = new Date(Math.max(new Date(shipment.assignedAt).getTime(), new Date(shipment.pickedUpAt).getTime(),
    ...shipment.timeline.filter(event => ['failed', 'rescheduled'].includes(event.type)).map(event => new Date(event.at).getTime())));
  const photo = await EvidenceDocument.findOne({ _id: mongoose.trusted({ $in: shipment.proofEvidenceDocumentIds }),
    ownerUserId: shipment.deliveryUserId, country: row.country, contextType: 'delivery_job', contextPublicId: shipment.publicId,
    documentType: 'delivery_photo', status: 'ready', createdAt: mongoose.trusted({ $gt: cutoff, $lte: shipment.deliveredAt }) }).select('+storageKey').session(session).lean();
  if (!photo) throw invalid();
  const source = await shipmentSource(shipment, { session });
  return { shipment, photo, source };
}

/** Stable source identity deliberately excludes workflow versions and refund counters. */
export async function returnResolutionSource(row, order, financial, { session = null, fence = false } = {}) {
  const intent = await PaymentIntent.findOne({ orderId: order._id, orderPublicId: order.publicId, country: row.country,
    currency: order.totals.currency, amountMinor: order.totals.totalMinor, purpose: 'order_payment',
    provider: mongoose.trusted({ $in: ['pesapal', 'wallet', 'cod'] }),
    ...(row.resolutionChange?.paymentIntentPublicId ? { publicId: row.resolutionChange.paymentIntentPublicId } : {}),
    status: mongoose.trusted({ $in: ['succeeded', 'partially_refunded', 'refunded'] }) }).session(session).lean();
  if (!intent?.paidAt || intent.provider === 'pesapal' && (!intent.lastVerifiedAt || !intent.providerTrackingId || intent.providerStatus !== 'COMPLETED')) throw invalid();
  const outbound = intent.provider === 'cod' ? await Shipment.findOne({ orderId: order._id, country: row.country,
    kind: 'outbound', status: 'delivered', deliveredAt: mongoose.trusted({ $type: 'date' }), 'proof.reference': 'verified' }).sort({ deliveredAt: -1, createdAt: -1 }).session(session).lean() : null;
  const ledger = await LedgerTransaction.findOne({ idempotencyKey: intent.provider === 'cod' ? `cod:${outbound?.publicId || ''}` : `payment:${intent.publicId}`,
    referenceType: intent.provider === 'cod' ? 'cod_reconciliation' : 'payment',
    referencePublicId: intent.provider === 'cod' ? outbound?.publicId || '' : intent.publicId,
    country: row.country, currency: order.totals.currency }).session(session).lean();
  if (!ledger?.postedAt) throw invalid();
  const accounts = await LedgerAccount.find({ _id: mongoose.trusted({ $in: ledger.entries.map(entry => entry.accountId) }),
    country: row.country, currency: order.totals.currency }).session(session).lean();
  const byAccount = new Map(accounts.map(account => [identifier(account._id), account]));
  const cashCode = intent.provider === 'cod' ? 'cod_clearing' : intent.provider === 'wallet' ? 'customer_wallet' : 'provider_clearing';
  const cash = ledger.entries.filter(entry => byAccount.get(identifier(entry.accountId))?.code === cashCode);
  if (accounts.length !== new Set(ledger.entries.map(entry => identifier(entry.accountId))).size
    || !ledger.entries.every(entry => Number.isSafeInteger(entry.debitMinor) && Number.isSafeInteger(entry.creditMinor) && (entry.debitMinor === 0) !== (entry.creditMinor === 0))
    || ledger.entries.reduce((sum, entry) => sum + entry.debitMinor - entry.creditMinor, 0) !== 0
    || cash.reduce((sum, entry) => sum + entry.debitMinor, 0) !== intent.amountMinor || cash.some(entry => entry.creditMinor > 0)
    || intent.provider === 'wallet' && cash.some(entry => !same(byAccount.get(identifier(entry.accountId)).ownerId, row.userId))
    || intent.provider === 'pesapal' && cash.some(entry => byAccount.get(identifier(entry.accountId)).ownerPublicId !== 'pesapal')
    || intent.provider === 'cod' && cash.some(entry => byAccount.get(identifier(entry.accountId)).ownerPublicId !== 'classic-mart')) throw invalid();
  const fences = [[PaymentIntent, intent, { status: intent.status, amountMinor: intent.amountMinor, currency: intent.currency }]], items = [];
  for (const item of row.items) {
    const task = await WarehouseTask.findOne({ publicId: item.warehouseTaskPublicId, type: 'return_inspection', status: 'completed',
      returnRequestId: row._id, orderId: order._id, returnOrderLineId: item.orderLineId, storeId: item.storeId,
      variantId: item.variantId, quantity: item.quantity, 'result.disposition': item.stockDisposition }).session(session).lean();
    const warehouse = task ? await Warehouse.findOne({ _id: task.warehouseId, country: row.country, storeId: item.storeId }).session(session).lean() : null;
    if (!task?.completedAt || !warehouse || !same(task.assignedUserId, item.warehouseInspectedByUserId)
      || task.result?.returnPublicId !== row.publicId || task.result?.orderLineId !== item.orderLineId
      || task.result?.returnedQuantity !== item.quantity) throw invalid();
    let receipt = null;
    if (row.returnMethod === 'dropoff') {
      receipt = await EvidenceDocument.findOne({ publicId: item.intakeEvidencePublicId, ownerUserId: item.intakeReceivedByUserId,
        country: row.country, contextType: 'return', contextPublicId: row.publicId, contextLinePublicId: item.orderLineId,
        documentType: 'return_receipt', status: 'ready', _id: mongoose.trusted({ $in: row.evidenceDocumentIds }) }).select('+storageKey').session(session).lean();
      if (!receipt || !item.intakeReceivedAt || warehouse.publicId !== item.intakeWarehousePublicId) throw invalid();
      fences.push([EvidenceDocument, receipt, { status: 'ready' }]);
    }
    fences.push([WarehouseTask, task, { status: 'completed', 'result.disposition': item.stockDisposition }], [Warehouse, warehouse, { country: row.country, storeId: item.storeId }]);
    items.push({ lineId: item.orderLineId, productId: identifier(item.productId), variantId: identifier(item.variantId), storeId: identifier(item.storeId),
      storePublicId: item.storePublicId, quantity: item.quantity, cashMinor: item.requestedRefundMinor,
      financeAllocation: item.financeAllocation?.toObject ? item.financeAllocation.toObject() : item.financeAllocation,
      task: task.publicId, taskCompletedAt: date(task.completedAt), warehouse: warehouse.publicId, disposition: item.stockDisposition,
      inspectedQuantity: item.inspectedQuantity, inspectedBy: identifier(item.warehouseInspectedByUserId), inspectedAt: date(item.warehouseInspectedAt),
      intakeReceivedAt: date(item.intakeReceivedAt), intakeReceivedBy: identifier(item.intakeReceivedByUserId),
      receipt: receipt ? { publicId: receipt.publicId, storageKey: receipt.storageKey, size: receipt.size, owner: identifier(receipt.ownerUserId) } : null });
  }
  const pickup = row.returnMethod === 'pickup' ? await returnPickupReceipt(row, order, { session }) : null;
  if (pickup) fences.push([Shipment, pickup.shipment, { status: 'delivered', 'proof.reference': 'verified' }], [EvidenceDocument, pickup.photo, { status: 'ready' }]);
  if (outbound) fences.push([Shipment, outbound, { status: 'delivered', 'proof.reference': 'verified' }]);
  for (const account of accounts) fences.push([LedgerAccount, account, { code: account.code, country: account.country, currency: account.currency }]);
  if (fence) {
    if (!session?.inTransaction()) throw invalid();
    const unique = new Map(fences.map(entry => [entry[0].modelName + ':' + entry[1]._id, entry]));
    for (const [Model, record, expected] of unique.values()) {
      const updated = await Model.updateOne({ _id: record._id, __v: record.__v || 0, ...expected }, { $inc: { __v: 1 } }, { session });
      if (updated.modifiedCount !== 1) throw invalid();
    }
  }
  const snapshot = { returnPublicId: row.publicId, orderPublicId: order.publicId, userId: identifier(row.userId), country: row.country,
    currency: order.totals.currency, amountMinor: financial.amountMinor, allocations: financial.allocations,
    inspection: { condition: row.inspection.condition, notes: row.inspection.notes, inspectedBy: identifier(row.inspection.inspectedByUserId), inspectedAt: date(row.inspection.inspectedAt) },
    payment: { publicId: intent.publicId, provider: intent.provider, method: intent.method, amountMinor: intent.amountMinor,
      paidAt: date(intent.paidAt), providerReference: intent.providerReference || '', providerTrackingId: intent.providerTrackingId || '', providerConfirmationCode: intent.providerConfirmationCode || '' },
    ledger: { publicId: ledger.publicId, postedAt: date(ledger.postedAt), entries: ledger.entries.map(entry => ({ account: entry.accountPublicId, debitMinor: entry.debitMinor, creditMinor: entry.creditMinor })),
      accounts: accounts.map(account => ({ publicId: account.publicId, code: account.code, ownerType: account.ownerType, ownerId: identifier(account.ownerId), ownerPublicId: account.ownerPublicId || '' })).sort((a,b)=>a.publicId.localeCompare(b.publicId)) },
    items, pickup: pickup ? { publicId: pickup.shipment.publicId, deliveredAt: date(pickup.shipment.deliveredAt), proof: pickup.shipment.proof,
      assignedAt: date(pickup.shipment.assignedAt), pickedUpAt: date(pickup.shipment.pickedUpAt), deliveryUserId: identifier(pickup.shipment.deliveryUserId),
      photo: { publicId: pickup.photo.publicId, storageKey: pickup.photo.storageKey, size: pickup.photo.size },
      stock: pickup.source.stock.map(item => ({ publicId: item.publicId, warehouseId: identifier(item.warehouseId), storeId: identifier(item.storeId), variantId: identifier(item.variantId) })).sort((a,b)=>a.publicId.localeCompare(b.publicId)) } : null };
  return { intent, hash: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

export async function assertAcceptedReturnRefundSource(row, order, financial, { session = null } = {}) {
  if (row.resolutionChange?.status !== 'accepted') return;
  const proposal = row.resolutionChange;
  if (!proposal.respondedAt || !same(proposal.respondedByUserId, row.userId) || same(proposal.proposedByUserId, row.userId)
    || proposal.currency !== order.totals.currency || proposal.amountMinor !== financial.amountMinor) throw invalid();
  const original = await returnResolutionSource(row, order, financial, { session, fence: Boolean(session?.inTransaction()) });
  if (original.hash !== proposal.sourceHash || original.intent.publicId !== proposal.paymentIntentPublicId) throw invalid();
}

/** Support can describe payment completion only when its actual accounting agrees. */
export async function hasVerifiedOrderRefund(order, session) {
  const refunds = await Refund.find({ orderId: order._id, currency: order.totals.currency, status: 'completed',
    providerStatus: 'COMPLETED', completedAt: mongoose.trusted({ $type: 'date' }) }).session(session).lean();
  for (const refund of refunds) {
    const intent = await PaymentIntent.findOne({ _id: refund.paymentIntentId, orderId: order._id,
      orderPublicId: order.publicId, country: order.country, currency: refund.currency,
      status: mongoose.trusted({ $in: ['partially_refunded', 'refunded'] }), refundedMinor: mongoose.trusted({ $gte: refund.amountMinor }) }).session(session).lean();
    if (!intent || refund.provider !== 'wallet' && (!refund.completedByUserId || same(refund.completedByUserId, refund.requestedByUserId))) continue;
    if (refund.returnRequestId || refund.returnPublicId) {
      const returned = await ReturnRequest.findOne({ _id: refund.returnRequestId, publicId: refund.returnPublicId,
        orderId: order._id, orderPublicId: order.publicId, userId: order.userId, country: order.country,
        status: 'refunded', refundPublicId: refund.publicId, resolution: 'refund' }).session(session).lean();
      if (!returned || returned.items.reduce((sum, item) => sum + item.requestedRefundMinor, 0) !== refund.amountMinor) continue;
    }
    const ledger = await LedgerTransaction.findOne({ idempotencyKey: `refund:${refund.publicId}`, referenceType: 'refund',
      referencePublicId: refund.publicId, country: order.country, currency: refund.currency }).session(session).lean();
    if (!ledger?.postedAt || ledger.entries.reduce((sum, entry) => sum + entry.debitMinor - entry.creditMinor, 0) !== 0) continue;
    const code = intent.provider === 'wallet' ? 'customer_wallet' : intent.provider === 'cod' ? 'cod_clearing' : 'provider_clearing';
    const accounts = await LedgerAccount.find({ _id: mongoose.trusted({ $in: ledger.entries.map(entry => entry.accountId) }),
      country: order.country, currency: refund.currency }).session(session).lean();
    const cash = accounts.filter(account => account.code === code && (intent.provider !== 'wallet' || same(account.ownerId, order.userId)));
    if (ledger.entries.filter(entry => cash.some(account => same(account._id, entry.accountId))).reduce((sum, entry) => sum + entry.creditMinor, 0) !== refund.amountMinor) continue;
    const result = await Refund.updateOne({ _id: refund._id, __v: refund.__v || 0, status: 'completed', providerStatus: 'COMPLETED' }, { $inc: { __v: 1 } }, { session });
    const paid = await PaymentIntent.updateOne({ _id: intent._id, __v: intent.__v || 0, status: intent.status }, { $inc: { __v: 1 } }, { session });
    if (result.modifiedCount !== 1 || paid.modifiedCount !== 1) throw invalid();
    return true;
  }
  return false;
}
