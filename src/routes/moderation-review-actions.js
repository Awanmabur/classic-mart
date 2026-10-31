import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { z } from 'zod';
import { asyncHandler, AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding, requirePermission } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { dashboardLanding } from '../dashboard/landing.js';
import { RiskSignal, TrustCase } from '../models/index.js';
import { publishReview, reviewRiskSignal, reviewTrustCase } from '../services/trust.js';
import { setFlash } from '../middleware/view.js';

const router = Router();
const gates = [noStore, requireAuth, requireVerified, requireOnboarding, requirePermission('catalogue:moderate'),
  rateLimit({ scope: 'moderation-review-actions:1', windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })];
const version = z.coerce.number().int().nonnegative();
router.post('/moderation/reviews/:id/decision', ...gates, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  const input = z.object({ version, decision: z.enum(['publish', 'reject']), reason: z.string().trim().min(3).max(500) }).parse(request.body);
  const record = await publishReview(request, request.params.id, input);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ review: { publicId: record.publicId, status: record.status, version: record.__v } });
  setFlash(request, 'success', 'Review decision recorded.');
  response.redirect(303, dashboardLanding(request.user));
}));
for (const [path, Model, operation, schema] of [
  ['risk-cases', TrustCase, reviewTrustCase, z.object({ version, status: z.enum(['investigating', 'actioned', 'dismissed', 'closed']), enforcement: z.enum(['none', 'suspend_product', 'restore_product', 'suspend_store', 'restore_store']).default('none'), decision: z.string().trim().min(3).max(1000) })],
  ['risk-signals', RiskSignal, reviewRiskSignal, z.object({ version, status: z.enum(['reviewed', 'dismissed', 'actioned']), decision: z.string().trim().min(3).max(1000) })],
]) router.post('/moderation/' + path + '/:id/' + (path === 'risk-cases' ? 'status' : 'review'), ...gates, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  const input = schema.parse(request.body), record = await Model.findOne({ publicId: request.params.id });
  if (!record) throw new AppError('Moderation record not found.', 404, 'MODERATION_RECORD_NOT_FOUND');
  const saved = await operation(request, record, input);
  if (request.accepts(['html', 'json']) === 'json') return response.json({ record: { publicId: saved.publicId, status: saved.status, version: saved.__v } });
  setFlash(request, 'success', 'Moderation decision recorded.');
  response.redirect(303, dashboardLanding(request.user));
}));
export default router;
