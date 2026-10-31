import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { sellerAffiliatePage, createSellerAffiliateCampaign, editSellerAffiliateCampaign, transitionSellerAffiliateCampaign, decideSellerAffiliateApplication } from '../services/seller-affiliate-pages.js';
const router = Router();
const limit = rateLimit({ scope: 'seller-affiliate:1', windowMs: 15 * 60000, limit: 50, standardHeaders: 'draft-8', legacyHeaders: false });
router.get('/seller/affiliate', ...sellerPageGates('growth'), asyncHandler(async (request, response) => renderSellerPage(request, response, 'seller-affiliate', await sellerAffiliatePage(request))));
for (const [path, work] of [['/seller/affiliate/campaigns', request => createSellerAffiliateCampaign(request, request.body)], ['/seller/affiliate/campaigns/:id/edit', request => editSellerAffiliateCampaign(request, request.params.id, request.body)], ['/seller/affiliate/campaigns/:id', request => transitionSellerAffiliateCampaign(request, request.params.id, request.body)], ['/seller/affiliate/applications/:id', request => decideSellerAffiliateApplication(request, request.params.id, request.body)]]) {
  router.post(path, ...sellerPageGates('growth'), limit, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request); const result = await work(request);
    if (request.accepts(['html', 'json']) === 'json') return response.json(result);
    setFlash(request, 'success', 'Affiliate campaign records updated.'); return response.redirect('/seller/affiliate');
  }));
}
export default router;
