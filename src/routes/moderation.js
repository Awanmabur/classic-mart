import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, AppError } from '../core/errors.js';
import { decryptSensitive } from '../core/sensitive.js';
import { publicId, slugify } from '../core/ids.js';
import { hasPermission } from '../core/roles.js';
import {
  Brand,
  Category,
  Product,
  ProductMedia,
  ProductVariant,
  SellerVerification,
  Store,
  VerificationDocument,
} from '../models/index.js';
import {
  requireAuth,
  requireOnboarding,
  requirePermission,
  requireVerified,
} from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { formatMinorUnits } from '../services/catalogue.js';
import { parseCategoryAttributes } from '../services/catalogue.js';
import { getCountries } from '../services/country.js';
import { addOutboxEvent } from '../services/outbox.js';
import {
  brandDecisionSchema,
  categorySchema,
  moderationDecisionSchema,
  verificationDecisionSchema,
} from '../validation/catalogue.js';

const router = Router();
const decisionLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

router.use(
  '/moderation',
  noStore,
  requireAuth,
  requireVerified,
  requireOnboarding,
  requirePermission('catalogue:moderate'),
);

function countryScope(request, productField = 'countries') {
  return request.user.role === 'country_admin'
    ? { [productField]: request.user.country }
    : {};
}

function storeCountryScope(request) {
  return request.user.role === 'country_admin'
    ? { country: request.user.country }
    : {};
}

function renderModeration(request, response, view) {
  return response.render('moderation-workspace', {
    view,
    formatMoney: (amount, currency) =>
      formatMinorUnits(amount, currency, request.user.locale),
  });
}

router.get('/moderation', (_request, response) =>
  response.redirect('/moderation/products'),
);

router.get(
  '/moderation/products',
  asyncHandler(async (request, response) => {
    const status = ['submitted', 'approved', 'changes_requested'].includes(
      request.query.status,
    )
      ? request.query.status
      : 'submitted';
    const products = await Product.find({
      status,
      ...countryScope(request),
    })
      .populate('storeId', 'name publicId country status')
      .populate('categoryId', 'name restricted')
      .sort({ 'moderation.submittedAt': 1 })
      .limit(150)
      .lean();
    return renderModeration(request, response, {
      section: 'products',
      products,
      status,
    });
  }),
);

router.get(
  '/moderation/products/:publicId',
  asyncHandler(async (request, response) => {
    const product = await Product.findOne({
      publicId: request.params.publicId,
      ...countryScope(request),
    })
      .populate('storeId', 'name publicId country status')
      .populate('categoryId', 'name restricted attributes')
      .populate('brandId', 'name')
      .lean();
    if (!product) {
      throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
    }
    const [variants, media] = await Promise.all([
      ProductVariant.find({ productId: product._id }).sort({ createdAt: 1 }).lean(),
      ProductMedia.find({ productId: product._id })
        .sort({ position: 1 })
        .lean(),
    ]);
    return renderModeration(request, response, {
      section: 'product-detail',
      product,
      variants,
      media,
    });
  }),
);

router.post(
  '/moderation/products/:publicId/decision',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const input = moderationDecisionSchema.parse(request.body);
    const product = await Product.findOne({
      publicId: request.params.publicId,
      status: 'submitted',
      ...countryScope(request),
    });
    if (!product) {
      throw new AppError(
        'Submitted product not found.',
        404,
        'PRODUCT_NOT_FOUND',
      );
    }
    const store = await Store.findById(product.storeId);
    const [variantCount, readyMediaCount] = await Promise.all([
      ProductVariant.countDocuments({ productId: product._id, active: true }),
      ProductMedia.countDocuments({ productId: product._id, status: 'ready' }),
    ]);
    if (
      input.decision === 'approve' &&
      (store?.status !== 'verified' || !variantCount || !readyMediaCount)
    ) {
      throw new AppError(
        'Approval requires a verified store, active variant and valid media.',
        409,
        'PRODUCT_INCOMPLETE',
      );
    }
    product.status = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'changes_requested';
    product.moderation.reviewedAt = new Date();
    product.moderation.reviewedByUserId = request.user._id;
    product.moderation.reason = input.reason;
    await product.save();
    if (input.decision === 'approve') {
      await ProductMedia.updateMany(
        { productId: product._id, status: 'ready' },
        {
          $set: {
            status: 'approved',
            reviewedAt: new Date(),
            reviewedByUserId: request.user._id,
          },
        },
      );
    }
    await addOutboxEvent({
      type:
        input.decision === 'approve' ? 'catalogue.product_approved' : input.decision === 'reject' ? 'catalogue.product_rejected' : 'catalogue.product_changes_requested',
      aggregateType: 'product',
      aggregatePublicId: product.publicId,
      payload: { reason: input.reason },
    });
    await writeAudit(request, `catalogue.product_${product.status}`, {
      targetType: 'product',
      targetPublicId: product.publicId,
      metadata: { reason: input.reason },
    });
    setFlash(
      request,
      'success',
      input.decision === 'approve' ? 'Product approved. The seller can now publish it.' : input.decision === 'reject' ? 'Product rejected.' : 'Changes requested from the seller.',
    );
    return response.redirect('/moderation/products');
  }),
);

