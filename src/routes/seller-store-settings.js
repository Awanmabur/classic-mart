import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { canAccessWorkspace } from '../dashboard/access.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { renderSellerStore } from '../dashboard/seller-store-view.js';
import { saveSellerStoreSettings } from '../services/seller-store-settings.js';
import { setFlash } from '../middleware/view.js';
import { Store } from '../models/index.js';

const router = Router();
const gates = [noStore, requireAuth, requireVerified, requireOnboarding,
  (request, response, next) => {
    response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return canAccessWorkspace(request.user, 'seller') ? next() : next(new AppError('You do not have access to this dashboard.', 403, 'DASHBOARD_FORBIDDEN'));
  }, loadSellerStore, requireStoreCapability('staff')];
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
router.get('/seller/store', ...gates, asyncHandler((request, response) => renderSellerStore(request, response)));
router.get('/dashboard/seller-store', ...gates.slice(0, 5), (request, response) => {
  const search = new URL(request.originalUrl, 'http://localhost').search;
  response.redirect(308, '/seller/store' + search);
});
for (const section of ['identity', 'operations']) {
  router.post('/seller/store/' + section, ...gates, limiter, asyncHandler(async (request, response) => {
    try {
      await saveSellerStoreSettings(request, section);
      setFlash(request, 'success', 'Store settings saved.');
      return response.redirect('/seller/store?section=' + section);
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![422, 409].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      request.store = await Store.findById(request.store._id);
      if (!request.store) throw error;
      const message = error.name === 'ZodError' ? error.issues[0].message : error.message;
      const limits = section === 'identity' ? { name: 140, description: 1500, supportEmail: 254, supportPhone: 30, supportPhoneCountry: 2 } : { primaryCategory: 100, pickupCity: 120, fulfillmentMode: 20 };
      const draft = status === 422 ? Object.fromEntries(Object.entries(limits).filter(([field]) => typeof request.body[field] === 'string').map(([field, max]) => [field, request.body[field].slice(0, max)])) : {};
      response.status(status);
      return renderSellerStore(request, response, { error: message, section, draft });
    }
  }));
}
export default router;
