import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { FinancialDocument, LedgerTransaction, Order, PaymentIntent, Refund } from '../models/index.js';

const docPrefix = Object.freeze({
  payment_receipt: 'RCPT',
  cod_receipt: 'COD',
  refund_credit_note: 'CRN',
  chargeback_notice: 'CBN',
});

function plain(value) {
  if (!value) return value;
  if (typeof value.toObject === 'function') return value.toObject({ depopulate: true, versionKey: false });
  return JSON.parse(JSON.stringify(value));
}

function orderSnapshot(orderLike) {
  const order = plain(orderLike);
  return {
    id: order.publicId,
    createdAt: order.createdAt,
    isGuest: !order.userId,
    country: order.country,
    deliveryMethod: order.deliveryMethod,
    paymentMethod: order.paymentMethod,
    contact: {
      fullName: order.contact?.fullName || '',
      email: order.contact?.email || '',
      phone: order.contact?.phone || '',
      address: order.contact?.address || '',
      city: order.contact?.city || '',
      country: order.contact?.country || order.country || '',
    },
    totals: plain(order.totals),
    items: (order.items || []).map(item => ({
      linePublicId: item.linePublicId || '',
      productPublicId: item.productPublicId || '',
      variantPublicId: item.variantPublicId || '',
      storePublicId: item.storePublicId || '',
      title: item.title || '',
      variant: item.variantTitle || item.variant || '',
      sku: item.sku || '',
      quantity: Number(item.quantity || 0),
      unitPriceMinor: Number(item.unitPriceMinor || 0),
      lineTotalMinor: Number(item.lineTotalMinor || 0),
      currency: item.currency || order.totals?.currency || '',
    })),
    businessInvoicePublicId: order.businessInvoicePublicId || '',
    purchaseOrderPublicId: order.purchaseOrderPublicId || '',
  };
}

function paymentSnapshot(intentLike) {
  const intent = plain(intentLike);
  return {
    id: intent.publicId,
    provider: intent.provider,
    method: intent.providerPaymentMethod || intent.method || '',
    providerTrackingId: intent.providerTrackingId || '',
    confirmationCode: intent.providerConfirmationCode || '',
    paidAt: intent.paidAt || null,
    amountMinor: Number(intent.amountMinor || 0),
    currency: intent.currency || '',
  };
}

function refundSnapshot(refundLike) {
  const refund = plain(refundLike);
  return {
    id: refund.publicId,
    provider: refund.provider,
    providerRefundId: refund.providerRefundId || '',
    manualReference: refund.manualReference || '',
    reason: refund.reason || '',
    completedAt: refund.completedAt || null,
    amountMinor: Number(refund.amountMinor || 0),
    currency: refund.currency || '',
    allocations: (refund.allocations || []).map(row => ({
      storePublicId: row.storePublicId || '',
      productPublicId: row.productPublicId || '',
      orderLineId: row.orderLineId || '',
      grossMinor: Number(row.grossMinor || 0),
      platformFeeMinor: Number(row.platformFeeMinor || 0),
      sellerReceivableMinor: Number(row.sellerReceivableMinor || 0),
    })),
  };
}

