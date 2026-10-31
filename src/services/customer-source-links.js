import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { CustomerReward, FinancialDocument, Order, PaymentIntent, Refund, ReturnRequest, WalletTopUp } from '../models/index.js';

const same = (left, right) => Boolean(left && right) && String(left) === String(right);
const ids = values => [...new Set(values.filter(value => mongoose.isObjectIdOrHexString(value)).map(String))];
const names = values => [...new Set(values.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 120))];
const rows = (Model, query, select) => Model.find(mongoose.trusted(query)).select(select).lean();
const focusHref = (key, value) => `/returns?${key}=${encodeURIComponent(value)}#${key}-${encodeURIComponent(value)}`;
export const customerOrderHref = publicId => `/track-order?order=${encodeURIComponent(publicId)}`;

/** A selected record remains reachable even after it leaves the first history page. */
export async function customerHistoryFocus(Model, request, key, scope) {
  const value = request.query?.[key];
  if (Object.keys(request.query || {}).some(name => name.startsWith(`${key}[`))) throw new AppError('History record not found.', 404, 'CUSTOMER_HISTORY_RECORD_NOT_FOUND');
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{3,119}$/.test(value)) throw new AppError('History record not found.', 404, 'CUSTOMER_HISTORY_RECORD_NOT_FOUND');
  const row = Model === Refund ? (await Refund.aggregate([
    { $match: { publicId: value } },
    { $lookup: { from: Order.collection.name, let: { order: '$orderId' }, pipeline: [
      { $match: { userId: request.user._id, $expr: { $eq: ['$_id', '$$order'] } } }, { $project: { _id: 1 } },
    ], as: '_ownedSourceOrder' } },
    { $match: { '_ownedSourceOrder.0': { $exists: true } } }, { $limit: 1 }, { $project: { _ownedSourceOrder: 0 } },
  ]))[0] : await Model.findOne(mongoose.trusted({ ...scope, publicId: value })).lean();
  if (!row) throw new AppError('History record not found.', 404, 'CUSTOMER_HISTORY_RECORD_NOT_FOUND');
  return row;
}

