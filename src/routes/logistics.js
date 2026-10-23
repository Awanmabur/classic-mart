import mongoose from 'mongoose';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { DeliveryProfile, Shipment, ShippingZone } from '../models/index.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import rateLimit from '../middleware/rate-limit.js';
import { setFlash } from '../middleware/view.js';
import { dashboardLanding } from '../dashboard/landing.js';
import { primaryWorkspaceFor } from '../dashboard/access.js';
import { writeAudit } from '../services/audit.js';
import { reconcileCod, reconcileCodBatch } from '../services/logistics.js';
import { countryAdminAccess } from '../services/country-admin-workspace-access.js';
import { financeAccess } from '../services/finance-workspace-access.js';
import { createWarehouseShipment } from '../services/delivery-workspace.js';

const router = Router();
const mutationLimit = rateLimit({ scope: 'logistics:write', windowMs: 15 * 60_000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false });
router.use('/operations/logistics', noStore, requireAuth, requireVerified, requireOnboarding, mutationLimit);
// Carrier custody and Warehouse reviews have one implementation in delivery.js.
// Retain only operational shipment repair, market configuration and Finance
// reconciliation. Every write rebuilds current database authority.
router.post('/operations/logistics/orders/:publicId/shipment', asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  await createWarehouseShipment(request);
  response.redirect(303, '/warehouse/deliveries');
}));
const zoneInput = z.object({
  country: z.string().trim().regex(/^[A-Z]{2}$/), currency: z.string().trim().regex(/^[A-Z]{3}$/), name: z.string().trim().min(2).max(120),
  cities: z.string().trim().min(2).max(1800).transform(value => [...new Set(value.split(',').map(city => city.trim()).filter(Boolean))])
    .refine(value => value.length > 0 && value.length <= 30 && value.every(city => city.length <= 60), 'Choose up to 30 cities.'),
  standardFeeMinor: z.coerce.number().int().min(0).max(2_000_000_000), expressFeeMinor: z.coerce.number().int().min(0).max(2_000_000_000),
  standardSlaHours: z.coerce.number().int().min(1).max(720).default(120), expressSlaHours: z.coerce.number().int().min(1).max(720).default(48),
});
router.post('/operations/logistics/zones', asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  const input = zoneInput.parse(request.body), session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const access = await countryAdminAccess(request, { session, write: true, workspace: false, country: input.country });
      if (access.market?.currency !== input.currency) throw new AppError('Choose the configured market currency.', 422, 'DELIVERY_CURRENCY_INVALID');
      const [zone] = await ShippingZone.create([{ publicId: publicId('zon'), ...input }], { session });
      await writeAudit(request, 'logistics.shipping_zone_created', { actor: access.actor, targetType: 'shipping_zone', targetPublicId: zone.publicId, country: input.country, session });
    });
  } finally { await session.endSession(); }
  response.redirect(303, dashboardLanding(request.user));
}));
function financeRequest(request) { request.requiredOperationalWorkspace = primaryWorkspaceFor(request.user); }
router.post('/operations/logistics/shipments/:publicId/reconcile-cod', asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); financeRequest(request);
  const shipment = await Shipment.findOne({ publicId: request.params.publicId });
  if (!shipment) throw new AppError('Shipment not found.', 404, 'SHIPMENT_NOT_FOUND');
  await reconcileCod({ shipment, request });
  response.redirect(303, dashboardLanding(request.user));
}));
router.post('/operations/logistics/cod-reconciliation', asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request); financeRequest(request);
  const input = z.object({ deliveryProfileId: z.string().trim().min(5).max(100), businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    country: z.string().regex(/^[A-Z]{2}$/).optional(), currency: z.string().regex(/^[A-Z]{3}$/), declaredAmountMinor: z.coerce.number().int().nonnegative().safe() }).parse(request.body);
  const profile = await DeliveryProfile.findOne({ publicId: input.deliveryProfileId, verificationStatus: 'approved' });
  if (!profile) throw new AppError('Approved delivery partner not found.', 404, 'DELIVERY_NOT_FOUND');
  if (input.country && input.country !== profile.country) throw new AppError('Select the delivery partner’s market.', 422, 'COD_CURRENCY_INVALID');
  await financeAccess(request, { workspace: false, country: profile.country });
  await reconcileCodBatch({ country: profile.country, deliveryUserId: profile.userId, businessDate: input.businessDate,
    currency: input.currency, declaredAmountMinor: input.declaredAmountMinor, request });
  setFlash(request, 'success', 'Driver/day COD batch reconciled to the ledger.');
  response.redirect(303, dashboardLanding(request.user));
}));
export default router;
