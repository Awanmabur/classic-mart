import { Order, PaymentIntent } from '../models/index.js';

/** Shared read-only bindings keep exception links and their private destinations
 * on the same original payment, order, country and currency. */
export function financeOrderSourceStages() {
  return [
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'order', pipeline: [{ $project: { publicId: 1, country: 1, 'totals.currency': 1 } }] } },
    { $unwind: '$order' },
    { $match: { $expr: { $and: [{ $eq: ['$country', '$order.country'] }, { $eq: ['$currency', '$order.totals.currency'] }, { $eq: ['$orderPublicId', '$order.publicId'] }] } } },
  ];
}

export function financeProviderEventSource(scope) {
  return [
    { $match: { $and: [scope, { merchantReference: { $type: 'string', $ne: '' }, providerTrackingId: { $type: 'string', $ne: '' } }] } },
    { $project: { publicId: 1, country: 1, status: 1, attempts: 1, manualReplayCount: 1, paymentIntentPublicId: 1, orderPublicId: 1, nextAttemptAt: 1, createdAt: 1, __v: 1, merchantReference: 1, providerTrackingId: 1 } },
    { $lookup: { from: PaymentIntent.collection.name, let: { reference: '$merchantReference' }, as: 'linkedIntent', pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$provider', 'pesapal'] }, { $eq: ['$providerReference', '$$reference'] }] } } },
      { $project: { publicId: 1, country: 1, currency: 1, orderId: 1, orderPublicId: 1, providerTrackingId: 1 } },
    ] } },
    { $unwind: '$linkedIntent' },
    { $lookup: { from: Order.collection.name, localField: 'linkedIntent.orderId', foreignField: '_id', as: 'linkedOrder', pipeline: [{ $project: { publicId: 1, country: 1, 'totals.currency': 1 } }] } },
    { $unwind: '$linkedOrder' },
    { $match: { $expr: { $and: [
      { $eq: ['$country', '$linkedOrder.country'] }, { $eq: ['$linkedIntent.country', '$linkedOrder.country'] },
      { $eq: ['$linkedIntent.currency', '$linkedOrder.totals.currency'] }, { $eq: ['$linkedIntent.orderPublicId', '$linkedOrder.publicId'] },
      { $eq: ['$providerTrackingId', '$linkedIntent.providerTrackingId'] },
      { $or: [{ $eq: [{ $ifNull: ['$orderPublicId', ''] }, ''] }, { $eq: ['$orderPublicId', '$linkedOrder.publicId'] }] },
      { $or: [{ $eq: [{ $ifNull: ['$paymentIntentPublicId', ''] }, ''] }, { $eq: ['$paymentIntentPublicId', '$linkedIntent.publicId'] }] },
    ] } } },
    { $set: { orderPublicId: '$linkedOrder.publicId', paymentIntentPublicId: '$linkedIntent.publicId', currency: '$linkedIntent.currency' } },
    { $unset: ['linkedOrder', 'linkedIntent', 'merchantReference', 'providerTrackingId'] },
  ];
}

export function financeChargebackSource(scope) {
  return [
    { $match: scope },
    { $lookup: { from: PaymentIntent.collection.name, localField: 'paymentIntentId', foreignField: '_id', as: 'payment', pipeline: [
      { $project: { publicId: 1, country: 1, currency: 1, orderId: 1, orderPublicId: 1 } },
    ] } },
    { $unwind: '$payment' },
    { $match: { $expr: { $and: [
      { $eq: ['$paymentIntentPublicId', '$payment.publicId'] }, { $eq: ['$country', '$payment.country'] },
      { $eq: ['$currency', '$payment.currency'] }, { $eq: ['$orderId', '$payment.orderId'] },
      { $eq: ['$orderPublicId', '$payment.orderPublicId'] },
    ] } } },
    ...financeOrderSourceStages(),
  ];
}

export function financeCodSource(scope) {
  return [
    { $match: { ...scope, kind: 'outbound' } },
    { $set: { currency: '$cod.currency', amountMinor: '$cod.amountMinor' } },
    ...financeOrderSourceStages(),
  ];
}
