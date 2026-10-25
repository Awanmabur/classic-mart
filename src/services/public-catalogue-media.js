import { ProductMedia } from '../models/index.js';
import { hasPublicProductApproval } from './storefront.js';

// Public image bytes are not personalized. A bounded, indexed aggregate reads
// their CURRENT publication sources in one database round trip. It deliberately
// does not cache eligibility, user authorization, stock or money across requests.
export async function readablePublicCatalogueImage(publicId) {
  if (typeof publicId !== 'string' || !/^[a-z][a-z0-9_-]{4,99}$/.test(publicId)) return null;
  const [row] = await ProductMedia.aggregate([
    { $match: { publicId, status: 'approved' } },
    { $limit: 1 },
    { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: '_product' } },
    { $unwind: '$_product' },
    { $match: { '_product.status': 'published', $expr: { $eq: ['$storeId', '$_product.storeId'] } } },
    { $lookup: { from: 'stores', localField: 'storeId', foreignField: '_id', as: '_store' } },
    { $unwind: '$_store' },
    { $match: { '_store.status': 'verified', $expr: { $in: ['$_store.country', { $ifNull: ['$_product.countries', []] }] } } },
    { $lookup: { from: 'categories', localField: '_product.categoryId', foreignField: '_id', as: '_category' } },
    { $unwind: '$_category' },
    { $match: { '_category.active': true, $expr: { $or: [
      { $eq: [{ $size: { $ifNull: ['$_category.countries', []] } }, 0] },
      { $in: ['$_store.country', { $ifNull: ['$_category.countries', []] }] },
    ] } } },
    { $lookup: { from: 'brands', localField: '_product.brandId', foreignField: '_id', as: '_brands' } },
    { $match: { $or: [{ '_product.brandId': null }, { '_brands.status': 'approved' }] } },
    { $lookup: { from: 'countrysettings', let: { country: '$_store.country', currency: '$_store.currency' },
      pipeline: [{ $match: { active: true, $expr: { $and: [{ $eq: ['$code', '$$country'] }, { $eq: ['$currency', '$$currency'] }] } } },
        { $limit: 1 }, { $project: { _id: 1 } }], as: '_markets' } },
    { $match: { '_markets.0': { $exists: true } } },
    { $project: { publicId: 1, productId: 1, storeId: 1, storageKey: 1, thumbnailStorageKey: 1, status: 1,
      '_product._id': 1, '_product.ownerUserId': 1,
      '_product.moderation.riskLevel': 1, '_product.moderation.secondReviewRequired': 1,
      '_product.moderation.firstApprovalByUserId': 1, '_product.moderation.reviewedByUserId': 1,
      '_category.restricted': 1, '_store.ownerUserId': 1 } },
  ]);
  if (!row || !hasPublicProductApproval(row._product, row._category, row._store)) return null;
  const { _product: product, _category, _store, ...media } = row;
  return { media, product, isPublic: true };
}
