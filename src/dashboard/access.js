import { hasPermission } from '../core/roles.js';
import { DASHBOARD_WORKSPACES, pageWorkspace } from './registry.js';

const ROLE_TO_WORKSPACE = Object.freeze({
  customer: 'customer',
  business: 'business',
  seller: 'seller',
  promoter: 'promoter',
  delivery: 'warehouse',
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
  'business',
  'customer',
]);

function grantRoles(user) {
  if (!user?.authorizationContext?.platformManaged) return [];
  return (user.authorizationContext.activePlatformGrants || []).map((grant) => grant.role).filter(Boolean);
}

function effectiveRoleWorkspaces(user) {
  if (!user || user.status !== 'active') return new Set();
  if (user.role === 'super_admin') return new Set(Object.keys(DASHBOARD_WORKSPACES));
  const roles = user.authorizationContext?.platformManaged ? grantRoles(user) : [user.role];
  const workspaces = new Set(['customer']);
  for (const role of roles) {
    const workspace = ROLE_TO_WORKSPACE[role];
    if (workspace) workspaces.add(workspace);
  }
  return workspaces;
}

export function canAccessWorkspace(user, workspace) {
  if (!user || user.status !== 'active' || !DASHBOARD_WORKSPACES[workspace]) return false;
  if (user.role === 'super_admin') return true;
  if (workspace === 'customer') return hasPermission(user, 'account:read');

  const workspaces = effectiveRoleWorkspaces(user);
  if (workspaces.has(workspace)) return true;

  if (workspace === 'finance') return hasPermission(user, 'finance:manage') || hasPermission(user, 'finance:country');
  if (workspace === 'warehouse') return hasPermission(user, 'warehouse:manage') || hasPermission(user, 'delivery:manage');
  if (workspace === 'moderator') return hasPermission(user, 'catalogue:moderate') || hasPermission(user, 'trust:manage');
  const permission = WORKSPACE_PERMISSION[workspace];
  return permission ? hasPermission(user, permission) : false;
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
