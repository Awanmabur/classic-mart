import mongoose from 'mongoose';
import { z } from 'zod';
import { Product, Store, StoreMember, Category, Brand, ProductVariant, ProductMedia, StockItem, Warehouse, Notification, User, ModerationQaReview } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hasPermission } from '../core/roles.js';
import { assertOperationalCountry, operationalCountryScope } from './authorization.js';
import { cursorScope, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';
import { addOutboxEvent } from './outbox.js';
import { clearStorefrontCache } from './storefront.js';
import { moderationDecisionSchema } from '../validation/catalogue.js';
import { assertSellerProductComplete } from './seller-products.js';

const revision = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
async function context(user, id, session = null) {
  if (!hasPermission(user, 'catalogue:moderate')) throw new AppError('Product review permission is required.', 403, 'FORBIDDEN');
  if (!await User.exists({ _id: user._id, status: 'active', 'security.tokenVersion': user.security?.tokenVersion ?? 0 }).session(session)) throw new AppError('Your review access changed. Sign in again.', 403, 'REVIEW_ACCESS_REVOKED');
  const product = await Product.findOne({ publicId: id }).session(session);
  const store = product && await Store.findById(product.storeId).session(session);
  if (!product || !store) throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
  assertOperationalCountry(user, store.country, 'Product is outside your assigned countries.');
  return { product, store };
}
export async function reviewerProductDetail(user, id) {
  const { product, store } = await context(user, id);
  const [category, brand, variants, media] = await Promise.all([
    Category.findById(product.categoryId).lean(),
    product.brandId ? Brand.findById(product.brandId).select('name status').lean() : null,
    ProductVariant.find({ productId: product._id, storeId: store._id }).sort({ createdAt: 1, _id: 1 }).limit(51).lean(),
    ProductMedia.find({ productId: product._id, storeId: store._id }).sort({ position: 1, _id: 1 }).limit(11).lean(),
  ]);
  const stockRows = await StockItem.find({ storeId: store._id, variantId: { $in: variants.map(row => row._id) } }).sort({ updatedAt: -1, _id: -1 }).limit(201).lean();
  const stocks = stockRows.slice(0, 200);
  const warehouses = await Warehouse.find({ storeId: store._id, _id: { $in: stocks.map(row => row.warehouseId) } }).select('name country active').limit(200).lean();
  return { product: product.toObject(), store: store.toObject(), category, brand, variants, media, stocks, stockHasMore: stockRows.length > 200, warehouses };
}
export async function productReviewQueue(user, after = '') {
  if (!hasPermission(user, 'catalogue:moderate')) throw new AppError('Product review permission is required.', 403, 'FORBIDDEN');
  const rows = await Product.aggregate([
    { $match: cursorScope({ status: 'submitted' }, after, { field: 'moderation.submittedAt', direction: 1 }) },
    { $sort: { 'moderation.submittedAt': 1, _id: 1 } },
    { $lookup: { from: Store.collection.name, localField: 'storeId', foreignField: '_id', as: 'store' } },
    { $unwind: '$store' },
    { $match: { ...operationalCountryScope(user, 'store.country'), 'store.status': 'verified' } },
    { $limit: 51 },
    { $project: { publicId: 1, title: 1, status: 1, 'moderation.submittedAt': 1, 'moderation.secondReviewRequired': 1, 'moderation.assignedUserId': 1, 'moderation.riskLevel': 1, 'store.name': 1, 'store.country': 1 } },
  ]);
  // Cursor helper expects a top-level field; preserve nested field semantics.
  const page = pageResult(rows.map(row => ({ ...row, submittedAt: row.moderation.submittedAt })), { field: 'submittedAt', direction: 1, limit: 50 });
  return page;
}
async function independent(user, product, store, session) {
  if ([product.ownerUserId, store.ownerUserId].some(id => String(id) === String(user._id)) ||
    await StoreMember.exists({ storeId: store._id, userId: user._id, status: { $in: ['active', 'invited'] } }).session(session)) {
    throw new AppError('An independent reviewer must handle this product.', 403, 'REVIEW_CONFLICT_OF_INTEREST');
  }
}
async function notify(store, product, session, message) {
  await Notification.create([{ publicId: publicId('ntf'), userId: store.ownerUserId, country: store.country, type: 'catalogue.product',
    title: 'Product review updated', body: message, href: '/seller/products/' + product.publicId, importance: 'high' }], { session });
  const owner = await User.findById(store.ownerUserId).select('email emailVerifiedAt').session(session);
  if (owner?.emailVerifiedAt) await addOutboxEvent({ type: 'catalogue.product_notification', aggregateType: 'product', aggregatePublicId: product.publicId,
    payload: { email: owner.email, subject: 'Classic Mart product review updated', body: 'Your product review was updated. Sign in to Classic Mart to view the result and next steps.' } }, session);
}
export async function reviewProduct(request, action) {
  const version = revision.parse(request.body.version);
  const input = action === 'decision' ? moderationDecisionSchema.parse(request.body) : null;
  const session = await mongoose.startSession(); let result;
  try {
    await session.withTransaction(async () => {
      const { product, store } = await context(request.user, request.params.publicId, session);
      if (product.__v !== version) throw new AppError('Product changed. Reload before continuing.', 409, 'PRODUCT_VERSION_CONFLICT');
      if (product.status !== 'submitted' || store.status !== 'verified') throw new AppError('This product is not reviewable.', 409, 'PRODUCT_LOCKED');
      await independent(request.user, product, store, session);
      const moderation = product.moderation;
      const assigned = String(moderation.assignedUserId || '') === String(request.user._id);
      const now = new Date(); let historyAction = action;
      if (action === 'claim') {
        if (String(moderation.firstApprovalByUserId || '') === String(request.user._id)) throw new AppError('A different reviewer must complete the second review.', 409, 'MODERATION_FOUR_EYES');
        if (moderation.assignedUserId && !assigned) throw new AppError('Another reviewer has claimed this product.', 409, 'MODERATION_ALREADY_CLAIMED');
        moderation.assignedUserId = request.user._id; moderation.assignedAt = now;
      } else {
        if (!assigned) throw new AppError('Claim this product before acting.', 409, 'MODERATION_CLAIM_REQUIRED');
        if (action === 'release') { moderation.assignedUserId = null; moderation.assignedAt = undefined; }
        else if (action === 'decision') {
          const category = input.decision === 'approve' ? await assertSellerProductComplete(product, store, session, { mediaStatus: ['ready'] }) : await Category.findById(product.categoryId).session(session);
          const restricted = Boolean(category?.restricted || moderation.riskLevel === 'high' || moderation.secondReviewRequired || moderation.firstApprovalByUserId);
          if (input.decision === 'approve' && restricted && !moderation.firstApprovalByUserId) {
            moderation.firstApprovalByUserId = request.user._id; moderation.firstApprovalAt = now; moderation.firstApprovalReason = input.reason;
            moderation.secondReviewRequired = true; moderation.riskLevel = 'high'; historyAction = 'first_approval';
            await notify(store, product, session, 'The first review is approved. A second independent reviewer must complete approval.');
          } else {
            if (input.decision === 'approve' && restricted && String(moderation.firstApprovalByUserId) === String(request.user._id)) throw new AppError('A different reviewer must complete final approval.', 409, 'MODERATION_FOUR_EYES');
            product.status = input.decision === 'approve' ? 'approved' : input.decision === 'changes' ? 'changes_requested' : 'rejected';
            moderation.reviewedAt = now; moderation.reviewedByUserId = request.user._id; moderation.reason = input.reason;
            moderation.secondReviewRequired = false; historyAction = input.decision;
            if (input.decision !== 'approve') { moderation.firstApprovalByUserId = null; moderation.firstApprovalAt = undefined; moderation.firstApprovalReason = ''; }
            if (input.decision === 'approve') await ProductMedia.updateMany({ productId: product._id, storeId: store._id, status: 'ready' }, { $set: { status: 'approved', reviewedAt: now, reviewedByUserId: request.user._id } }, { session });
            await ModerationQaReview.create([{ publicId: publicId('mqa'), targetType: 'product', targetObjectId: product._id, targetPublicId: product.publicId, country: store.country,
              riskLevel: restricted ? 'high' : 'standard', decision: product.status, decisionReason: input.reason, originalReviewerUserId: request.user._id }], { session });
            await notify(store, product, session, `Your product review result is ${product.status.replaceAll('_', ' ')}. Open the product to see the reason and next steps.`);
          }
          moderation.assignedUserId = null; moderation.assignedAt = undefined;
        } else throw new AppError('Review action is invalid.', 422, 'REVIEW_ACTION_INVALID');
      }
      moderation.reviewHistory.push({ action: historyAction, actorUserId: request.user._id, reason: input?.reason || '', at: now });
      moderation.reviewHistory = moderation.reviewHistory.slice(-200);
      product.markModified('status'); product.increment(); await product.save({ session });
      await writeAudit(request, 'catalogue.product_' + historyAction, { session, targetType: 'product', targetPublicId: product.publicId, country: store.country });
      result = product;
    });
    if (action === 'decision') clearStorefrontCache();
    return result;
  } finally { await session.endSession(); }
}
