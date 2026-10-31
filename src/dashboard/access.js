import { hasPermission } from '../core/roles.js';
import { DASHBOARD_WORKSPACES, pageWorkspace } from './registry.js';

const ROLE_TO_WORKSPACE = Object.freeze({
  customer: 'customer',
  business: 'business',
  seller: 'seller',
  promoter: 'promoter',
  delivery: 'delivery',
  warehouse: 'warehouse',
  support: 'support',
  moderator: 'moderator',
  finance: 'finance',
  country_admin: 'admin',
  super_admin: 'superadmin',
});

const WORKSPACE_PERMISSION = Object.freeze({
  customer: 'account:read',
  business: 'business:manage',
  seller: 'seller:manage',
  promoter: 'promoter:manage',
  delivery: 'delivery:manage',
  warehouse: 'warehouse:manage',
  support: 'support:manage',
  moderator: 'catalogue:moderate',
  finance: 'finance:manage',
  admin: 'country:manage',
});

const PRIMARY_WORKSPACE_PRIORITY = Object.freeze([
  'superadmin',
  'admin',
  'finance',
  'support',
  'moderator',
  'warehouse',
  'seller',
  'promoter',
  'delivery',
  'business',
  'customer',
]);

function grantRoles(user) {
  if (!user?.authorizationContext?.platformManaged) return [];
  return (user.authorizationContext.activePlatformGrants || []).map((grant) => grant.role).filter(Boolean);
}

function effectiveRoleWorkspaces(user) {
  if (!user || user.status !== 'active') return new Set();
  const roles = user.authorizationContext?.platformManaged ? grantRoles(user) : [user.role];
  const workspaces = new Set(['customer']);
  for (const role of roles) {
    if (role === 'super_admin' && !hasGlobalAdminGrant(user)) continue;
    const workspace = ROLE_TO_WORKSPACE[role];
    if (workspace) workspaces.add(workspace);
  }
  if (user.businessMembershipContext?.active && ['customer', 'business'].includes(user.role) && !user.authorizationContext?.platformManaged) workspaces.add('business');
  if (user.storeMembershipContext?.active && ['customer', 'seller'].includes(user.role) && !user.authorizationContext?.platformManaged) workspaces.add('seller');
  return workspaces;
}

export function canAccessWorkspace(user, workspace) {
  if (!user || user.status !== 'active' || !DASHBOARD_WORKSPACES[workspace]) return false;
  if (workspace === 'superadmin') return hasGlobalAdminGrant(user);
  if (workspace === 'customer') return hasPermission(user, 'account:read');
  if (user.role === 'super_admin' && !hasGlobalAdminGrant(user)) return false;

  const workspaces = effectiveRoleWorkspaces(user);
  if (workspaces.has(workspace)) return true;

  if (workspace === 'finance') return hasPermission(user, 'finance:manage') || hasPermission(user, 'finance:country');
  if (workspace === 'warehouse') return hasPermission(user, 'warehouse:manage');
  if (workspace === 'moderator') return hasPermission(user, 'catalogue:moderate') || hasPermission(user, 'trust:manage');
  const permission = WORKSPACE_PERMISSION[workspace];
  return permission ? hasPermission(user, permission) : false;
}

function hasGlobalAdminGrant(user) {
  return Boolean(user?.authorizationContext?.platformManaged && user.authorizationContext.activePlatformGrants?.some(grant => grant.role === 'super_admin' && grant.operationalCountries?.includes('*')));
}

export function allowedWorkspacesFor(user) {
  return PRIMARY_WORKSPACE_PRIORITY.filter((workspace) => canAccessWorkspace(user, workspace));
}

export function primaryWorkspaceFor(user) {
  return allowedWorkspacesFor(user)[0] || 'customer';
}

export function workspaceForPage(user, pageId) {
  const workspace = pageWorkspace(pageId);
  return workspace && canAccessWorkspace(user, workspace) ? workspace : null;
}

export function defaultDashboardPageForUser(user) {
  const preferredPage = String(user?.preferences?.dashboard?.landingPage || '').trim();
  if (preferredPage && workspaceForPage(user, preferredPage)) return preferredPage;
  const workspace = primaryWorkspaceFor(user);
  return DASHBOARD_WORKSPACES[workspace]?.defaultPage || 'dashboard';
}
