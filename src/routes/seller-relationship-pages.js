import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { setFlash } from '../middleware/view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { uploadVerificationImage } from '../services/media.js';
import { sellerRelationshipPage, respondSellerReturn, attachSellerReturnEvidence, disputeSellerReview,
  replySellerConversation, answerSellerQuestion, contactSellerCustomer } from '../services/seller-relationship-pages.js';

const router = Router();
const gates = sellerPageGates('support');
const mutationLimit = rateLimit({ scope: 'seller-relationship-pages:1', windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const selectionPath = (kind, key, id, tab = '') => `/seller/${kind}?${tab ? `tab=${encodeURIComponent(tab)}&` : ''}${key}=${encodeURIComponent(id)}`;

for (const kind of ['returns', 'customers', 'reviews', 'messages']) {
  router.get('/seller/' + kind, ...gates, asyncHandler(async (request, response) => {
    const flow = await sellerRelationshipPage(request, 'seller-' + kind);
    if (request.accepts(['html', 'json']) === 'json') return response.json(flow);
    return renderSellerPage(request, response, 'seller-' + kind, flow);
  }));
}

function mutation(kind, selection, operation, success, tab = '') {
  return asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const result = await operation(request);
      setFlash(request, 'success', success);
      return response.redirect(selectionPath(kind, selection, result.publicId, tab));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || error.code === 'STORE_LOCKED') throw error;
      const pageRequest = { user: request.user, store: request.store, session: request.session,
        query: { ...request.query, [selection]: request.params.publicId, ...(tab ? { tab } : {}) } };
      const flow = await sellerRelationshipPage(pageRequest, 'seller-' + kind);
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = { message: String(request.body.message || '').slice(0, 2000), reason: String(request.body.reason || '').slice(0, 1000),
        answer: String(request.body.answer || '').slice(0, 2000), subject: String(request.body.subject || '').slice(0, 160),
        action: String(request.body.action || '').slice(0, 30), description: String(request.body.description || '').slice(0, 300) };
      if (request.accepts(['html', 'json']) === 'json') return response.status(status).json({ error: { code: error.code || 'VALIDATION_ERROR', message: flow.error } });
      response.status(status);
      return renderSellerPage(request, response, 'seller-' + kind, flow);
    }
  });
}

router.post('/seller/returns/:publicId/respond', ...gates, mutationLimit,
  mutation('returns', 'case', respondSellerReturn, 'Return response recorded for marketplace support.'));
const evidenceUpload = (request, response, next) => uploadVerificationImage(request, response, error => {
  if (error) return next(error);
  try { verifyDeferredCsrf(request); return next(); } catch (csrfError) { return next(csrfError); }
});
router.post('/seller/returns/:publicId/evidence', ...gates, mutationLimit, evidenceUpload,
  mutation('returns', 'case', attachSellerReturnEvidence, 'Private evidence added to the return case.'));
router.post('/seller/reviews/:publicId/dispute', ...gates, mutationLimit,
  mutation('reviews', 'review', disputeSellerReview, 'Review dispute submitted for marketplace moderation.'));
router.post('/seller/messages/:publicId/reply', ...gates, mutationLimit,
  mutation('messages', 'thread', request => replySellerConversation(request), 'Reply saved and the customer notified in their account.'));
router.post('/seller/messages/:publicId/resolve', ...gates, mutationLimit,
  mutation('messages', 'thread', request => replySellerConversation(request, true), 'Conversation marked resolved.'));
router.post('/seller/messages/questions/:publicId/answer', ...gates, mutationLimit,
  mutation('messages', 'question', answerSellerQuestion, 'Answer published on the product page.', 'questions'));
router.post('/seller/customers/:publicId/contact', ...gates, mutationLimit,
  mutation('customers', 'customer', contactSellerCustomer, 'Order message queued for email delivery.'));

export default router;
