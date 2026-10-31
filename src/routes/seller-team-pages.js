import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { renderSellerPage, sellerPageGates } from '../dashboard/seller-page-view.js';
import { accountWorkspaceView } from '../dashboard/account-workspace-view.js';
import { sellerTeamPage, inviteStoreTeamMember, updateStoreTeamMember, revokeStoreTeamInvitation, storeInvitationInbox, decideStoreTeamInvitation, selectSellerWorkspace } from '../services/seller-team-pages.js';
const router = Router();
const limit = rateLimit({ scope: 'seller-team:1', windowMs: 15 * 60000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const privatePage = (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); };
const accountGates = [noStore, privatePage, requireAuth, requireVerified, requireOnboarding];
function mutation(work, destination, message) { return asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  const result = await work(request);
  if (request.accepts(['html', 'json']) === 'json') return response.json(result);
  setFlash(request, 'success', message);
  return response.redirect(typeof destination === 'function' ? destination(result) : destination);
}); }
router.get('/seller/team', ...sellerPageGates('staff'), asyncHandler(async (request, response) => renderSellerPage(request, response, 'seller-team', await sellerTeamPage(request))));
router.post('/seller/team/invitations', ...sellerPageGates('staff'), limit, mutation(request => inviteStoreTeamMember(request, request.body), '/seller/team', 'Invitation recorded. The verified recipient must accept before gaining access.'));
router.post('/seller/team/invitations/:id/revoke', ...sellerPageGates('staff'), limit, mutation(request => revokeStoreTeamInvitation(request, request.params.id, request.body), '/seller/team', 'Invitation revoked.'));
router.post('/seller/team/members/:id', ...sellerPageGates('staff'), limit, mutation(request => updateStoreTeamMember(request, request.params.id, request.body), '/seller/team', 'Store membership updated.'));
router.post('/seller/workspace', ...accountGates, limit, mutation(request => selectSellerWorkspace(request, request.body), result => result.landing, 'Store workspace selected.'));
router.get('/account/store-invitations', ...accountGates, asyncHandler(async (request, response) => {
  const flow = await storeInvitationInbox(request);
  if (request.accepts(['html', 'json']) === 'json') return response.json(flow);
  return response.render('approved-dashboard', { ...await accountWorkspaceView(request, 'store-invitations'), storeInvitationFlow: flow });
}));
for (const [suffix, decision] of [['accept', 'accept'], ['reject', 'reject']]) router.post(`/account/store-invitations/:id/${suffix}`, ...accountGates, limit, mutation(async request => {
  const result = await decideStoreTeamInvitation(request, request.params.id, { ...request.body, decision });
  // Acceptance alone never silently switches the user's current store.
  return result;
}, '/account/store-invitations', decision === 'accept' ? 'Invitation accepted. Select the store to open its workspace.' : 'Invitation declined.'));
export default router;
