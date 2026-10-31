import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { countryAdminPageGates, renderCountryAdminPage } from '../dashboard/country-admin-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadCountryAdminGrowthPage, streamCountryAdminGrowthCsv, createCountryCoupon, updateCountryCoupon, changeCountryCouponStatus, saveCountryMessagingCampaign, queueCountryMessagingCampaign,
  cancelCountryMessagingCampaign, decideCountryAffiliateCampaign, saveCountryCmsRevision, requestCountryCmsPublication, decideCountryCmsApproval, cancelCountryCmsSchedule } from '../services/country-admin-growth-pages.js';

const router = Router();
const mutationLimit = rateLimit({ scope: 'country-admin-growth-pages:1', windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const exportLimit = rateLimit({ scope: 'country-admin-growth-pages:2', windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
for (const slug of ['coupons', 'campaigns', 'content']) {
  const path = '/admin/' + slug, pageId = 'admin-' + slug;
  router.get(path, ...countryAdminPageGates(), asyncHandler(async (request, response) => renderCountryAdminPage(request, response, pageId, await loadCountryAdminGrowthPage(request, pageId))));
  router.get(path + '/export.csv', ...countryAdminPageGates(), exportLimit, asyncHandler(async (request, response) => streamCountryAdminGrowthCsv(request, response, pageId)));
}
function mutation(pageId, operation, message, tab = '') { return asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  try { const result = await operation(request); if (request.accepts(['html', 'json']) === 'json') return response.json(result); setFlash(request, 'success', message); const params = new URLSearchParams(); if (/^[A-Z]{2}$/.test(request.body?.country || '')) params.set('country', request.body.country); if (tab) params.set('tab', tab); return response.redirect('/admin/' + pageId.slice(6) + (params.size ? '?' + params : '')); }
  catch (error) { const status = error.name === 'ZodError' ? 422 : error.status; if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error; const flow = await loadCountryAdminGrowthPage(request, pageId); flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message; flow.draft = Object.fromEntries(Object.entries(request.body || {}).filter(([key, value]) => key !== '_csrf' && typeof value === 'string').map(([key, value]) => [key, value.slice(0, key === 'body' ? 20000 : 1000)])); response.status(status); return renderCountryAdminPage(request, response, pageId, flow); }
}); }
router.post('/admin/coupons', ...countryAdminPageGates(), mutationLimit, mutation('admin-coupons', request => createCountryCoupon(request, request.body || {}), 'Coupon saved.'));
router.post('/admin/coupons/:id/update', ...countryAdminPageGates(), mutationLimit, mutation('admin-coupons', request => updateCountryCoupon(request, request.params.id, request.body || {}), 'Coupon updated.'));
router.post('/admin/coupons/:id/status', ...countryAdminPageGates(), mutationLimit, mutation('admin-coupons', request => changeCountryCouponStatus(request, request.params.id, request.body || {}), 'Coupon availability updated.'));
router.post('/admin/campaigns/messaging', ...countryAdminPageGates(), mutationLimit, mutation('admin-campaigns', request => saveCountryMessagingCampaign(request, request.body || {}), 'Consent campaign saved.', 'messaging'));
router.post('/admin/campaigns/messaging/:id/update', ...countryAdminPageGates(), mutationLimit, mutation('admin-campaigns', request => saveCountryMessagingCampaign(request, request.body || {}, request.params.id), 'Consent campaign updated.', 'messaging'));
router.post('/admin/campaigns/messaging/:id/queue', ...countryAdminPageGates(), mutationLimit, mutation('admin-campaigns', request => queueCountryMessagingCampaign(request, request.params.id, request.body || {}), 'Delivery work queued. Each recipient’s current consent is checked before sending.', 'messaging'));
router.post('/admin/campaigns/messaging/:id/cancel', ...countryAdminPageGates(), mutationLimit, mutation('admin-campaigns', request => cancelCountryMessagingCampaign(request, request.params.id, request.body || {}), 'Campaign cancelled. Pending deliveries will be suppressed.', 'messaging'));
router.post('/admin/campaigns/affiliate/:id/decision', ...countryAdminPageGates(), mutationLimit, mutation('admin-campaigns', request => decideCountryAffiliateCampaign(request, request.params.id, request.body || {}), 'Seller campaign decision recorded.', 'affiliate'));
router.post('/admin/content/revisions', ...countryAdminPageGates(), mutationLimit, mutation('admin-content', request => saveCountryCmsRevision(request, request.body || {}), 'Draft revision saved.'));
router.post('/admin/content/:id/publication', ...countryAdminPageGates(), mutationLimit, mutation('admin-content', request => requestCountryCmsPublication(request, request.params.id, request.body || {}), 'Publication request saved for independent approval.'));
router.post('/admin/content/:id/cancel-schedule', ...countryAdminPageGates(), mutationLimit, mutation('admin-content', request => cancelCountryCmsSchedule(request, request.params.id, request.body || {}), 'Scheduled publication cancelled. The current public version is preserved.'));
router.post('/admin/content/approvals/:id/decision', ...countryAdminPageGates(), mutationLimit, mutation('admin-content', request => decideCountryCmsApproval(request, request.params.id, request.body || {}), 'Publication decision recorded.'));
export default router;
