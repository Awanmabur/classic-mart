import { AppError } from '../core/errors.js';
import { countryAdminAccess, fenceCountryAdminAccess, countryAdminPublicContext } from './country-admin-workspace-access.js';

export async function superAdminAccess(request, { session = null, write = false, country } = {}) {
  const context = await countryAdminAccess(request, { session, workspace: false, country: country ?? request.query?.country ?? '' });
  const actor = context.actor;
  if (!actor.platformAccessManagedAt || !context.grant || context.grant.role !== 'super_admin'
    || actor.role !== 'super_admin' || context.grant.operationalCountries.length !== 1 || context.grant.operationalCountries[0] !== '*') {
    throw new AppError('A current global Super Admin staff grant is required.', 403, 'SUPER_ADMIN_GRANT_REQUIRED');
  }
  if (!actor.emailVerifiedAt || !actor.phoneVerifiedAt || !actor.onboardingCompletedAt || !actor.security.mfaEnabled) {
    throw new AppError('Complete verified staff identity and authenticator enrollment first.', 403, 'SUPER_ADMIN_IDENTITY_REQUIRED');
  }
  if (request.sessionID !== undefined && !context.device) throw new AppError('Your staff session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  if (write) {
    requireSuperAdminStepUp(request);
    await fenceCountryAdminAccess(context, session);
  }
  return context;
}

export async function assertSuperAdminReadAccess(request, original) {
  const current = await superAdminAccess(request);
  const markets = context => context.countries.map(row => `${row.code}:${row.currency}:${row.timeZone}`).sort();
  if (String(current.actor._id) !== String(original.actor._id) || String(current.grant._id) !== String(original.grant._id)
    || current.actor.security.tokenVersion !== original.actor.security.tokenVersion || current.country !== original.country
    || JSON.stringify(markets(current)) !== JSON.stringify(markets(original))) {
    throw new AppError('Your Super Admin scope changed. Reload before continuing.', 403, 'SUPER_ADMIN_SCOPE_CHANGED');
  }
  return current;
}

export const superAdminPublicContext = countryAdminPublicContext;

export function requireSuperAdminStepUp(request) {
  const verifiedAt=Number(request.session?.mfaVerifiedAt||0),age=Date.now()-verifiedAt;
  if(!Number.isFinite(verifiedAt)||age<0||age>15*60_000)throw new AppError('Confirm your password and authenticator in Password & Security before changing platform controls.',403,'MFA_STEP_UP_REQUIRED');
}
