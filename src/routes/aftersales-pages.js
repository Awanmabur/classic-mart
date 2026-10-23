import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { financePageGates, renderFinancePage } from '../dashboard/finance-page-view.js';
import { moderationPageGates, renderModerationPage } from '../dashboard/moderation-page-view.js';
import { countryAdminPageGates, renderCountryAdminPage } from '../dashboard/country-admin-page-view.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { supportPageGates } from '../dashboard/support-page-view.js';
import { uploadVerificationImage } from '../services/media.js';
import { sendStoredMedia } from '../services/media-delivery.js';
import { proposeReturnRefund, answerReturnRefundProposal } from '../services/return-resolution.js';
import { SPECIALIST_CASE_PAGES, SPECIALIST_CASE_ROUTES, loadSpecialistOrderCases, mutateSpecialistOrderCase,
  attachSpecialistOrderEvidence, specialistOrderEvidence, supportSpecialistEvidence, specialistEvidenceTransaction } from '../services/specialist-order-cases.js';

const router = Router();
const mutation = rateLimit({ scope: 'aftersales:mutation', windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const uploadLimit = rateLimit({ scope: 'aftersales:upload', windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });
const upload = (request, response, next) => uploadVerificationImage(request, response, error => {
  if (error) return next(error);
  try { verifyDeferredCsrf(request); next(); } catch (error) { next(error); }
});

for (const [workspace, gates, render] of [['finance', () => financePageGates(), renderFinancePage],
  ['moderator', () => moderationPageGates(), renderModerationPage], ['admin', () => countryAdminPageGates(), renderCountryAdminPage],
  ['seller', () => sellerPageGates('support'), renderSellerPage]]) {
  const base = SPECIALIST_CASE_ROUTES[workspace], pageId = SPECIALIST_CASE_PAGES[workspace][0];
  router.get(base, ...gates(), asyncHandler(async (request, response) => render(request, response, pageId, await loadSpecialistOrderCases(request, workspace))));
  for (const action of ['claim', 'respond']) router.post(base + '/:id/' + action, ...gates(), mutation, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    const result = await mutateSpecialistOrderCase(request, workspace, request.params.id, action, request.body);
    if (request.accepts(['html', 'json']) === 'json') return response.json({ referral: result });
    setFlash(request, 'success', action === 'claim' ? 'Order case claimed.' : 'Your assessment has been returned to Support.');
    return response.redirect(303, base + '?record=' + encodeURIComponent(result.publicId));
  }));
  router.post(base + '/:id/evidence', ...gates(), uploadLimit, upload, asyncHandler(async (request, response) => {
    const result = await attachSpecialistOrderEvidence(request, workspace, request.params.id, request.body, request.file);
    if (request.accepts(['html', 'json']) === 'json') return response.status(201).json({ referral: result });
    setFlash(request, 'success', 'Private case evidence attached.');
    return response.redirect(303, base + '?record=' + encodeURIComponent(result.publicId));
  }));
  router.get(base + '/evidence/:id', ...gates(), asyncHandler(async (request, response) => {
    const evidence = await specialistOrderEvidence(request, workspace, request.params.id);
    return sendStoredMedia(response, evidence.storageKey, { contentType: 'image/webp', contentDisposition: 'inline',
      authorize: () => specialistEvidenceTransaction(session => specialistOrderEvidence(request, workspace, request.params.id,
        { session, write: true, expectedStorageKey: evidence.storageKey })) });
  }));
}
router.get('/support/order-case-evidence/:id', ...supportPageGates(), asyncHandler(async (request, response) => {
  const evidence = await supportSpecialistEvidence(request, request.params.id);
  return sendStoredMedia(response, evidence.storageKey, { contentType: 'image/webp', contentDisposition: 'inline',
    authorize: () => specialistEvidenceTransaction(session => supportSpecialistEvidence(request, request.params.id,
      { session, write: true, expectedStorageKey: evidence.storageKey })) });
}));
router.post('/support/returns/:id/refund-proposal', ...supportPageGates(), mutation, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  const result = await proposeReturnRefund(request, request.params.id, request.body);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ returnRequest: result });
  setFlash(request, 'success', 'The refund alternative is waiting for the buyer’s explicit decision.');
  response.redirect(303, '/support/returns?record=' + encodeURIComponent(result.publicId));
}));
for (const path of ['/account/returns/:id/refund-proposal', '/api/v1/returns/:id/refund-proposal']) {
  router.post(path, noStore, requireAuth, requireVerified, requireOnboarding, mutation, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    const result = await answerReturnRefundProposal(request, request.params.id, request.body);
    if (path.startsWith('/api/') || request.accepts(['html', 'json']) === 'json') return response.json({ returnRequest: result });
    setFlash(request, 'success', result.resolution === 'refund' ? 'Refund alternative accepted. Finance must verify the actual payment.' : 'Refund alternative declined. Your exchange remains pending.');
    response.redirect(303, request.body?.returnTo === '/returns' ? '/returns' : '/account/returns');
  }));
}
export default router;