function documentNumber(type, eventKey) {
  const prefix = docPrefix[type] || 'DOC';
  const safe = String(eventKey || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(-42);
  return `CM-${prefix}-${safe}`;
}

export async function issueFinancialDocument({ type, eventKey, order, intent = null, refund = null, amountMinor, issuedAt = new Date(), extra = {}, session = null }) {
  const existing = await FinancialDocument.findOne({ eventKey }).session(session);
  if (existing) return existing;
  const orderDoc = plain(order);
  if (!orderDoc?._id || !orderDoc?.publicId) throw new AppError('Financial document requires an order.', 500, 'FINANCIAL_DOCUMENT_ORDER_REQUIRED');
  const snapshot = {
    issuer: { name: 'Classic Mart', platform: 'Classic Technologies' },
    type,
    order: orderSnapshot(order),
    payment: intent ? paymentSnapshot(intent) : null,
    refund: refund ? refundSnapshot(refund) : null,
    ...plain(extra),
  };
  const docs = await FinancialDocument.create([{
    publicId: publicId('fdoc'),
    eventKey,
    documentNumber: documentNumber(type, eventKey),
    type,
    orderId: orderDoc._id,
    orderPublicId: orderDoc.publicId,
    ownerUserId: orderDoc.userId || undefined,
    paymentIntentId: intent?._id || undefined,
    paymentIntentPublicId: intent?.publicId || '',
    refundId: refund?._id || undefined,
    refundPublicId: refund?.publicId || '',
    country: orderDoc.country,
    currency: orderDoc.totals?.currency || intent?.currency || refund?.currency,
    amountMinor: Number(amountMinor ?? intent?.amountMinor ?? refund?.amountMinor ?? orderDoc.totals?.totalMinor ?? 0),
    snapshot,
    issuedAt,
  }], { session });
  return docs[0];
}

export async function issuePaymentReceipt(order, intent, session = null) {
  const type = intent.provider === 'cod' ? 'cod_receipt' : 'payment_receipt';
  return issueFinancialDocument({ type, eventKey: `${type}:${intent.publicId}`, order, intent, amountMinor: intent.amountMinor, issuedAt: intent.paidAt || new Date(), session });
}

export async function issueRefundCreditNote(order, refund, intent = null, session = null) {
  return issueFinancialDocument({ type: 'refund_credit_note', eventKey: `refund_credit_note:${refund.publicId}`, order, intent, refund, amountMinor: refund.amountMinor, issuedAt: refund.completedAt || new Date(), session });
}

export async function financialDocumentsForOrder(orderIdOrPublicId) {
  const order = await Order.findOne({ $or: [{ publicId: String(orderIdOrPublicId) }, ...(String(orderIdOrPublicId).match(/^[a-f0-9]{24}$/i) ? [{ _id: orderIdOrPublicId }] : [])] }).lean();
  if (!order) return [];
  return FinancialDocument.find({ orderId: order._id }).sort({ issuedAt: 1 }).lean();
}

export async function ensureHistoricalReceipt(orderLike, session = null) {
  const order = plain(orderLike);
  const existing = await FinancialDocument.findOne({ orderId: order._id, type: { $in: ['payment_receipt', 'cod_receipt'] } }).sort({ issuedAt: 1 }).session(session);
  if (existing) return existing;
  const intent = await PaymentIntent.findOne({ orderId: order._id, status: { $in: ['succeeded', 'partially_refunded', 'refunded', 'reversed'] } }).sort({ paidAt: 1, createdAt: 1 }).session(session);
  if (!intent) return null;
  const ledgerKey = intent.provider === 'cod' ? null : `payment:${intent.publicId}`;
  if (ledgerKey) {
    const ledger = await LedgerTransaction.findOne({ idempotencyKey: ledgerKey }).session(session).lean();
    if (!ledger && intent.purpose !== 'business_invoice') return null;
  }
  return issuePaymentReceipt(order, intent, session);
}

export async function backfillFinancialDocuments({ limit = 0 } = {}) {
  let paymentDocuments = 0;
  let refundDocuments = 0;
  let scannedPayments = 0;
  let scannedRefunds = 0;
  const max = Math.max(0, Number(limit || 0));
  const paymentQuery = PaymentIntent.find({ status: { $in: ['succeeded', 'partially_refunded', 'refunded', 'reversed'] } }).sort({ createdAt: 1 });
  for await (const intent of paymentQuery.cursor()) {
    if (max && scannedPayments >= max) break;
    scannedPayments += 1;
    const order = await Order.findById(intent.orderId);
    if (!order) continue;
    const eventKey = `${intent.provider === 'cod' ? 'cod_receipt' : 'payment_receipt'}:${intent.publicId}`;
    if (!await FinancialDocument.exists({ eventKey })) {
      await issuePaymentReceipt(order, intent);
      paymentDocuments += 1;
    }
  }
  const refundQuery = Refund.find({ status: 'completed' }).sort({ completedAt: 1, createdAt: 1 });
  for await (const refund of refundQuery.cursor()) {
    if (max && scannedRefunds >= max) break;
    scannedRefunds += 1;
    const order = await Order.findById(refund.orderId);
    if (!order) continue;
    const intent = await PaymentIntent.findById(refund.paymentIntentId);
    const eventKey = `refund_credit_note:${refund.publicId}`;
    if (!await FinancialDocument.exists({ eventKey })) {
      await issueRefundCreditNote(order, refund, intent);
      refundDocuments += 1;
    }
  }
  return { paymentDocuments, refundDocuments, scannedPayments, scannedRefunds };
}
