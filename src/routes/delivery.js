import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '../core/errors.js';
import rateLimit from '../middleware/rate-limit.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { liveSellerAccountHeader } from '../dashboard/live-account-header.js';
import { DELIVERY_ROUTES, DELIVERY_PAGES, deliveryPath } from '../dashboard/delivery-routes.js';
import { WAREHOUSE_ROUTES } from '../dashboard/warehouse-routes.js';
import { DASHBOARD_PAGES } from '../dashboard/registry.js';
import { deliveryAccess } from '../services/delivery-workspace-access.js';
import { assertWarehouseAccess } from '../services/warehouse-operations.js';
import { advanceDelivery, closeDeliveryException, createDeliveryOffer, deliveryEvidenceImage, loadDeliveryPage, loadWarehouseDeliveryPage, respondDeliveryOffer, reviewCodReceipt, reviewDeliveryProfile, saveDeliveryProfile, setDeliveryAvailability, uploadDeliveryEvidence } from '../services/delivery-workspace.js';
import { savePayoutAccount, requestPayout } from '../services/payments.js';
import { uploadVerificationImage } from '../services/media.js';

const router = Router();
const privatePage = (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); };
const gates = [noStore, privatePage, requireAuth, requireVerified, requireOnboarding];
const verifyCarrier = asyncHandler(async (request, _response, next) => { await deliveryAccess(request); next(); });
const verifyWarehouse = asyncHandler(async (request, _response, next) => { await assertWarehouseAccess(request); next(); });
const mutationLimit = rateLimit({ scope: 'delivery:write', windowMs: 15 * 60_000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false });
const uploadLimit = rateLimit({ scope: 'delivery:evidence', windowMs: 15 * 60_000, limit: 25, standardHeaders: 'draft-8', legacyHeaders: false });
const upload = (request, response, next) => uploadVerificationImage(request, response, error => { if (error) return next(error); try { verifyDeferredCsrf(request); next(); } catch (error) { next(error); } });
const json = request => request.accepts(['html', 'json']) === 'json';
const navigation = DELIVERY_PAGES.map(([id, label, icon, section, title, description]) => ({ id, label, icon, group: section, title, description, ready: true, href: DELIVERY_ROUTES[id] }));
const warehouseRoutes = { ...WAREHOUSE_ROUTES, 'warehouse-carriers': '/warehouse/carriers', 'warehouse-deliveries': '/warehouse/deliveries' };
const warehouseNavigation = [...DASHBOARD_PAGES.warehouse, ...[['warehouse-carriers', 'Carriers', 'i-user', 'Delivery', 'Carrier Verification', 'Review private carrier verification.'], ['warehouse-deliveries', 'Deliveries', 'i-truck', 'Delivery', 'Delivery Operations', 'Offer and review scoped carrier custody.']]].filter((row, index, rows) => rows.findIndex(item => item[0] === row[0]) === index).map(([id, label, icon, section, title, description]) => ({ id, label, icon, group: section, title, description, ready: true, href: warehouseRoutes[id] }));

