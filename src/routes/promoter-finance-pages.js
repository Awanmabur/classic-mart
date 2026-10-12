import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, asyncHandler } from '../core/errors.js';
import { promoterPageGates, renderPromoterPage } from '../dashboard/promoter-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { appealPromoterCommission, createPromoterPayoutDestination, loadPromoterFinancePage, requestPromoterPayout, streamPromoterFinanceCsv } from '../services/promoter-finance-pages.js';

const router = Router();
const mutateLimit = rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const exportLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
function queryShape(request) {
  const query = new URL(request.originalUrl, 'http://localhost').searchParams;
  for (const name of ['q', 'search', 'status', 'after', 'period']) {
    if (query.getAll(name).length > 1 || [...query.keys()].some(key => key.startsWith(name + '[') || key.startsWith(name + '.'))) throw new AppError('Provide one supported value for each filter.', 422, 'PROMOTER_FILTER_INVALID');
  }
}
for (const slug of ['traffic', 'conversions', 'commissions', 'wallet', 'payouts', 'analytics']) {
  const pageId = 'promoter-' + slug, path = '/promoter/' + slug;
  router.get(path, ...promoterPageGates(), asyncHandler(async (request, response) => { queryShape(request); return renderPromoterPage(request, response, pageId, await loadPromoterFinancePage(request, pageId)); }));
  router.get('/dashboard/' + pageId, ...promoterPageGates(), (request, response) => response.redirect(308, path + new URL(request.originalUrl, 'http://localhost').search));
  router.get(path + '/export.csv', ...promoterPageGates(), exportLimit, asyncHandler(async (request, response) => {
    queryShape(request); await writeAudit(request, 'promoter.' + slug + '_exported', { targetType: 'user', targetPublicId: request.user.publicId });
    await streamPromoterFinanceCsv(request, response, pageId);
  }));
}
router.post('/promoter/payouts/accounts', ...promoterPageGates(), mutateLimit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const account = await createPromoterPayoutDestination(request, request.body || {});
  await writeAudit(request, 'promoter.payout_account_created', { targetType: 'payout_account', targetPublicId: account.publicId, country: account.country });
  if (request.accepts(['html', 'json']) === 'json') return response.status(201).json({ account });
  setFlash(request, 'success', 'Destination saved and awaiting finance verification.'); return response.redirect('/promoter/payouts');
}));
router.post('/promoter/payouts', ...promoterPageGates(), mutateLimit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const payout = await requestPromoterPayout(request, request.body || {});
  await writeAudit(request, 'promoter.payout_requested', { targetType: 'payout', targetPublicId: payout.publicId });
  if (request.accepts(['html', 'json']) === 'json') return response.status(201).json({ payout });
  setFlash(request, 'success', 'Payout requested. Funds are reserved while finance reviews the request.'); return response.redirect('/promoter/payouts');
}));
router.post('/promoter/commissions/:id/appeal', ...promoterPageGates(), mutateLimit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const commission = await appealPromoterCommission(request, request.params.id, request.body || {});
  if (request.accepts(['html', 'json']) === 'json') return response.status(201).json({ commission });
  setFlash(request, 'success', 'Your reversal appeal was submitted for review.'); return response.redirect('/promoter/commissions');
}));
export default router;
