import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { renderSellerPage, sellerPageGates } from '../dashboard/seller-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { createGrowthPromotion, requestSellerSubscription, sellerPromotionsPage, sellerSubscriptionPage, updateGrowthPromotionStatus } from '../services/seller-growth-pages.js';

const router = Router();
const mutationLimit = rateLimit({ scope: 'seller-growth-pages:1', windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const fields = ['type', 'name', 'code', 'productPublicIds', 'discountBps', 'fixedDiscountMinor', 'minQuantity', 'minSubtotalMinor', 'disclosureText', 'startsAt', 'endsAt', 'status', 'planPublicId', 'note'];

function safeDraft(body) {
  return Object.fromEntries(fields.flatMap(field => {
    const value = body?.[field];
    if (typeof value === 'string' || typeof value === 'number') return [[field, String(value).slice(0, field === 'productPublicIds' ? 20000 : field === 'note' ? 1000 : 300)]];
    if (field === 'productPublicIds' && Array.isArray(value)) return [[field, value.filter(value => typeof value === 'string').slice(0, 200).map(value => value.slice(0, 100)).join(', ')]];
    return [];
  }));
}

async function page(request, response, domain, extras = {}) {
  const flow = domain === 'subscription' ? await sellerSubscriptionPage(request) : await sellerPromotionsPage(request, domain === 'coupons');
  return renderSellerPage(request, response, `seller-${domain}`, { ...flow, ...extras });
}

function action(domain, work, message) {
  return asyncHandler(async (request, response) => {
    // Global CSRF protection handles ordinary forms. Verify its deferred branch
    // as well, before any business state is changed.
    verifyDeferredCsrf(request);
    try {
      await work(request);
      setFlash(request, 'success', message);
      return response.redirect(`/seller/${domain}`);
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![422, 409].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      response.status(status);
      return page(request, response, domain, { error: error.name === 'ZodError' ? `${error.issues[0]?.path.join(' ') || 'Form'}: ${error.issues[0]?.message || 'Check the fields and try again.'}` : error.message, draft: safeDraft(request.body), draftSection: request.params.id ? 'status' : 'create', draftId: request.params.id || '' });
    }
  });
}

for (const domain of ['promotions', 'coupons']) {
  const coupon = domain === 'coupons';
  router.get(`/seller/${domain}`, ...sellerPageGates('growth'), asyncHandler((request, response) => page(request, response, domain)));
  router.post(`/seller/${domain}`, ...sellerPageGates('growth'), mutationLimit, action(domain, request => createGrowthPromotion(request, request.body || {}, coupon), coupon ? 'Coupon created. Activate it when you are ready to make it available at checkout.' : 'Promotion created. Review its eligibility and availability below.'));
  router.post(`/seller/${domain}/:id/status`, ...sellerPageGates('growth'), mutationLimit, action(domain, request => updateGrowthPromotionStatus(request, request.params.id, request.body || {}, coupon), coupon ? 'Coupon status updated.' : 'Promotion status updated.'));
}
router.get('/seller/subscription', ...sellerPageGates('staff'), asyncHandler((request, response) => page(request, response, 'subscription')));
router.post('/seller/subscription/requests', ...sellerPageGates('staff'), mutationLimit, action('subscription', request => requestSellerSubscription(request, request.body || {}), 'Subscription change request submitted. Activation follows independent approval and payment.'));

export default router;