router.get(
  '/moderation/verifications',
  asyncHandler(async (request, response) => {
    const stores = await Store.find(storeCountryScope(request))
      .select('_id')
      .lean();
    const verifications = await SellerVerification.find({
      storeId: { $in: stores.map((store) => store._id) },
      status: { $in: ['submitted', 'appealed', 'approved', 'rejected'] },
    })
      .populate('storeId', 'name publicId country status')
      .populate('userId', 'name email publicId')
      .sort({ submittedAt: 1 })
      .limit(150)
      .lean();
    return renderModeration(request, response, {
      section: 'verifications',
      verifications,
    });
  }),
);

router.get(
  '/moderation/catalogue',
  asyncHandler(async (request, response) => {
    const stores =
      request.user.role === 'country_admin'
        ? await Store.find({ country: request.user.country }).select('_id').lean()
        : [];
    const [categories, brands, countries] = await Promise.all([
      Category.find(
        request.user.role === 'country_admin'
          ? {
              $or: [
                { countries: request.user.country },
                { countries: { $size: 0 } },
              ],
            }
          : {},
      )
        .sort({ name: 1 })
        .lean(),
      Brand.find({
        status: 'pending',
        ...(request.user.role === 'country_admin'
          ? { requestedByStoreId: { $in: stores.map((store) => store._id) } }
          : {}),
      })
        .populate('requestedByStoreId', 'name country')
        .sort({ createdAt: 1 })
        .lean(),
      getCountries(),
    ]);
    return renderModeration(request, response, {
      section: 'catalogue-settings',
      categories,
      brands,
      countries,
      canManageCategories: hasPermission(request.user, 'country:manage'),
    });
  }),
);

router.post(
  '/moderation/catalogue/categories',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    if (!hasPermission(request.user, 'country:manage')) {
      throw new AppError(
        'Category management requires country administration permission.',
        403,
        'FORBIDDEN',
      );
    }
    const input = categorySchema.parse(request.body);
    const available = new Set((await getCountries()).map((item) => item.code));
    if (input.countries.some((code) => !available.has(code))) {
      throw new AppError(
        'One or more category countries are unavailable.',
        422,
        'COUNTRY_UNAVAILABLE',
      );
    }
    const scopedCountries =
      request.user.role === 'country_admin'
        ? [request.user.country]
        : input.countries;
    const category = await Category.create({
      publicId: publicId('cat'),
      name: input.name,
      slug: slugify(input.name),
      description: input.description,
      active: true,
      restricted: input.restricted === 'yes',
      countries: scopedCountries,
      attributes: parseCategoryAttributes(input.attributes),
      createdByUserId: request.user._id,
    });
    await writeAudit(request, 'catalogue.category_created', {
      targetType: 'category',
      targetPublicId: category.publicId,
      metadata: { countries: scopedCountries },
    });
    setFlash(request, 'success', 'Category created from database settings.');
    return response.redirect('/moderation/catalogue');
  }),
);

router.post(
  '/moderation/catalogue/categories/:publicId/toggle',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    if (!hasPermission(request.user, 'country:manage')) {
      throw new AppError(
        'Category management requires country administration permission.',
        403,
        'FORBIDDEN',
      );
    }
    const query = { publicId: request.params.publicId };
    if (request.user.role === 'country_admin') {
      query.countries = request.user.country;
    }
    const category = await Category.findOne(query);
    if (!category) {
      throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');
    }
    category.active = !category.active;
    await category.save();
    await writeAudit(request, 'catalogue.category_status_changed', {
      targetType: 'category',
      targetPublicId: category.publicId,
      metadata: { active: category.active },
    });
    setFlash(
      request,
      'success',
      `Category ${category.active ? 'activated' : 'deactivated'}.`,
    );
    return response.redirect('/moderation/catalogue');
  }),
);