/** Resolve a bounded page in batches; cached public IDs never grant source access. */
export async function customerSourceMap(userId, { returns = [], refunds = [], disputes = [], tickets = [], entries = [], issuedRewards = [] } = {}) {
  const references = type => entries.filter(row => row.referenceType === type).map(row => row.referencePublicId);
  const refundNames = names([...refunds.map(row => row.publicId), ...returns.map(row => row.refundPublicId), ...references('refund')]);
  const refundRows = refundNames.length ? await rows(Refund, { publicId: { $in: refundNames } }, 'publicId orderId paymentIntentId returnRequestId returnPublicId currency') : [];
  const returnNames = names([...returns.map(row => row.publicId), ...refundRows.map(row => row.returnPublicId), ...references('return')]);
  const paymentNames = names(references('payment')), paymentIds = ids(refundRows.map(row => row.paymentIntentId));
  const topUpNames = names(references('wallet_topup')), rewardNames = names(references('customer_reward'));
  const [returnRows, paymentRows, topUps, rewards] = await Promise.all([
    returnNames.length ? rows(ReturnRequest, { userId, publicId: { $in: returnNames } }, 'publicId userId orderId orderPublicId country refundPublicId replacementOrderPublicId') : [],
    paymentNames.length || paymentIds.length ? rows(PaymentIntent, { $or: [{ publicId: { $in: paymentNames } }, { _id: { $in: paymentIds } }] }, 'publicId orderId orderPublicId country currency') : [],
    topUpNames.length ? rows(WalletTopUp, { userId, publicId: { $in: topUpNames } }, 'publicId country currency') : [],
    rewardNames.length ? rows(CustomerReward, { userId, publicId: { $in: rewardNames } }, 'publicId country currency') : [],
  ]);
  const records = [...returns, ...returnRows, ...disputes, ...tickets];
  const orderIds = ids([...records.map(row => row.orderId), ...refundRows.map(row => row.orderId), ...paymentRows.map(row => row.orderId)]);
  const orderNames = names([...references('order'), ...returnRows.map(row => row.replacementOrderPublicId), ...issuedRewards.map(row => row.orderPublicId)]);
  const orders = orderIds.length || orderNames.length ? await rows(Order, { userId, $or: [{ _id: { $in: orderIds } }, { publicId: { $in: orderNames } }] }, 'publicId userId country totals.currency paymentMethod idempotencyKey fundingSnapshot.rewardPublicId') : [];
  const documents = paymentRows.length && orders.length ? await rows(FinancialDocument, { ownerUserId: userId, orderId: { $in: orders.map(row => row._id) },
    paymentIntentId: { $in: paymentRows.map(row => row._id) }, paymentIntentPublicId: { $in: paymentRows.map(row => row.publicId) },
    type: { $in: ['payment_receipt', 'cod_receipt'] } }, 'publicId orderId orderPublicId country currency paymentIntentId paymentIntentPublicId') : [];
  const byId = new Map(orders.map(row => [String(row._id), row])), byName = new Map(orders.map(row => [row.publicId, row]));
  const result = new Map(), paymentById = new Map();
  for (const order of orders) result.set(`order:${order.publicId}`, { publicId: order.publicId, href: customerOrderHref(order.publicId), orderId: order._id, country: order.country, currency: order.totals?.currency });
  for (const payment of paymentRows) {
    const order = byId.get(String(payment.orderId));
    if (!order || order.publicId !== payment.orderPublicId || order.country !== payment.country || order.totals?.currency !== payment.currency) continue;
    const document = documents.find(row => same(row.orderId, order._id) && row.orderPublicId === order.publicId && row.country === order.country
      && row.currency === payment.currency && same(row.paymentIntentId, payment._id) && row.paymentIntentPublicId === payment.publicId);
    const source = { publicId: payment.publicId, href: document ? `/orders/${encodeURIComponent(order.publicId)}/documents/${encodeURIComponent(document.publicId)}` : customerOrderHref(order.publicId), orderId: order._id, orderPublicId: order.publicId, country: order.country, currency: order.totals?.currency };
    result.set(`payment:${payment.publicId}`, source); paymentById.set(String(payment._id), source);
  }
  for (const row of returnRows) {
    const order = byId.get(String(row.orderId));
    if (!order || order.publicId !== row.orderPublicId || order.country !== row.country || !same(row.userId, userId)) continue;
    const replacement = byName.get(row.replacementOrderPublicId);
    result.set(`return:${row.publicId}`, { publicId: row.publicId, href: focusHref('return', row.publicId), orderId: order._id,
      orderPublicId: order.publicId, orderHref: customerOrderHref(order.publicId), country: order.country, currency: order.totals?.currency,
      replacementOrderPublicId: replacement?.country === row.country && replacement.paymentMethod === 'exchange' && replacement.idempotencyKey === `exchange:${row.publicId}` ? replacement.publicId : '' });
  }
  for (const row of refundRows) {
    const order = byId.get(String(row.orderId)), payment = paymentById.get(String(row.paymentIntentId));
    if (!order || !payment || !same(payment.orderId, order._id) || row.currency !== order.totals?.currency) continue;
    const returned = returnRows.find(item => same(item._id, row.returnRequestId) && item.publicId === row.returnPublicId);
    const returnSource = returned && result.get(`return:${returned.publicId}`);
    result.set(`refund:${row.publicId}`, { publicId: row.publicId, href: focusHref('refund', row.publicId), orderId: order._id,
      orderPublicId: order.publicId, orderHref: customerOrderHref(order.publicId), country: order.country, currency: order.totals?.currency,
      returnPublicId: returnSource && same(returnSource.orderId, order._id) ? returnSource.publicId : '',
      returnHref: returnSource && same(returnSource.orderId, order._id) ? returnSource.href : '' });
  }
  for (const row of topUps) result.set(`wallet_topup:${row.publicId}`, { publicId: row.publicId, country: row.country, currency: row.currency, href: `/wallet?topUp=${encodeURIComponent(row.publicId)}#topup-${encodeURIComponent(row.publicId)}` });
  for (const row of rewards) result.set(`customer_reward:${row.publicId}`, { publicId: row.publicId, country: row.country, currency: row.currency, href: `/rewards?reward=${encodeURIComponent(row.publicId)}#reward-${encodeURIComponent(row.publicId)}` });
  for (const row of issuedRewards) {
    const order = byName.get(row.orderPublicId);
    if (order && order.country === row.country && order.totals?.currency === row.currency && order.fundingSnapshot?.rewardPublicId === row.publicId) {
      result.set(`reward_order:${row.publicId}`, { publicId: order.publicId, href: customerOrderHref(order.publicId) });
    }
  }
  return result;
}

export function customerEntrySource(row, sources) {
  const source = sources.get(`${row.referenceType}:${row.referencePublicId}`);
  return source && (!row.country || row.country === source.country) && (!row.currency || row.currency === source.currency) ? source : null;
}

export function customerCaseSource(row, dto, sources, kind) {
  const source = sources.get(`${kind}:${row.publicId}`);
  const order = sources.get(`order:${row.orderPublicId}`);
  const ownedOrder = order && same(order.orderId, row.orderId) && order.country === row.country;
  const output = { ...dto, orderPublicId: ownedOrder ? row.orderPublicId : '', orderHref: ownedOrder ? order.href : '' };
  if (kind === 'return') {
    const refund = sources.get(`refund:${row.refundPublicId}`);
    const linkedRefund = refund && source && refund.returnPublicId === row.publicId && same(refund.orderId, source.orderId);
    Object.assign(output, { sourceHref: source?.href || '', refundPublicId: linkedRefund ? refund.publicId : '', refundHref: linkedRefund ? refund.href : '',
      replacementOrderPublicId: source?.replacementOrderPublicId || '', replacementOrderHref: source?.replacementOrderPublicId ? customerOrderHref(source.replacementOrderPublicId) : '' });
  } else if (kind === 'refund') Object.assign(output, { sourceHref: source?.href || '', orderPublicId: source?.orderPublicId || '', orderHref: source?.orderHref || '',
    returnPublicId: source?.returnPublicId || '', returnHref: source?.returnHref || '' });
  return output;
}
