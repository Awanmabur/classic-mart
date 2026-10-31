import { Refund, ReturnRequest } from '../models/index.js';

/** Read-only rollout check; reports public case IDs without provider or buyer details. */
export async function returnRefundBindingConflicts() {
  const [pending] = await ReturnRequest.aggregate([
    { $match: { refundPublicId: { $type: 'string', $gt: '' } } },
    { $lookup: { from: Refund.collection.name, localField: 'refundPublicId', foreignField: 'publicId', as: 'refund' } },
    { $unwind: '$refund' },
    { $match: { 'refund.status': { $in: ['pending', 'processing'] }, $expr: { $or: [
      { $ne: [{ $ifNull: ['$refund.returnRequestId', null] }, '$_id'] },
      { $ne: [{ $ifNull: ['$refund.returnPublicId', ''] }, '$publicId'] },
      { $ne: ['$refund.orderId', '$orderId'] },
    ] } } },
    { $facet: { total: [{ $count: 'count' }], examples: [
      { $sort: { publicId: 1 } }, { $limit: 10 },
      { $project: { _id: 0, returnPublicId: '$publicId', refundPublicId: '$refund.publicId', status: '$refund.status' } },
    ] } },
  ]);
  const [collisions] = await Refund.aggregate([
    { $match: { returnRequestId: { $type: 'objectId' } } },
    { $group: { _id: '$returnRequestId', count: { $sum: 1 }, publicIds: { $push: '$publicId' } } },
    { $match: { count: { $gt: 1 } } },
    { $facet: { totals: [{ $group: { _id: null, groups: { $sum: 1 }, refunds: { $sum: '$count' } } }], examples: [
      { $sort: { _id: 1 } }, { $limit: 10 },
      { $project: { _id: 0, count: 1, refundPublicIds: { $slice: ['$publicIds', 10] } } },
    ] } },
  ]);
  return { pendingUnboundReturns: Number(pending?.total?.[0]?.count || 0), pendingExamples: pending?.examples || [],
    bindingCollisionGroups: Number(collisions?.totals?.[0]?.groups || 0), collidingRefunds: Number(collisions?.totals?.[0]?.refunds || 0), collisionExamples: collisions?.examples || [] };
}
