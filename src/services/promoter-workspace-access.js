import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { User, PromoterVerification, CountrySetting } from '../models/index.js';
import { hydratePlatformAuthorization } from './platform-grants.js';
import { primaryWorkspaceFor } from '../dashboard/access.js';

/** Personal shopping preferences never choose the Promoter's operating market. */
export async function promoterAccess(request, { session = null, write = false } = {}) {
  if (!request.user?._id) throw new AppError('Promoter authentication is required.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id).session(session);
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  await hydratePlatformAuthorization(actor);
  if (actor.role !== 'promoter' || primaryWorkspaceFor(actor) !== 'promoter') {
    throw new AppError('A Promoter account is required for this workspace.', 403, 'PROMOTER_WORKSPACE_FORBIDDEN');
  }
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) {
    throw new AppError('Complete email verification and onboarding first.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const verification = await PromoterVerification.findOne({ userId: actor._id }).session(session);
  const country = await CountrySetting.findOne({ code: verification?.country || actor.country, active: true }).session(session).lean();
  if (!country?.currency || !country.timeZone) throw new AppError('The Promoter market is unavailable.', 409, 'PROMOTER_MARKET_UNAVAILABLE');
  if (write) {
    if (!session?.inTransaction()) throw new AppError('Promoter changes require a transaction.', 500, 'PROMOTER_TRANSACTION_REQUIRED');
    await User.updateOne({ _id: actor._id, status: 'active', role: 'promoter', 'security.tokenVersion': actor.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
    if (verification) await PromoterVerification.updateOne({ _id: verification._id, country: country.code, status: verification.status }, { $inc: { __v: 1 } }, { session });
  }
  return { actor, verification, country, market: { country: country.code, currency: country.currency, timeZone: country.timeZone } };
}
