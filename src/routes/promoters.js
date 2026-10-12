import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { asyncHandler, AppError } from '../core/errors.js';
import { requireAuth, requirePermission, requireVerified } from '../middleware/auth.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { sellerPageGates } from '../dashboard/seller-page-view.js';
import { promoterPageGates } from '../dashboard/promoter-page-view.js';
import { loadPromoterOverview } from '../services/promoter-overview.js';
import { eligiblePromoterCampaigns, publicCampaignMetadata } from '../services/promoter-campaign-pages.js';
import { CountrySetting } from '../models/index.js';
import {
  applyToCampaign, createCampaign, createPromoterLink, recordTouch, redeemPromoterCoupon,
  reviewCampaign, reviewCampaignApplication, reviewPromoterVerification, submitCampaign, submitPromoterVerification,
} from '../services/promoters.js';

const router = Router();
const sellerCampaignGates = sellerPageGates('growth');
const promoterMutationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const deferredCsrf = (request, _response, next) => { try { verifyDeferredCsrf(request); next(); } catch (error) { next(error); } };
router.use(['/api/v1/promoters/verification', '/api/v1/promoters/links', '/api/v1/promoters/campaigns/:id/apply', '/api/v1/promoters/coupons/redeem'], (request, response, next) => request.method === 'POST' ? promoterMutationLimit(request, response, next) : next(), deferredCsrf);
const sellerCampaignCsrf = (request, _response, next) => {
  // These legacy endpoints use browser sessions, unlike the bearer Seller API.
  try { request.csrfDeferred = true; verifyDeferredCsrf(request); next(); } catch (error) { next(error); }
};
const adminOnly = (request, _response, next) => ['country_admin', 'super_admin'].includes(request.user?.role) ? next() : next(new AppError('Country or Super Admin required.', 403, 'FORBIDDEN'));
const campaignInput = z.object({
  name: z.string().trim().min(3).max(140), visibility: z.enum(['public', 'invite_only']).default('public'), commissionBps: z.coerce.number().int().min(0).max(5000), attributionDays: z.coerce.number().int().min(1).max(90),
  allowedChannels: z.array(z.string().trim().min(2).max(50)).max(12).default([]), facts: z.array(z.string().trim().min(2).max(240)).min(1).max(20), productPublicIds: z.array(z.string().trim().min(4).max(100)).min(1).max(100),
  assets: z.array(z.object({ type: z.enum(['image', 'video', 'document', 'copy']), url: z.string().trim().max(800).default(''), label: z.string().trim().max(120).default(''), approved: z.boolean().default(false) })).max(30).default([]),
  disclosureText: z.string().trim().min(10).max(300).default('Sponsored/affiliate promotion for Classic Mart.'), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(),
}).refine(value => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, { message: 'Campaign end must be after its start.' });

router.get('/r/:token', async (request, response, next) => { try { const { link, touch } = await recordTouch(request, request.params.token); if (touch.status === 'blocked') return response.status(403).render('error', { status: 403, message: 'This promotional visit was blocked by marketplace protection.' }); const separator = link.destination.includes('?') ? '&' : '?'; const params = new URLSearchParams({ utm_source: link.utmSource, utm_medium: link.utmMedium, utm_campaign: link.utmCampaign, ...(link.utmContent ? { utm_content: link.utmContent } : {}), ...(link.subId ? { sub_id: link.subId } : {}) }); response.redirect(302, `${link.destination}${separator}${params}`); } catch (error) { next(error); } });


router.post('/api/v1/promoters/verification', ...promoterPageGates(), async (request, response, next) => { try { verifyDeferredCsrf(request); const input = z.object({ channels: z.array(z.string().trim().min(2).max(50)).min(1).max(10), niches: z.array(z.string().trim().min(2).max(50)).min(1).max(12), disclosureAccepted: z.literal(true) }).parse(request.body); response.status(201).json({ verification: await submitPromoterVerification(request, input) }); } catch (error) { next(error); } });

router.post('/api/v1/admin/promoters/:id/review', requireAuth, requireVerified, adminOnly, async (request, response, next) => { try { const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).default('') }).parse(request.body); response.json({ verification: await reviewPromoterVerification(request, request.params.id, input) }); } catch (error) { next(error); } });


