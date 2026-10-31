import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler, AppError } from '../core/errors.js';
import { noStore } from '../middleware/request.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { sellerPageGates } from '../dashboard/seller-page-view.js';
import { setFlash } from '../middleware/view.js';
import { SubscriptionCharge } from '../models/SubscriptionCharge.js';
import { startSellerSubscriptionPayment, cancelSellerSubscription, cancelSellerSubscriptionRequest, reconcileOwnedSellerSubscription, verifySellerSubscriptionPayment } from '../services/seller-subscription-operations.js';
const router = Router();
const limit = rateLimit({ scope: 'seller-subscription-billing:1', windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
router.post('/seller/subscription/payments', ...sellerPageGates('staff'), limit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const charge = await startSellerSubscriptionPayment(request, request.body);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ charge });
  if (charge.checkoutUrl && charge.status === 'requires_action') return response.redirect(303, charge.checkoutUrl);
  setFlash(request, 'success', charge.status === 'succeeded' ? 'Subscription period activated.' : 'Subscription payment recorded. Check the verified payment status below.'); return response.redirect('/seller/subscription');
}));
router.post('/seller/subscription/enrollments/:id/cancel', ...sellerPageGates('staff'), limit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const enrollment = await cancelSellerSubscription(request, request.params.id, request.body);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ enrollment: { publicId: enrollment.publicId, cancelAtPeriodEnd: enrollment.cancelAtPeriodEnd, version: enrollment.__v || 0 } });
  setFlash(request, 'success', 'Cancellation recorded. Your paid benefits remain until the period ends.'); return response.redirect('/seller/subscription');
}));
router.post('/seller/subscription/requests/:id/cancel', ...sellerPageGates('staff'), limit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const change = await cancelSellerSubscriptionRequest(request, request.params.id, request.body);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ request: { publicId: change.publicId, status: change.status } });
  setFlash(request, 'success', 'Subscription request cancelled.'); return response.redirect('/seller/subscription');
}));
router.post('/seller/subscription/payments/:id/reconcile', ...sellerPageGates('staff'), limit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); const charge = await reconcileOwnedSellerSubscription(request, request.params.id, request.body);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ charge });
  setFlash(request, 'success', 'Payment status checked with Pesapal.'); return response.redirect('/seller/subscription');
}));
// The return contains no trusted payment state and never exposes store or personal data.
router.get('/seller/subscription/return', noStore, asyncHandler(async (request, response) => {
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const tracking = request.query.OrderTrackingId || request.query.orderTrackingId;
  const reference = request.query.OrderMerchantReference || request.query.orderMerchantReference;
  if (typeof tracking !== 'string' || typeof reference !== 'string' || tracking.length > 160 || reference.length > 100) throw new AppError('Payment return references are invalid.', 422, 'PESAPAL_REFERENCE_INVALID');
  const charge = await SubscriptionCharge.findOne({ providerReference: reference }).select('publicId');
  if (!charge) throw new AppError('Subscription payment not found.', 404, 'SUBSCRIPTION_CHARGE_NOT_FOUND');
  await verifySellerSubscriptionPayment(charge.publicId, tracking, request); return response.redirect('/seller/subscription');
}));
export default router;
