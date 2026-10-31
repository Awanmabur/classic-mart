import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { sellerPromoterConversationsPage, updateSellerPromoterConversation } from '../services/promoter-relationship-pages.js';

const router = Router();
const gates = sellerPageGates('support');
const limiter = rateLimit({ scope: 'seller-promoter-conversations:1', windowMs: 15 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false });
router.get(['/seller/promoter-messages', '/seller/promoter-messages/:publicId'], ...gates, asyncHandler(async (request, response) =>
  renderSellerPage(request, response, 'seller-messages', await sellerPromoterConversationsPage(request))));
for (const action of ['reply', 'read', 'resolve']) router.post('/seller/promoter-messages/:publicId/' + action, ...gates, limiter,
  asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const record = await updateSellerPromoterConversation(request, action);
      if (request.accepts(['html', 'json']) === 'json') return response.json({ record });
      setFlash(request, 'success', action === 'reply' ? 'Reply sent and promoter notified.' : 'Conversation updated.');
      return response.redirect('/seller/promoter-messages/' + encodeURIComponent(record.publicId));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status)) throw error;
      const flow = await sellerPromoterConversationsPage(request);
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = { message: String(request.body.message || '').slice(0, 4000) };
      if (request.accepts(['html', 'json']) === 'json') return response.status(status).json({ error: { code: error.code || 'VALIDATION_ERROR', message: flow.error } });
      response.status(status); return renderSellerPage(request, response, 'seller-messages', flow);
    }
  }));
export default router;