router.post(
  '/moderation/catalogue/brands/:publicId/decision',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const input = brandDecisionSchema.parse(request.body);
    const brand = await Brand.findOne({
      publicId: request.params.publicId,
      status: 'pending',
    });
    if (!brand) throw new AppError('Brand not found.', 404, 'BRAND_NOT_FOUND');
    if (request.user.role === 'country_admin') {
      const store = await Store.findOne({
        _id: brand.requestedByStoreId,
        country: request.user.country,
      });
      if (!store) throw new AppError('Brand not found.', 404, 'BRAND_NOT_FOUND');
    }
    brand.status = input.decision === 'approve' ? 'approved' : 'rejected';
    brand.reviewedByUserId = request.user._id;
    await brand.save();
    await writeAudit(request, `catalogue.brand_${brand.status}`, {
      targetType: 'brand',
      targetPublicId: brand.publicId,
    });
    setFlash(request, 'success', `Brand ${brand.status}.`);
    return response.redirect('/moderation/catalogue');
  }),
);

router.get(
  '/moderation/verifications/:publicId',
  asyncHandler(async (request, response) => {
    const verification = await SellerVerification.findOne({
      publicId: request.params.publicId,
    })
      .select('+registrationNumber +taxNumber')
      .populate('storeId', 'name publicId country status')
      .populate('userId', 'name email phone publicId')
      .lean();
    if (
      !verification ||
      (request.user.role === 'country_admin' &&
        verification.storeId?.country !== request.user.country)
    ) {
      throw new AppError(
        'Verification not found.',
        404,
        'VERIFICATION_NOT_FOUND',
      );
    }
    const documents = await VerificationDocument.find({
      verificationId: verification._id,
    })
      .sort({ createdAt: -1 })
      .lean();
    verification.registrationNumber = decryptSensitive(
      verification.registrationNumber,
    );
    verification.taxNumber = decryptSensitive(verification.taxNumber);
    return renderModeration(request, response, {
      section: 'verification-detail',
      verification,
      documents,
    });
  }),
);

router.post(
  '/moderation/verifications/:publicId/decision',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const input = verificationDecisionSchema.parse(request.body);
    const verification = await SellerVerification.findOne({
      publicId: request.params.publicId,
      status: { $in: ['submitted', 'appealed'] },
    });
    if (!verification) {
      throw new AppError(
        'Reviewable verification not found.',
        404,
        'VERIFICATION_NOT_FOUND',
      );
    }
    const store = await Store.findById(verification.storeId);
    if (
      request.user.role === 'country_admin' &&
      store?.country !== request.user.country
    ) {
      throw new AppError(
        'Verification not found.',
        404,
        'VERIFICATION_NOT_FOUND',
      );
    }
    const reviewableDocumentStatuses =
      verification.status === 'appealed' ? ['ready', 'rejected'] : ['ready'];
    const documentTypes = new Set(
      (
        await VerificationDocument.find({
          verificationId: verification._id,
          status: { $in: reviewableDocumentStatuses },
        })
          .select('documentType')
          .lean()
      ).map((item) => item.documentType),
    );
    const hasRequiredDocuments =
      documentTypes.has('identity') &&
      (verification.sellerType !== 'business' ||
        documentTypes.has('registration'));
    if (input.decision === 'approve' && !hasRequiredDocuments) {
      throw new AppError(
        'Required verification documents are missing.',
        409,
        'DOCUMENT_REQUIRED',
      );
    }
    verification.status =
      input.decision === 'approve' ? 'approved' : 'rejected';
    verification.reviewedAt = new Date();
    verification.reviewedByUserId = request.user._id;
    verification.reviewReason = input.reason;
    await verification.save();
    store.status =
      input.decision === 'approve' ? 'verified' : 'pending_verification';
    store.verifiedAt = input.decision === 'approve' ? new Date() : undefined;
    await store.save();
    await VerificationDocument.updateMany(
      {
        verificationId: verification._id,
        status: { $in: reviewableDocumentStatuses },
      },
      {
        $set: {
          status: input.decision === 'approve' ? 'approved' : 'rejected',
          reviewedAt: new Date(),
          reviewedByUserId: request.user._id,
        },
      },
    );
    await addOutboxEvent({
      type: `seller.verification_${verification.status}`,
      aggregateType: 'seller_verification',
      aggregatePublicId: verification.publicId,
      payload: { storePublicId: store.publicId, reason: input.reason },
    });
    await writeAudit(request, `seller.verification_${verification.status}`, {
      targetType: 'seller_verification',
      targetPublicId: verification.publicId,
      metadata: { reason: input.reason },
    });
    setFlash(
      request,
      'success',
      input.decision === 'approve'
        ? 'Seller verified.'
        : 'Verification rejected with a recorded reason.',
    );
    return response.redirect('/moderation/verifications');
  }),
);

export default router;
