import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { uploadVerificationImage } from '../services/media.js';
import { sendStoredMedia } from '../services/media-delivery.js';
import { sellerTransaction } from '../services/seller-operations-access.js';
import { sellerTrustCasesPage, respondSellerTrustCase, attachSellerTrustCaseEvidence, authorizeSellerPolicyEvidence } from '../services/seller-trust-cases.js';
const router = Router();
const limit = rateLimit({ scope: 'seller-policy-cases:1', windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
router.get('/seller/trust-cases', ...sellerPageGates('support'), asyncHandler(async (request, response) => renderSellerPage(request, response, 'seller-trust-cases', await sellerTrustCasesPage(request))));
router.post('/seller/trust-cases/:id/respond', ...sellerPageGates('support'), limit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const result = await respondSellerTrustCase(request, request.params.id, request.body);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ case: result });
  setFlash(request, 'success', 'Your private case response has been recorded.'); return response.redirect('/seller/trust-cases?record=' + encodeURIComponent(result.publicId));
}));
const upload = (request, response, next) => uploadVerificationImage(request, response, error => { if (error) return next(error); try { verifyDeferredCsrf(request); next(); } catch (error) { next(error); } });
router.post('/seller/trust-cases/:id/evidence', ...sellerPageGates('support'), limit, upload, asyncHandler(async (request, response) => {
  const result = await attachSellerTrustCaseEvidence(request, request.params.id, request.body); setFlash(request, 'success', 'Private evidence attached.'); return response.redirect('/seller/trust-cases?record=' + encodeURIComponent(result.publicId));
}));
router.get('/seller/trust-cases/evidence/:id', ...sellerPageGates('support'), asyncHandler(async (request, response) => {
  const evidence = await authorizeSellerPolicyEvidence(request, request.params.id);
  return sendStoredMedia(response, evidence.storageKey, { contentType: 'image/webp', contentDisposition: 'inline', authorize: () => sellerTransaction(session => authorizeSellerPolicyEvidence(request, request.params.id, { session, write: true, expectedStorageKey: evidence.storageKey })) });
}));
export default router;
