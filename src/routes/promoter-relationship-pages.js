import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { promoterPageGates, renderPromoterPage } from '../dashboard/promoter-page-view.js';
import { setFlash } from '../middleware/view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { promoterRelationshipPage, generatePromoterReferral, followPromoterBrand,
  updatePromoterConversation, createPromoterCampaignConversation } from '../services/promoter-relationship-pages.js';

const router = Router();
const gates = promoterPageGates();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false });
for (const kind of ['referrals', 'brands', 'messages']) router.get('/promoter/' + kind, ...gates,
  asyncHandler(async (request, response) => renderPromoterPage(request, response, 'promoter-' + kind, await promoterRelationshipPage(request, 'promoter-' + kind))));

function mutate(kind, operation, success, { selection = '', tab = '', created = false } = {}) {
  return asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const record = await operation(request);
      if (request.accepts(['html', 'json']) === 'json') return response.status(created ? 201 : 200).json({ record });
      setFlash(request, 'success', success);
      const params = new URLSearchParams(tab ? { tab } : {});
      if (selection) params.set(selection, record.publicId);
      return response.redirect('/promoter/' + kind + (params.size ? '?' + params : ''));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || error.code === 'PROMOTER_VERIFICATION_REQUIRED') throw error;
      const query = { ...request.query, ...(tab ? { tab } : {}), ...(selection && request.params.publicId ? { [selection]: request.params.publicId } : {}) };
      const flow = await promoterRelationshipPage({ user: request.user, session: request.session, query }, 'promoter-' + kind);
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = { message: String(request.body.message || '').slice(0, 4000), subject: String(request.body.subject || '').slice(0, 180),
        campaignId: String(request.body.campaignId || '').slice(0, 120) };
      if (request.accepts(['html', 'json']) === 'json') return response.status(status).json({ error: { code: error.code || 'VALIDATION_ERROR', message: flow.error } });
      response.status(status); return renderPromoterPage(request, response, 'promoter-' + kind, flow);
    }
  });
}
router.post('/promoter/referrals/generate', ...gates, limiter, mutate('referrals', generatePromoterReferral, 'Your reusable referral invitation is ready.'));
router.post('/promoter/brands/:publicId/follow', ...gates, limiter, mutate('brands', request => followPromoterBrand(request, true), 'Seller followed.', { selection: 'brand' }));
router.post('/promoter/brands/:publicId/unfollow', ...gates, limiter, mutate('brands', request => followPromoterBrand(request, false), 'Seller unfollowed.', { selection: 'brand' }));
router.post('/promoter/messages/campaigns/create', ...gates, limiter, mutate('messages', createPromoterCampaignConversation, 'Campaign message sent to the seller.', { selection: 'thread', tab: 'campaigns', created: true }));
for (const action of ['reply', 'read', 'resolve']) {
  router.post('/promoter/messages/customers/:publicId/' + action, ...gates, limiter,
    mutate('messages', request => updatePromoterConversation(request, action, false), action === 'reply' ? 'Reply sent and customer notified.' : 'Conversation updated.', { selection: 'thread', tab: 'customers' }));
  router.post('/promoter/messages/campaigns/:publicId/' + action, ...gates, limiter,
    mutate('messages', request => updatePromoterConversation(request, action, true), action === 'reply' ? 'Reply sent and seller notified.' : 'Conversation updated.', { selection: 'thread', tab: 'campaigns' }));
}
export default router;
