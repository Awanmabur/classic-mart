export const PRIVILEGED_MFA_ROLES = Object.freeze(new Set([
  'seller',
  'warehouse',
  'support',
  'moderator',
  'finance',
  'country_admin',
  'super_admin',
]));

const PRIVILEGED_WEB_PREFIX = /^\/(?:admin|super-admin|seller|finance|operations|moderation|logistics|money)(?:\/|$)/;
const PRIVILEGED_API_PREFIX = /^\/api\/v1\/(?:admin|seller|finance|operations|moderation|logistics|warehouse|support|payouts|payout-accounts)(?:\/|$)/;

export function requiresPrivilegedMfaForRequest(request) {
  const role = request?.user?.role;
  if (!PRIVILEGED_MFA_ROLES.has(role)) return false;

  const path = String(request?.path || '/');
  if (path === '/logout' || path === '/account/security' || path.startsWith('/account/mfa/')) return false;

  const operationalDashboard = /^\/dashboard\/(?:seller|admin|super|finance|support|warehouse|moderator)-/.test(path);
  return operationalDashboard || PRIVILEGED_WEB_PREFIX.test(path) || PRIVILEGED_API_PREFIX.test(path);
}
