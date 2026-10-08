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
import { renderSellerStore } from '../dashboard/seller-store-view.js';
import { uploadVerificationImage } from '../services/media.js';
import { sellerVerificationRecord, verificationDetail, uploadSellerVerificationDocument, submitSellerVerification, appealSellerVerification,
  reviewerVerificationRecord, sellerVerificationQueue, reviewSellerVerification, readableVerificationDocument } from '../services/seller-verification.js';
import { sendVerificationDocument } from '../services/verification-media.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
const privatePage = (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); };
const common = [noStore, privatePage, requireAuth, requireVerified, requireOnboarding];
const seller = [...common, (request, _response, next) => canAccessWorkspace(request.user, 'seller') ? next() : next(new AppError('Seller access is required.', 403, 'DASHBOARD_FORBIDDEN')),
  loadSellerStore, requireStoreCapability('staff')];
const reviewer = [...common, requirePermission('catalogue:moderate')];
const uploadLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const mutationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

async function sellerPage(request, response, error = '') {
  const record = await sellerVerificationRecord(request);
  const flow = await verificationDetail(record, { revealIdentifiers: true });
  const draft = {};
  for (const [field, max] of Object.entries({ legalName: 180, registrationNumber: 80, taxNumber: 80, sellerType: 20, message: 1000 })) {
    if (error && typeof request.body?.[field] === 'string') draft[field] = request.body[field].slice(0, max);
  }
  return renderSellerStore(request, response, { verificationFlow: { ...flow, draft, error } });
}
function sellerAction(work, message) {
  return asyncHandler(async (request, response) => {
    try { await work(request, response); setFlash(request, 'success', message); return response.redirect('/seller/verification'); }
    catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status;
      if (![422, 409, 413].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      response.status(status);
      return sellerPage(request, response, error.name === 'ZodError' ? error.issues[0].message : error.code === 'LIMIT_FILE_SIZE' ? 'Upload an image smaller than 8 MB.' : error.message);
    }
  });
}
const parseUpload = (request, response) => new Promise((resolve, reject) => uploadVerificationImage(request, response, error => {
  if (error) return reject(error.name === 'MulterError' ? new AppError(error.code === 'LIMIT_FILE_SIZE' ? 'Upload an image smaller than 8 MB.' : 'Upload one document image using the document field.', error.code === 'LIMIT_FILE_SIZE' ? 413 : 422, error.code) : error);
  try { verifyDeferredCsrf(request); resolve(); } catch (csrfError) { reject(csrfError); }
}));
router.get('/seller/verification', ...seller, asyncHandler((request, response) => sellerPage(request, response)));
router.get('/seller/onboarding', ...seller, (_request, response) => response.redirect(308, '/seller/verification'));
router.post('/seller/verification/documents', ...seller, uploadLimit, sellerAction(async (request, response) => {
  await parseUpload(request, response);
  return uploadSellerVerificationDocument(request);
}, 'Verification document uploaded.'));
router.post('/seller/verification/submit', ...seller, mutationLimit, sellerAction(submitSellerVerification, 'Verification submitted for independent review.'));
router.post('/seller/verification/appeal', ...seller, mutationLimit, sellerAction(appealSellerVerification, 'Appeal submitted for review.'));
router.get('/seller/verification/documents/:documentId', ...seller, asyncHandler(async (request, response) => {
  const document = await readableVerificationDocument(request.user, request.params.documentId);
  if (String(document.storeId) !== String(request.store._id)) throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  return sendVerificationDocument(response, document);
}));

async function reviewPage(request, response, error = '') {
  const [header, flow] = await Promise.all([liveAccountHeader(request), request.params.publicId ? (async () => {
    const { record, store } = await reviewerVerificationRecord(request.user, request.params.publicId);
    return { ...(await verificationDetail(record, { revealIdentifiers: true })), store: store.toObject() };
  })() : sellerVerificationQueue(request.user, request.query.after)]);
  return response.render('approved-dashboard', { ...header, customerRoutes: { ...header.customerRoutes, 'moderator-sellers': '/moderation/verifications' },
    workspace: 'moderator', initialPage: 'moderator-sellers', allowedWorkspaces: allowedWorkspacesFor(request.user),
    liveSeller: { profileRole: 'Moderator', reviewFlow: { ...flow, error },
      navigation: DASHBOARD_PAGES.moderator.map(row => ({ id: row[0], label: row[1], icon: row[2], href: routeForPage(row[0]), ready: row[0] === 'moderator-sellers' })) } });
}
router.get('/moderation/verifications', ...reviewer, asyncHandler((request, response) => reviewPage(request, response)));
router.get('/moderation/verifications/:publicId', ...reviewer, asyncHandler((request, response) => reviewPage(request, response)));
router.get('/dashboard/moderator-sellers', ...reviewer, (_request, response) => response.redirect(308, '/moderation/verifications'));
for (const action of ['claim', 'release', 'decision']) router.post('/moderation/verifications/:publicId/' + action, ...reviewer, mutationLimit, asyncHandler(async (request, response) => {
  try { await reviewSellerVerification(request, action); setFlash(request, 'success', 'Verification review updated.'); return response.redirect('/moderation/verifications/' + encodeURIComponent(request.params.publicId)); }
  catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![422, 409].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    response.status(status);
    return reviewPage(request, response, error.name === 'ZodError' ? error.issues[0].message : error.message);
  }
}));
router.get('/moderation/verifications/:publicId/documents/:documentId', ...reviewer, asyncHandler(async (request, response) => {
  const { record } = await reviewerVerificationRecord(request.user, request.params.publicId);
  const document = await readableVerificationDocument(request.user, request.params.documentId);
  if (String(document.verificationId) !== String(record._id)) throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  await writeAudit(request, 'seller.verification_document_viewed', { targetType: 'verification_document', targetPublicId: document.publicId });
  return sendVerificationDocument(response, document);
}));
export default router;
