import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, asyncHandler } from '../core/errors.js';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding, requirePermission } from '../middleware/auth.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { canAccessWorkspace, allowedWorkspacesFor } from '../dashboard/access.js';
import { DASHBOARD_PAGES, routeForPage } from '../dashboard/registry.js';
import { liveAccountHeader } from '../dashboard/live-account-header.js';
import { sellerNavigation, SELLER_LIVE_ROUTES } from '../dashboard/seller-navigation.js';
import { uploadProductImage } from '../services/media.js';
import { sellerProductList, sellerProductOptions, sellerProductDetail, createSellerProduct, updateSellerProduct,
  addSellerProductVariant, updateSellerProductVariant, createSellerProductWarehouse, adjustSellerProductStock,
  uploadSellerProductImage, updateSellerProductImage, removeSellerProductImage, reorderSellerProductImages,
  transitionSellerProduct } from '../services/seller-products.js';
import { reviewerProductDetail, productReviewQueue, reviewProduct } from '../services/product-moderation.js';

const router = Router();
const privatePage = (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); };
const common = [noStore, privatePage, requireAuth, requireVerified, requireOnboarding];
const seller = [...common, (request, _response, next) => canAccessWorkspace(request.user, 'seller') ? next() : next(new AppError('Seller access is required.', 403, 'DASHBOARD_FORBIDDEN')),
  loadSellerStore, requireStoreCapability('catalogue')];
const reviewer = [...common, requirePermission('catalogue:moderate')];
const mutationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const uploadLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const reviewerReady = new Set(['moderator-sellers', 'moderator-products']);
const navigation = (workspace, ready) => DASHBOARD_PAGES[workspace].map(row => ({ id: row[0], label: row[1], icon: row[2], href: routeForPage(row[0]), ready: ready.has(row[0]) }));
const productPath = id => '/seller/products/' + encodeURIComponent(id);

