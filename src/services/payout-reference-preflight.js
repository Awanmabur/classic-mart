import { Payout } from '../models/index.js';

/** Read-only migration check deliberately excludes actual transfer references. */
export async function payoutReferenceConflicts() {
  const [result] = await Payout.aggregate([
    { $match: { providerReference: { $type: 'string', $gt: '' } } },
    { $group: { _id: { provider: { $ifNull: ['$disbursementProvider', 'external'] }, reference: '$providerReference' },
      count: { $sum: 1 }, publicIds: { $push: '$publicId' } } },
    { $match: { count: { $gt: 1 } } },
    { $facet: { totals: [{ $group: { _id: null, groups: { $sum: 1 }, payouts: { $sum: '$count' } } }],
      examples: [{ $project: { _id: 0, count: 1, payoutPublicIds: { $slice: ['$publicIds', 10] } } }, { $limit: 10 }] } },
  ]);
  return { groups: Number(result?.totals?.[0]?.groups || 0), payouts: Number(result?.totals?.[0]?.payouts || 0), examples: result?.examples || [] };
}