router.get('/api/v1/campaigns', asyncHandler(async (request, response) => {
  const query = new URL(request.originalUrl, 'http://localhost').searchParams;
  for (const name of ['limit', 'after']) if (query.getAll(name).length > 1 || [...query.keys()].some(key => key.startsWith(name + '[') || key.startsWith(name + '.'))) throw new AppError('Provide one supported value for each filter.', 422, 'CAMPAIGN_QUERY_INVALID');
  const input = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), after: z.string().max(512).default('') }).parse(request.query);
  const setting = await CountrySetting.findOne({ code: request.country.code, active: true }).lean();
  if (!setting) throw new AppError('Campaign market is unavailable.', 409, 'CAMPAIGN_MARKET_UNAVAILABLE');
  const result = await eligiblePromoterCampaigns(setting, { visibility: 'public', limit: input.limit, after: input.after });
  response.json({ campaigns: result.items.map(publicCampaignMetadata), page: result.page });
}));

router.post('/api/v1/seller/campaigns', ...sellerCampaignGates, sellerCampaignCsrf, async (request, response, next) => { try { response.status(201).json({ campaign: await createCampaign(request, campaignInput.parse(request.body)) }); } catch (error) { next(error); } });

router.post('/api/v1/seller/campaigns/:id/submit', ...sellerCampaignGates, sellerCampaignCsrf, async (request, response, next) => { try { response.json({ campaign: await submitCampaign(request, request.params.id) }); } catch (error) { next(error); } });

router.post('/api/v1/admin/campaigns/:id/review', requireAuth, requireVerified, adminOnly, async (request, response, next) => { try { const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).default('') }).parse(request.body); response.json({ campaign: await reviewCampaign(request, request.params.id, input) }); } catch (error) { next(error); } });


router.post('/api/v1/promoters/campaigns/:id/apply', requireAuth, requireVerified, requirePermission('promoter:manage'), async (request, response, next) => { try { const input = z.object({ note: z.string().trim().max(1000).default('') }).parse(request.body || {}); response.status(201).json({ application: await applyToCampaign(request, request.params.id, input.note) }); } catch (error) { next(error); } });

router.post('/api/v1/seller/campaign-applications/:id/review', ...sellerCampaignGates, sellerCampaignCsrf, async (request, response, next) => { try { const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).default('') }).parse(request.body); response.json({ application: await reviewCampaignApplication(request, request.params.id, input) }); } catch (error) { next(error); } });

router.post('/api/v1/promoters/coupons/redeem', async (request, response, next) => { try { const input = z.object({ code: z.string().trim().min(2).max(32) }).parse(request.body); const { link, touch } = await redeemPromoterCoupon(request, input.code); response.json({ attribution: { linkId: link.publicId, touchId: touch.publicId, status: touch.status } }); } catch (error) { next(error); } });

router.post('/api/v1/promoters/links', requireAuth, requireVerified, requirePermission('promoter:manage'), async (request, response, next) => { try { const input = z.object({ campaignId: z.string().min(4).max(100), destination: z.string().trim().regex(/^\/[A-Za-z0-9/_?&=.%+-]*$/).max(500), couponCode: z.string().trim().max(32).optional(), subId: z.string().trim().max(80).optional(), channel: z.string().trim().max(50).optional(), utmSource: z.string().trim().max(80).optional(), utmMedium: z.string().trim().max(80).optional(), utmCampaign: z.string().trim().max(100).optional(), utmContent: z.string().trim().max(100).optional() }).parse(request.body); const link = await createPromoterLink(request, input); response.status(201).json({ link: { ...link.toObject(), url: `/r/${link.token}` } }); } catch (error) { next(error); } });


router.get('/api/v1/promoters/me/summary', ...promoterPageGates(), asyncHandler(async (request, response) => {
  const query = new URL(request.originalUrl, 'http://localhost').searchParams;
  if (query.getAll('period').length > 1 || [...query.keys()].some(key => /^period(?:\[|\.)/.test(key))) throw new AppError('Select one supported reporting period.', 422, 'PROMOTER_PERIOD_INVALID');
  const overview = await loadPromoterOverview(request);
  response.json({ market: overview.market, period: overview.period, analytics: overview.analytics, finance: overview.finance,
    availableMinor: overview.availableMinor, activeCampaigns: overview.activeCampaigns, monthEarnedMinor: overview.monthEarnedMinor });
}));

export default router;
