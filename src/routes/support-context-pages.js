import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { supportPageGates, renderSupportPage } from '../dashboard/support-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { assertSupportContactDisclosure, createSupportOrderCase, escalateSupportReview, loadSupportContextPage, revealSupportCustomerContact, streamSupportContextCsv } from '../services/support-context-pages.js';

const router = Router();
const mutateLimit = rateLimit({ scope: 'support-context-pages:1', windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const lookupLimit = rateLimit({ scope: 'support-context-pages:2', windowMs: 15 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false });
const exportLimit = rateLimit({ scope: 'support-context-pages:3', windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });
for (const slug of ['customers', 'orders', 'reviews']) {
  const path = '/support/' + slug, pageId = 'support-' + slug;
  router.get(path, ...supportPageGates(), lookupLimit, asyncHandler(async (req, res) => renderSupportPage(req, res, pageId, await loadSupportContextPage(req, pageId))));
  router.get(path + '/export.csv', ...supportPageGates(), exportLimit, asyncHandler(async (req, res) => streamSupportContextCsv(req, res, pageId)));
}
router.post('/support/customers/:id/contact', ...supportPageGates(), mutateLimit, asyncHandler(async (req, res) => {
  verifyDeferredCsrf(req);
  const input = { ...(req.body || {}) };
  if (input.version === undefined && typeof input.ticketId === 'string') input.version = input['version:' + input.ticketId];
  const contact = await revealSupportCustomerContact(req, req.params.id, input);
  if (req.accepts(['html', 'json']) === 'json') {
    await assertSupportContactDisclosure(req, req.supportContext, contact);
    return res.json({ contact });
  }
  const flow = await loadSupportContextPage({ ...req, query: { ...req.query, record: req.params.id } }, 'support-customers');
  flow.contactDisclosure = contact;
  return renderSupportPage(req, res, 'support-customers', flow);
}));
router.post('/support/orders/:id/cases', ...supportPageGates(), mutateLimit, asyncHandler(async (req, res) => {
  verifyDeferredCsrf(req);
  const ticket = await createSupportOrderCase(req, req.params.id, req.body || {});
  if (req.accepts(['html', 'json']) === 'json') return res.status(201).json({ ticket });
  setFlash(req, 'success', 'Support case opened for the recorded order owner. The initial staff note remains internal.');
  res.redirect('/support/queue?record=' + encodeURIComponent(ticket.publicId) + '&country=' + ticket.country);
}));
router.post('/support/reviews/:id/escalate', ...supportPageGates(), mutateLimit, asyncHandler(async (req, res) => {
  verifyDeferredCsrf(req);
  const issue = await escalateSupportReview(req, req.params.id, req.body || {});
  if (req.accepts(['html', 'json']) === 'json') return res.status(201).json({ issue });
  setFlash(req, 'success', 'Review concern referred to moderation with the linked case evidence.');
  res.redirect('/support/reviews?record=' + encodeURIComponent(issue.reviewPublicId));
}));
export default router;
