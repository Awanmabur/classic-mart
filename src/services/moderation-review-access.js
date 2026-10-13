import { AppError } from '../core/errors.js';
import { moderationAccess, fenceModerationAccess } from './moderation-workspace-access.js';

/** Existing decision APIs keep their permission boundary; workspace rendering is stricter. */
export async function moderationReviewAccess(request, session, country) {
  if (!session?.inTransaction()) throw new AppError('Moderation changes require a transaction.', 500, 'MODERATION_TRANSACTION_REQUIRED');
  return moderationAccess(request, { session, workspace: false, country });
}
export async function fenceModerationReviewAccess(context, session, options) {
  return fenceModerationAccess(context, session, options);
}
