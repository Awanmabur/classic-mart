import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, asyncHandler } from '../core/errors.js';
import { moderationPageGates, renderModerationPage } from '../dashboard/moderation-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadModerationTrustPage, moderationTrustAction, streamModerationTrustCsv, authorizeModerationTrustEvidence, recordModerationTrustEvidenceAccess } from '../services/moderation-trust-pages.js';
import { readMediaObject } from '../services/object-storage.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false });
router.get('/moderation/evidence/:id', ...moderationPageGates(), limiter, asyncHandler(async (request, response) => {
  const evidence = await authorizeModerationTrustEvidence(request, request.params.id);
  let stored;
  try { stored = await readMediaObject(evidence.storageKey); }
  catch (error) { if (error.code === 'MEDIA_OBJECT_NOT_FOUND') throw new AppError('The stored evidence is unavailable.', 404, 'EVIDENCE_NOT_FOUND'); throw error; }
  if (!stored?.body) throw new AppError('The stored evidence is unavailable.', 404, 'EVIDENCE_NOT_FOUND');
  await recordModerationTrustEvidenceAccess(request, request.params.id, evidence.storageKey);
  if (response.destroyed || response.writableEnded) return;
  return response.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' }).send(stored.body);
}));
for (const [path, pageId] of [['/moderation/reviews', 'moderator-reviews'], ['/moderation/risk-cases', 'moderator-disputes']]) {
  router.get(path, ...moderationPageGates(), asyncHandler(async (request, response) => renderModerationPage(request, response, pageId, await loadModerationTrustPage(request, pageId))));
  router.get(path + '/export.csv', ...moderationPageGates(), limiter, asyncHandler(async (request, response) => streamModerationTrustCsv(request, response, pageId)));
}
for (const [path, kind, pageId] of [['reviews', 'reviews', 'moderator-reviews'], ['risk-cases', 'cases', 'moderator-disputes'], ['risk-signals', 'signals', 'moderator-disputes']]) {
  router.post('/moderation/' + path + '/:id/action', ...moderationPageGates(), limiter, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const doc = await moderationTrustAction(request, kind, request.params.id, request.body || {});
      if (request.accepts(['html', 'json']) === 'json') return response.json({ record: { publicId: doc.publicId, status: doc.status, version: doc.__v } });
      setFlash(request, 'success', 'Moderation action saved.');
      return response.redirect(303, (kind === 'reviews' ? '/moderation/reviews' : '/moderation/risk-cases') + '?' + new URLSearchParams({ record: doc.publicId, country: doc.country, ...(kind === 'reviews' ? {} : { kind }) }));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      const pageRequest = { ...request, query: { ...request.query, record: request.params.id, ...(kind === 'reviews' ? {} : { kind }) } };
      const flow = await loadModerationTrustPage(pageRequest, pageId);
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = Object.fromEntries(['reason', 'message', 'enforcement'].filter(name => typeof request.body?.[name] === 'string').map(name => [name, request.body[name].slice(0, 1000)]));
      response.status(status); return renderModerationPage(pageRequest, response, pageId, flow);
    }
  }));
}
export default router;