function preservedDraft(request) {
  const draft = {};
  for (const [field, max] of Object.entries({ title: 180, description: 5000, categoryPublicId: 100, brandPublicId: 100, tags: 500, videoUrl: 800,
    variantTitle: 120, sku: 64, price: 30, compareAt: 30, barcode: 64, weightGrams: 20, optionName: 60, optionValue: 80, active: 5,
    altText: 180, position: 10, reason: 300, reorderPoint: 20, quantity: 20, variantPublicId: 100, warehousePublicId: 100, name: 140, city: 120, address: 300 })) {
    if (typeof request.body?.[field] === 'string') draft[field] = request.body[field].slice(0, max);
  }
  for (const [field, value] of Object.entries(request.body || {}).slice(0, 80)) {
    if (/^attribute\[[a-zA-Z0-9_-]{1,60}\]$/.test(field) && typeof value === 'string') draft[field] = value.slice(0, 500);
  }
  if (request.params.variantId) draft.variantPublicId = request.params.variantId;
  if (request.params.mediaId) draft.mediaPublicId = request.params.mediaId;
  if (request.path.endsWith('/replace')) draft.draftImageAction = 'replace';
  return draft;
}
async function sellerPage(request, response, mode = 'detail', error = '') {
  const filters = { status: String(request.query.status || '').slice(0, 30), search: String(request.query.search || '').slice(0, 100) };
  const [header, data] = await Promise.all([liveAccountHeader(request), mode === 'list'
    ? sellerProductList(request, { after: request.query.after, status: filters.status, q: filters.search })
    : mode === 'create' ? sellerProductOptions(request) : sellerProductDetail(request)]);
  const options = data.options || (mode === 'create' ? data : {});
  const product = data.product;
  return response.render('approved-dashboard', { ...header, workspace: 'seller', initialPage: mode === 'create' ? 'seller-add-product' : 'seller-products',
    customerRoutes: { ...header.customerRoutes, ...SELLER_LIVE_ROUTES },
    allowedWorkspaces: allowedWorkspacesFor(request.user),
    liveSeller: { profileRole: 'Seller', store: options.store || request.store.toObject(), navigation: sellerNavigation(request),
      productFlow: { ...options, ...data, store: options.store || request.store.toObject(), mode, filters, stocks: data.stock || [], error,
        draft: error ? preservedDraft(request) : {}, draftSection: error ? request.path.split('/')[4] || 'update' : '', canPublish: product?.status === 'approved',
        canReopen: ['submitted', 'approved', 'published', 'archived'].includes(product?.status),
        canArchive: ['draft', 'submitted', 'changes_requested', 'approved', 'published', 'rejected'].includes(product?.status),
        publicHref: product?.status === 'published' ? '/products/' + encodeURIComponent(product.publicId) : '' } } });
}
function sellerAction(work, message, mode = 'detail') {
  return asyncHandler(async (request, response) => {
    try {
      const product = await work(request, response);
      setFlash(request, 'success', message);
      return response.redirect(productPath(request.params.publicId || product.publicId));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![422, 409, 413].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      response.status(status);
      return sellerPage(request, response, mode, error.name === 'ZodError' ? error.issues[0].message : error.message);
    }
  });
}
const parseUpload = (request, response) => new Promise((resolve, reject) => uploadProductImage(request, response, error => {
  if (error) return reject(error.name === 'MulterError' ? new AppError(error.code === 'LIMIT_FILE_SIZE' ? 'Upload an image smaller than 8 MB.' : 'Upload one product image using the image field.', error.code === 'LIMIT_FILE_SIZE' ? 413 : 422, error.code) : error);
  try { verifyDeferredCsrf(request); resolve(); } catch (csrfError) { reject(csrfError); }
}));
router.get('/seller/products', ...seller, asyncHandler((request, response) => sellerPage(request, response, 'list')));
router.get('/seller/products/new', ...seller, asyncHandler((request, response) => sellerPage(request, response, 'create')));
router.get('/seller/products/:publicId', ...seller, asyncHandler((request, response) => sellerPage(request, response)));
for (const [id, href] of [['seller-products', '/seller/products'], ['seller-add-product', '/seller/products/new']]) {
  router.get('/dashboard/' + id, ...seller.slice(0, 6), (request, response) => response.redirect(308, href + new URL(request.originalUrl, 'http://localhost').search));
}
router.post('/seller/products', ...seller, mutationLimit, sellerAction(createSellerProduct, 'Product draft created.', 'create'));
for (const [suffix, handler, message] of [
  ['update', updateSellerProduct, 'Product details saved.'], ['variants', addSellerProductVariant, 'Variant added.'],
  ['variants/:variantId', updateSellerProductVariant, 'Variant saved.'], ['warehouses', createSellerProductWarehouse, 'Warehouse created.'],
  ['stock', adjustSellerProductStock, 'Stock adjustment recorded.'], ['images/reorder', reorderSellerProductImages, 'Image order saved.'],
]) router.post('/seller/products/:publicId/' + suffix, ...seller, mutationLimit, sellerAction(handler, message));
router.post('/seller/products/:publicId/images', ...seller, uploadLimit, sellerAction(async (request, response) => {
  await parseUpload(request, response); return uploadSellerProductImage(request);
}, 'Product image uploaded.'));
router.post('/seller/products/:publicId/images/:mediaId/replace', ...seller, uploadLimit, sellerAction(async (request, response) => {
  await parseUpload(request, response); return uploadSellerProductImage(request);
}, 'Product image replaced.'));
router.post('/seller/products/:publicId/images/:mediaId', ...seller, mutationLimit, sellerAction(request => {
  if (request.body.action === 'remove') return removeSellerProductImage(request);
  if (request.body.action !== 'update') throw new AppError('Choose a valid image action.', 422, 'IMAGE_ACTION_INVALID');
  return updateSellerProductImage(request);
}, 'Product image updated.'));
for (const action of ['submit', 'publish', 'archive', 'reopen']) router.post('/seller/products/:publicId/' + action, ...seller, mutationLimit,
  sellerAction(request => transitionSellerProduct(request, action === 'reopen' ? 'draft' : action),
    ({ submit: 'Product submitted for independent review.', publish: 'Product published.', archive: 'Product archived.', reopen: 'Product returned to draft. Submit it for review after editing.' })[action]));

async function reviewPage(request, response, error = '') {
  const [header, data] = await Promise.all([liveAccountHeader(request), request.params.publicId ? reviewerProductDetail(request.user, request.params.publicId) : productReviewQueue(request.user, request.query.after)]);
  return response.render('approved-dashboard', { ...header, workspace: 'moderator', initialPage: 'moderator-products',
    customerRoutes: { ...header.customerRoutes, 'moderator-sellers': '/moderation/verifications', 'moderator-products': '/moderation/products' },
    allowedWorkspaces: allowedWorkspacesFor(request.user), liveSeller: { profileRole: 'Moderator', navigation: navigation('moderator', reviewerReady),
      productReviewFlow: { ...data, mode: request.params.publicId ? 'detail' : 'list', error,
        draft: error && typeof request.body?.reason === 'string' ? { reason: request.body.reason.slice(0, 1000) } : {} } } });
}
router.get('/moderation/products', ...reviewer, asyncHandler((request, response) => reviewPage(request, response)));
router.get('/moderation/products/:publicId', ...reviewer, asyncHandler((request, response) => reviewPage(request, response)));
router.get('/dashboard/moderator-products', ...reviewer, (_request, response) => response.redirect(308, '/moderation/products'));
for (const action of ['claim', 'release', 'decision']) router.post('/moderation/products/:publicId/' + action, ...reviewer, mutationLimit, asyncHandler(async (request, response) => {
  try { await reviewProduct(request, action); setFlash(request, 'success', 'Product review updated.'); return response.redirect('/moderation/products/' + encodeURIComponent(request.params.publicId)); }
  catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![422, 409].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    response.status(status);
    return reviewPage(request, response, error.name === 'ZodError' ? error.issues[0].message : error.message);
  }
}));
export default router;
