import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { requireAuth, requirePermission, requireVerified } from '../middleware/auth.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { setFlash } from '../middleware/view.js';
import { requestPayout, savePayoutAccount } from '../services/payments.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import { writeAudit } from '../services/audit.js';
import { operationalCountryScope } from '../services/authorization.js';
import { AiJob, AttributionTouch, Campaign, CampaignApplication, CommissionEntry, Product, PromoterContactRequest, PromoterVerification, Store } from '../models/index.js';
import {
  appealCommissionReversal, applyToCampaign, buildCampaignContentKit, createCampaign, createPromoterLink, promoterSummary, recordTouch, redeemPromoterCoupon, reviewCommissionAppeal, streamPromoterCommissionCsv,
  reviewCampaign, reviewCampaignApplication, reviewPromoterVerification, submitCampaign, submitPromoterVerification,
} from '../services/promoters.js';

const router = Router();
const adminOnly = (request, _response, next) => ['country_admin', 'super_admin'].includes(request.user?.role) ? next() : next(new AppError('Country or Super Admin required.', 403, 'FORBIDDEN'));
const campaignInput = z.object({
  name: z.string().trim().min(3).max(140), visibility: z.enum(['public', 'invite_only']).default('public'), commissionBps: z.coerce.number().int().min(0).max(5000), attributionDays: z.coerce.number().int().min(1).max(90),
  allowedChannels: z.array(z.string().trim().min(2).max(50)).max(12).default([]), facts: z.array(z.string().trim().min(2).max(240)).min(1).max(20), productPublicIds: z.array(z.string().trim().min(4).max(100)).min(1).max(100),
  assets: z.array(z.object({ type: z.enum(['image', 'video', 'document', 'copy']), url: z.string().trim().max(800).default(''), label: z.string().trim().max(120).default(''), approved: z.boolean().default(false) })).max(30).default([]),
  disclosureText: z.string().trim().min(10).max(300).default('Sponsored/affiliate promotion for Classic Mart.'), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(),
}).refine(value => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, { message: 'Campaign end must be after its start.' });

function csv(value){return String(value||'').split(',').map(x=>x.trim()).filter(Boolean);}
function lines(value){return String(value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);}
function campaignForm(body){return campaignInput.parse({name:body.name,visibility:body.visibility,commissionBps:body.commissionBps,attributionDays:body.attributionDays,allowedChannels:csv(body.allowedChannels),facts:lines(body.facts),productPublicIds:csv(body.productPublicIds),assets:[],disclosureText:body.disclosureText,startsAt:body.startsAt||undefined,endsAt:body.endsAt||undefined});}


router.get('/r/:token', async (request, response, next) => { try { const { link, touch } = await recordTouch(request, request.params.token); if (touch.status === 'blocked') return response.status(403).render('error', { status: 403, message: 'This promotional visit was blocked by marketplace protection.' }); const separator = link.destination.includes('?') ? '&' : '?'; const params = new URLSearchParams({ utm_source: link.utmSource, utm_medium: link.utmMedium, utm_campaign: link.utmCampaign, ...(link.utmContent ? { utm_content: link.utmContent } : {}), ...(link.subId ? { sub_id: link.subId } : {}) }); response.redirect(302, `${link.destination}${separator}${params}`); } catch (error) { next(error); } });


router.post('/api/v1/promoters/verification', requireAuth, requireVerified, requirePermission('promoter:manage'), async (request, response, next) => { try { const input = z.object({ channels: z.array(z.string().trim().min(2).max(50)).min(1).max(10), niches: z.array(z.string().trim().min(2).max(50)).min(1).max(12) }).parse(request.body); response.status(201).json({ verification: await submitPromoterVerification(request, input) }); } catch (error) { next(error); } });

router.post('/api/v1/admin/promoters/:id/review', requireAuth, requireVerified, adminOnly, async (request, response, next) => { try { const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).default('') }).parse(request.body); response.json({ verification: await reviewPromoterVerification(request, request.params.id, input) }); } catch (error) { next(error); } });


router.get('/api/v1/campaigns', async (request, response, next) => { try { const now = new Date(),limit=Math.max(1,Math.min(100,Number(request.query.limit)||50)); const base={ country: request.country.code, status: 'active', $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }] }; const [rows,total]=await Promise.all([Campaign.find(cursorScope(base,request.query.after)).select('-ownerUserId').sort(cursorSort()).limit(limit+1).lean(),Campaign.countDocuments(base)]);const page=pageResult(rows,{limit,total}); response.json({ campaigns:page.items,page:page.page }); } catch (error) { next(error); } });

router.post('/api/v1/seller/campaigns', requireAuth, requireVerified, loadSellerStore, requireStoreCapability('growth'), async (request, response, next) => { try { response.status(201).json({ campaign: await createCampaign(request, campaignInput.parse(request.body)) }); } catch (error) { next(error); } });

router.post('/api/v1/seller/campaigns/:id/submit', requireAuth, requireVerified, loadSellerStore, requireStoreCapability('growth'), async (request, response, next) => { try { response.json({ campaign: await submitCampaign(request, request.params.id) }); } catch (error) { next(error); } });

router.post('/api/v1/admin/campaigns/:id/review', requireAuth, requireVerified, adminOnly, async (request, response, next) => { try { const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).default('') }).parse(request.body); response.json({ campaign: await reviewCampaign(request, request.params.id, input) }); } catch (error) { next(error); } });


router.post('/api/v1/promoters/campaigns/:id/apply', requireAuth, requireVerified, requirePermission('promoter:manage'), async (request, response, next) => { try { const input = z.object({ note: z.string().trim().max(1000).default('') }).parse(request.body || {}); response.status(201).json({ application: await applyToCampaign(request, request.params.id, input.note) }); } catch (error) { next(error); } });

router.post('/api/v1/seller/campaign-applications/:id/review', requireAuth, requireVerified, loadSellerStore, requireStoreCapability('growth'), async (request, response, next) => { try { const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).default('') }).parse(request.body); response.json({ application: await reviewCampaignApplication(request, request.params.id, input) }); } catch (error) { next(error); } });

router.post('/api/v1/promoters/coupons/redeem', async (request, response, next) => { try { const input = z.object({ code: z.string().trim().min(2).max(32) }).parse(request.body); const { link, touch } = await redeemPromoterCoupon(request, input.code); response.json({ attribution: { linkId: link.publicId, touchId: touch.publicId, status: touch.status } }); } catch (error) { next(error); } });

router.post('/api/v1/promoters/links', requireAuth, requireVerified, requirePermission('promoter:manage'), async (request, response, next) => { try { const input = z.object({ campaignId: z.string().min(4).max(100), destination: z.string().trim().regex(/^\/[A-Za-z0-9/_?&=.%+-]*$/).max(500), couponCode: z.string().trim().max(32).optional(), subId: z.string().trim().max(80).optional(), channel: z.string().trim().max(50).optional(), utmSource: z.string().trim().max(80).optional(), utmMedium: z.string().trim().max(80).optional(), utmCampaign: z.string().trim().max(100).optional(), utmContent: z.string().trim().max(100).optional() }).parse(request.body); const link = await createPromoterLink(request, input); response.status(201).json({ link: { ...link.toObject(), url: `/r/${link.token}` } }); } catch (error) { next(error); } });


router.get('/api/v1/promoters/me/summary', requireAuth, requireVerified, requirePermission('promoter:manage'), async (request, response, next) => { try { response.json(await promoterSummary(request.user, request.query)); } catch (error) { next(error); } });

export default router;
