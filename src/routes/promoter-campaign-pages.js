import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { setFlash } from '../middleware/view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { promoterPageGates, renderPromoterPage } from '../dashboard/promoter-page-view.js';
import { promoterCampaignPage, promoterProfilePage, secureApplyToCampaign, secureCreatePromoterLink, secureBuildCampaignContentKit, secureSubmitPromoterVerification, updatePromoterLink, savePromoterProfile } from '../services/promoter-campaign-pages.js';

const router = Router();
const gates = promoterPageGates();
const mutationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const pages = ['marketplace', 'campaigns', 'links', 'content'];
const pageId = mode => mode === 'marketplace' ? 'promoter-marketplace' : 'promoter-' + mode;
async function render(request, response, mode, error = '') {
  const pageRequest = Object.create(request);
  Object.defineProperty(pageRequest, 'query', { value: { ...request.query, ...(error && mode === 'campaigns' && request.params.id ? { campaign: request.params.id } : {}) }, configurable: true });
  const data = mode === 'profile' ? await promoterProfilePage(pageRequest) : await promoterCampaignPage(pageRequest, mode);
  if (error) {
    data.error = error;
    data.draft = Object.fromEntries(Object.entries(request.body || {}).filter(([name, value]) => name !== '_csrf' && typeof value === 'string').map(([name, value]) => [name, value.slice(0, 1200)]));
    data.draftSection = request.path.split('/').at(-1);
    if (request.params.id) data.draftId = request.params.id;
    if (mode === 'profile') data.section = ({ identity: 'profile', channels: 'business', verification: 'business', preferences: 'notifications' })[data.draftSection] || data.section;
  }
  return renderPromoterPage(request, response, mode === 'profile' ? 'promoter-profile' : pageId(mode), data);
}
function action(mode, work, message, destination) {
  return asyncHandler(async (request, response) => {
    try {
      verifyDeferredCsrf(request);
      const result = await work(request);
      setFlash(request, 'success', message);
      return response.redirect(typeof destination === 'function' ? destination(result) : destination || '/promoter/' + mode);
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      response.status(status);
      return render(request, response, mode, error.name === 'ZodError' ? error.issues[0].message : error.message);
    }
  });
}
for (const mode of pages) {
  router.get('/promoter/' + mode, ...gates, asyncHandler((request, response) => render(request, response, mode)));
  router.get('/promoter/' + mode + '/export.csv', ...gates, mutationLimit, asyncHandler(async (request, response) => {
    const cell = value => { let string = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/u.test(string)) string = "'" + string; return '"' + string.replaceAll('"', '""') + '"'; };
    const flow = await promoterCampaignPage(request, mode);
    response.type('text/csv').set('Content-Disposition', 'attachment; filename="classic-mart-promoter-' + mode + '.csv"');
    response.write(flow.columns.map(cell).join(',') + '\r\n');
    let current = flow;
    while (!response.destroyed) {
      const output = current.rows.map(row => row.cells.map(cell).join(',') + '\r\n').join('');
      if (output && !response.write(output)) await new Promise((resolve, reject) => {
        const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
        const drained = () => { cleanup(); resolve(); }, closed = () => { cleanup(); resolve(); }, failed = error => { cleanup(); reject(error); };
        response.once('drain', drained); response.once('close', closed); response.once('error', failed);
      });
      if (!current.page.next) break;
      const nextRequest = Object.create(request);
      Object.defineProperty(nextRequest, 'query', { value: { ...request.query, after: current.page.next }, configurable: true });
      current = await promoterCampaignPage(nextRequest, mode);
    }
    if (!response.destroyed) response.end();
  }));
}
router.get('/promoter/profile', ...gates, asyncHandler((request, response) => render(request, response, 'profile')));
router.post('/promoter/campaigns/:id/apply', ...gates, mutationLimit, action('campaigns', request => secureApplyToCampaign(request, request.params.id, request.body.note || ''), 'Campaign application saved.', result => '/promoter/campaigns?campaign=' + encodeURIComponent(result.campaignPublicId)));
router.post('/promoter/links', ...gates, mutationLimit, action('links', request => secureCreatePromoterLink(request, request.body), 'Tracking link created.'));
router.post('/promoter/links/:id/update', ...gates, mutationLimit, action('links', request => updatePromoterLink(request), 'Tracking link saved.'));
router.post('/promoter/links/:id/deactivate', ...gates, mutationLimit, action('links', request => updatePromoterLink(request, { deactivate: true }), 'Tracking link deactivated.'));
router.post('/promoter/content', ...gates, mutationLimit, action('content', request => secureBuildCampaignContentKit(request, request.body), 'Content kit saved using the approved campaign facts.', result => '/promoter/content?kit=' + encodeURIComponent(result.publicId)));
for (const section of ['identity', 'channels', 'preferences']) router.post('/promoter/profile/' + section, ...gates, mutationLimit, action('profile', request => savePromoterProfile(request, section), 'Profile settings saved.', '/promoter/profile?section=' + ({ identity: 'profile', channels: 'business', preferences: 'notifications' })[section]));
router.post('/promoter/profile/verification', ...gates, mutationLimit, action('profile', request => secureSubmitPromoterVerification(request, request.body), 'Promoter verification submitted for review.', '/promoter/profile?section=business'));
export default router;