async function renderDelivery(request, response, mode, error = '') {
  const flow = await loadDeliveryPage(request, mode); flow.error = error; flow.actionKey = randomUUID();
  if (json(request)) return response.json(flow);
  const header = await liveSellerAccountHeader(request);
  return response.render('approved-dashboard', { ...header, workspace: 'delivery', initialPage: 'delivery-' + mode, allowedWorkspaces: ['delivery'], customerRoutes: { ...header.customerRoutes, ...DELIVERY_ROUTES }, liveDelivery: { profileRole: 'Delivery', navigation, flow } });
}
async function renderWarehouse(request, response, mode, error = '') {
  const flow = await loadWarehouseDeliveryPage(request, mode); flow.error = error; flow.actionKey = randomUUID();
  if (json(request)) return response.json(flow);
  const header = await liveSellerAccountHeader(request);
  return response.render('approved-dashboard', { ...header, workspace: 'warehouse', initialPage: 'warehouse-' + mode, allowedWorkspaces: ['warehouse'], customerRoutes: { ...header.customerRoutes, ...warehouseRoutes }, liveDeliveryOperations: { profileRole: 'Warehouse', navigation: warehouseNavigation, flow } });
}
for (const [page, path] of Object.entries(DELIVERY_ROUTES)) {
  router.get(path, ...gates, verifyCarrier, asyncHandler((request, response) => renderDelivery(request, response, page.replace('delivery-', ''))));
  router.get('/dashboard/' + page, ...gates, verifyCarrier, (request, response) => response.redirect(308, path + new URL(request.originalUrl, 'http://localhost').search));
}
for (const mode of ['carriers', 'deliveries']) {
  router.get('/warehouse/' + mode, ...gates, verifyWarehouse, asyncHandler((request, response) => renderWarehouse(request, response, mode)));
  router.get('/dashboard/warehouse-' + mode, ...gates, verifyWarehouse, (request, response) => response.redirect(308, '/warehouse/' + mode + new URL(request.originalUrl, 'http://localhost').search));
}
function action(path, fn, mode, message, { multipart = false, warehouse = false } = {}) {
  router.post(path, ...gates, warehouse ? verifyWarehouse : verifyCarrier, multipart ? uploadLimit : mutationLimit, ...(multipart ? [upload] : []), asyncHandler(async (request, response) => {
    try {
      const result = await fn(request); if (json(request)) return response.json({ ok: true, record: result?.publicId ? { publicId: result.publicId } : result }); setFlash(request, 'success', message);
      let target = warehouse ? '/warehouse/' + mode : deliveryPath(mode);
      if (mode === 'jobs' && request.params.publicId) target += '?record=' + encodeURIComponent(request.params.publicId);
      return response.redirect(303, target);
    } catch (error) {
      if (json(request) || ![409, 422, 428].includes(error.statusCode || error.status)) throw error;
      response.status(error.statusCode || error.status); return warehouse ? renderWarehouse(request, response, mode, error.message) : renderDelivery(request, response, mode, error.message);
    }
  }));
}
action('/delivery/profile', saveDeliveryProfile, 'profile', 'Delivery profile saved.');
action('/delivery/profile/evidence', request => uploadDeliveryEvidence(request, { profile: true }), 'profile', 'Private verification image saved.', { multipart: true });
action('/delivery/availability', setDeliveryAvailability, 'overview', 'Availability updated.');
for (const decision of ['accept', 'decline']) action('/delivery/offers/:publicId/' + decision, request => respondDeliveryOffer(request, decision), 'offers', decision === 'accept' ? 'Delivery assigned to you.' : 'Offer declined.');
action('/delivery/jobs/:publicId/evidence', uploadDeliveryEvidence, 'jobs', 'Private delivery evidence saved.', { multipart: true });
action('/delivery/jobs/:publicId/cod-handover', request => uploadDeliveryEvidence(request, { cod: true }), 'jobs', 'Cash receipt recorded for independent Warehouse review.', { multipart: true });
for (const status of ['picked_up', 'in_transit', 'delivered', 'failed', 'rescheduled', 'return_to_sender', 'returned']) action('/delivery/jobs/:publicId/' + status, request => advanceDelivery(request, status), 'jobs', 'Delivery custody updated.');
action('/warehouse/carriers/:publicId/review', reviewDeliveryProfile, 'carriers', 'Carrier verification reviewed.', { warehouse: true });
action('/warehouse/deliveries/:publicId/offer', createDeliveryOffer, 'deliveries', 'Explicit delivery offer created.', { warehouse: true });
action('/warehouse/deliveries/:publicId/review-cod', reviewCodReceipt, 'deliveries', 'Cash receipt reviewed for Finance.', { warehouse: true });
action('/warehouse/delivery-exceptions/:publicId/resolve', closeDeliveryException, 'deliveries', 'Delivery exception reviewed.', { warehouse: true });
// Existing logistics forms use the same current transactional boundaries.
action('/operations/logistics/delivery/:publicId/review', reviewDeliveryProfile, 'carriers', 'Carrier verification reviewed.', { warehouse: true });
action('/operations/logistics/shipments/:publicId/offer', createDeliveryOffer, 'deliveries', 'Delivery offer created.', { warehouse: true });
action('/operations/logistics/exceptions/:publicId/resolve', closeDeliveryException, 'deliveries', 'Exception reviewed.', { warehouse: true });

const payoutAccountInput = z.object({ method: z.enum(['bank', 'mobile_money']), label: z.string().trim().min(2).max(100), beneficiaryName: z.string().trim().min(2).max(120), institution: z.string().trim().min(2).max(40), account: z.string().trim().min(4).max(80) });
action('/delivery/earnings/accounts', async request => {
  const input = payoutAccountInput.parse(request.body); await deliveryAccess(request, { approved: true });
  const destination = input.method === 'bank' ? { beneficiary_name: input.beneficiaryName, account_bank: input.institution, account_number: input.account } : { beneficiary_name: input.beneficiaryName, network: input.institution, phone: input.account };
  return savePayoutAccount(request, { method: input.method, label: input.label, destination });
}, 'earnings', 'Payout destination submitted for independent Finance verification.');
action('/delivery/earnings/payouts', async request => {
  await deliveryAccess(request, { approved: true }); const input = z.object({ payoutAccountId: z.string().min(5).max(100), amountMinor: z.coerce.number().int().positive().safe(), idempotencyKey: z.string().min(8).max(120) }).parse(request.body); return requestPayout(request, input);
}, 'earnings', 'Available earnings reserved for Finance payout review.');
for (const warehouse of [false, true]) router.get((warehouse ? '/warehouse' : '/delivery') + '/evidence/:publicId', ...gates, warehouse ? verifyWarehouse : verifyCarrier, asyncHandler(async (request, response) => {
  const image = await deliveryEvidenceImage(request, { warehouse }); response.set('Content-Disposition', 'inline'); response.set('X-Content-Type-Options', 'nosniff'); return response.type('image/webp').send(image);
}));
// The previous offline endpoint did not bind a replay to a current Device or input version.
router.post('/api/v1/delivery/actions', ...gates, verifyCarrier, mutationLimit, asyncHandler(async (request, response) => {
  const action = z.object({ shipmentPublicId: z.string().min(5).max(100), status: z.enum(['picked_up', 'in_transit', 'delivered', 'failed', 'rescheduled', 'return_to_sender', 'returned']), version: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]), proofCode: z.string().max(6).optional(), reason: z.string().max(240).optional(), reasonCode: z.string().max(40).optional(), rescheduledFor: z.string().max(60).optional() }).parse(request.body);
  request.params.publicId = action.shipmentPublicId; request.body = { ...request.body, ...action }; const result = await advanceDelivery(request, action.status); return response.json({ ok: true, shipment: { publicId: result.publicId, status: result.status, version: result.__v || 0 } });
}));
export default router;
