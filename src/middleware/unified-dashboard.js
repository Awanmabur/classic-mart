import { DASHBOARD_PAGES, DASHBOARD_ROUTES, DASHBOARD_WORKSPACES, defaultPageFor, pageDefinition, pageWorkspace } from '../config/dashboard-workspaces.js';
import { hasPermission } from '../core/roles.js';

const LEGACY_DASHBOARD_VIEWS = new Set([
  'dashboard',
  'admin',
  'promoter-admin',
  'promoter-workspace',
  'payout-workspace',
  'money-workspace',
  'returns-workspace',
  'seller-growth',
  'ai-workspace',
  'moderation-workspace',
  'business-workspace',
  'support-workspace',
  'logistics-workspace',
  'catalog-workspace',
  'seller-campaigns',
  'privacy-workspace',
  'rewards',
  'connected-apps',
  'developer-portal',
  'support-ticket',
  'business-document',
]);

const DASHBOARD_MARKETPLACE_VIEWS = new Set(['wishlist', 'cart', 'categories']);

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

const ALL_WORKSPACES = Object.freeze([
  'customer', 'seller', 'promoter', 'admin', 'superadmin', 'finance', 'support', 'warehouse', 'moderator', 'business',
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function effectiveRoles(user) {
  if (!user) return [];
  const authorizationContext = user.authorizationContext;
  const grantRoles = authorizationContext?.platformManaged
    ? (authorizationContext.activePlatformGrants || []).map((grant) => grant.role)
    : [];
  return unique([user.role, ...grantRoles]);
}

export function allowedWorkspacesFor(user, sourceLocals = {}) {
  if (!user || user.status !== 'active') return [];
  const roles = effectiveRoles(user);
  if (roles.includes('super_admin')) return [...ALL_WORKSPACES];

  const allowed = new Set(['customer']);
  for (const role of roles) {
    const workspace = ROLE_TO_WORKSPACE[role];
    if (workspace) allowed.add(workspace);
  }

  // Country admins have explicit finance/support/moderation capabilities in the
  // production permission model. The dashboard switcher reflects those existing
  // server permissions; it does not grant them.
  if (hasPermission(user, 'finance:country')) allowed.add('finance');
  if (hasPermission(user, 'support:manage')) allowed.add('support');
  if (hasPermission(user, 'catalogue:moderate')) allowed.add('moderator');
  if (hasPermission(user, 'warehouse:manage')) allowed.add('warehouse');

  // Existing route middleware is still authoritative. If a protected seller,
  // promoter, or business route has already resolved its real workspace context,
  // surface the matching dashboard without inventing a client-side role.
  if (sourceLocals.store || sourceLocals.view?.store || sourceLocals.storeMemberships?.length) allowed.add('seller');
  if (sourceLocals.summary?.promoter || sourceLocals.promoterProfile || user.role === 'promoter') allowed.add('promoter');
  if (sourceLocals.view?.organization || sourceLocals.organization || sourceLocals.businessMemberships?.length) allowed.add('business');

  return [...allowed].filter((workspace) => DASHBOARD_WORKSPACES[workspace]);
}

export function sourceWorkspace(request, sourceView, sourceLocals, allowedWorkspaces) {
  const explicit = String(request.query?.workspace || '').trim();
  if (explicit && allowedWorkspaces.includes(explicit)) return explicit;

  // /dashboard without an explicit workspace is the customer/account home.
  // This keeps privileged users from being bounced into MFA just for opening
  // their normal account dashboard; privileged workspaces are explicit.
  if (sourceView === 'dashboard') return allowedWorkspaces.includes('customer') ? 'customer' : (allowedWorkspaces[0] || 'customer');

  if (sourceView === 'admin') return request.user?.role === 'super_admin' ? 'superadmin' : 'admin';
  if (sourceView === 'promoter-admin') return 'admin';
  if (sourceView === 'promoter-workspace') return 'promoter';
  if (sourceView === 'seller-growth' || sourceView === 'seller-campaigns' || sourceView === 'catalog-workspace' || sourceView === 'developer-portal') return 'seller';
  if (sourceView === 'payout-workspace') {
    if (request.user?.role === 'promoter') return 'promoter';
    if (request.user?.role === 'seller') return 'seller';
    return allowedWorkspaces.includes('finance') ? 'finance' : 'customer';
  }
  if (sourceView === 'money-workspace') {
    if (allowedWorkspaces.includes('finance') && (request.user?.role === 'finance' || request.user?.role === 'country_admin' || request.user?.role === 'super_admin')) return 'finance';
    if (request.user?.role === 'seller') return 'seller';
    if (request.user?.role === 'promoter') return 'promoter';
    return 'customer';
  }
  if (sourceView === 'moderation-workspace') return 'moderator';
  if (sourceView === 'support-workspace' || sourceView === 'support-ticket') return 'support';
  if (sourceView === 'logistics-workspace') return 'warehouse';
  if (sourceView === 'business-workspace' || sourceView === 'business-document') return 'business';
  if (sourceView === 'ai-workspace') {
    if (sourceLocals.section === 'seller') return 'seller';
    if (sourceLocals.section === 'support') return 'support';
    return request.user?.role === 'super_admin' ? 'superadmin' : 'admin';
  }

  const roleWorkspace = ROLE_TO_WORKSPACE[request.user?.role] || 'customer';
  return allowedWorkspaces.includes(roleWorkspace) ? roleWorkspace : allowedWorkspaces[0] || 'customer';
}

const ADMIN_SECTION_PAGE = Object.freeze({
  overview: 'admin-overview',
  business: 'admin-customers',
  staff: 'admin-settings',
  countries: 'admin-settings',
  features: 'admin-settings',
  cms: 'admin-content',
  approvals: 'admin-seller-approvals',
  growth: 'admin-campaigns',
  reports: 'admin-reports',
  exports: 'admin-reports',
  privacy: 'admin-customers',
  incidents: 'admin-support',
  health: 'admin-settings',
  impersonation: 'admin-settings',
  security: 'admin-settings',
});

const SUPER_SECTION_PAGE = Object.freeze({
  overview: 'super-overview',
  business: 'super-customers',
  staff: 'super-roles',
  countries: 'super-settings',
  features: 'super-settings',
  cms: 'super-notifications',
  approvals: 'super-roles',
  growth: 'super-commissions',
  reports: 'super-reports',
  exports: 'super-reports',
  privacy: 'super-customers',
  incidents: 'super-security',
  health: 'super-security',
  impersonation: 'super-admins',
  security: 'super-audit',
});

const SELLER_SECTION_PAGE = Object.freeze({
  products: 'seller-products',
  'product-new': 'seller-add-product',
  'product-edit': 'seller-products',
  inventory: 'seller-inventory',
  orders: 'seller-orders',
  returns: 'seller-returns',
  messages: 'seller-messages',
  questions: 'seller-questions',
  'bulk-import': 'seller-products',
  onboarding: 'seller-store',
  store: 'seller-store',
  staff: 'seller-staff',
});

const MODERATION_SECTION_PAGE = Object.freeze({
  products: 'moderator-products',
  'product-detail': 'moderator-products',
  verifications: 'moderator-sellers',
  'verification-detail': 'moderator-sellers',
  'catalogue-settings': 'moderator-products',
  qa: 'moderator-audit',
});

function requestedPageFor(request, sourceView, sourceLocals, workspace) {
  const explicit = String(request.query?.view || '').trim();
  if (explicit && pageWorkspace(explicit) === workspace) return explicit;

  if (sourceView === 'dashboard') {
    if (sourceLocals.section === 'profile' || sourceLocals.section === 'security') return 'profile';
    if (sourceLocals.section === 'messages') return 'support';
    if (workspace === 'customer') return 'dashboard';
    return defaultPageFor(workspace);
  }
  if (sourceView === 'wishlist') return 'wishlist';
  if (sourceView === 'cart') return 'cart';
  if (sourceView === 'categories') return 'categories';
  if (sourceView === 'privacy-workspace' || sourceView === 'connected-apps') return 'profile';
  if (sourceView === 'rewards') return 'rewards';
  if (sourceView === 'returns-workspace') return 'returns';
  if (sourceView === 'catalog-workspace') return SELLER_SECTION_PAGE[sourceLocals.view?.section] || 'seller-overview';
  if (sourceView === 'seller-growth') return 'seller-analytics';
  if (sourceView === 'seller-campaigns') return 'seller-campaigns';
  if (sourceView === 'developer-portal') return 'seller-developers';
  if (sourceView === 'promoter-workspace') return 'promoter-overview';
  if (sourceView === 'promoter-admin') return workspace === 'superadmin' ? 'super-promoters' : 'admin-promoter-approvals';
  if (sourceView === 'business-workspace') return 'business-overview';
  if (sourceView === 'business-document') return 'business-orders';
  if (sourceView === 'support-workspace') return 'support-overview';
  if (sourceView === 'support-ticket') return 'support-queue';
  if (sourceView === 'logistics-workspace') return 'warehouse-overview';
  if (sourceView === 'moderation-workspace') return MODERATION_SECTION_PAGE[sourceLocals.view?.section] || 'moderator-overview';
  if (sourceView === 'money-workspace') {
    if (workspace === 'finance') return 'finance-overview';
    if (workspace === 'seller') return 'seller-payouts';
    if (workspace === 'promoter') return 'promoter-payouts';
    return 'wallet';
  }
  if (sourceView === 'payout-workspace') {
    if (workspace === 'seller') return 'seller-payouts';
    if (workspace === 'promoter') return 'promoter-payouts';
    return 'finance-payouts';
  }
  if (sourceView === 'admin') {
    const section = sourceLocals.section || 'overview';
    return workspace === 'superadmin'
      ? SUPER_SECTION_PAGE[section] || 'super-overview'
      : ADMIN_SECTION_PAGE[section] || 'admin-overview';
  }
  if (sourceView === 'ai-workspace') return defaultPageFor(workspace);
  return defaultPageFor(workspace);
}

export function routeForPage(pageId, workspace = pageWorkspace(pageId) || 'customer') {
  const direct = DASHBOARD_ROUTES[pageId] || '/dashboard';
  const hashIndex = direct.indexOf('#');
  const hash = hashIndex >= 0 ? direct.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? direct.slice(0, hashIndex) : direct;
  const queryIndex = withoutHash.indexOf('?');
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '');
  params.set('view', pageId);
  params.set('workspace', workspace);
  return `${pathname}?${params.toString()}${hash}`;
}


const BLOCKED_SOURCE_SCRIPTS = new Set([
  '/dashboard.js',
  '/shared-shell.js',
  '/country-switcher.js',
  '/search-tools.js',
  '/newsletter.js',
]);

function sourceScriptSrcs(html) {
  const scripts = [];
  const pattern = /<script\b[^>]*\bsrc=(['"])(\/[A-Za-z0-9._/-]+\.js(?:\?[A-Za-z0-9._~=&%/-]*)?)\1[^>]*>\s*<\/script>/gi;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const src = match[2];
    if (!BLOCKED_SOURCE_SCRIPTS.has(src) && !scripts.includes(src)) scripts.push(src);
  }
  return scripts;
}

function stripOuterDocument(html) {
  let value = String(html || '');
  value = value.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  value = value.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  value = value.replace(/<link\b[^>]*>/gi, '');
  value = value.replace(/<svg\b[^>]*class=["'][^"']*svg-sprite[^"']*["'][^>]*>[\s\S]*?<\/svg>/i, '');

  const main = value.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) value = main[1];
  else {
    const body = value.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    if (body) value = body[1];
  }

  // The approved Final 19 shell supplies the only dashboard header/sidebar.
  value = value.replace(/<header\b[^>]*class=["'][^"']*(?:topbar|catalog-topbar)[^"']*["'][^>]*>[\s\S]*?<\/header>/gi, '');
  value = value.replace(/<aside\b[^>]*class=["'][^"']*sidebar[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi, '');
  value = value.replace(/<!doctype[^>]*>|<\/?html\b[^>]*>|<\/?head\b[^>]*>|<\/?body\b[^>]*>/gi, '');
  return value.trim();
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function dashboardContextFor(request, sourceView, sourceLocals, allowedWorkspaces, requestedWorkspace, requestedPage) {
  const user = request.user;
  const page = pageDefinition(requestedWorkspace, requestedPage) || pageDefinition(requestedWorkspace, defaultPageFor(requestedWorkspace));
  const workspace = DASHBOARD_WORKSPACES[requestedWorkspace] || DASHBOARD_WORKSPACES.customer;
  return {
    user: user ? {
      publicId: user.publicId,
      name: user.name,
      role: user.role,
      country: user.country,
      currency: user.currency,
    } : null,
    sourceView,
    currentPath: request.originalUrl || request.url || '/',
    requestedWorkspace,
    requestedPage: page?.[0] || requestedPage,
    allowedWorkspaces,
    workspace,
    page: page ? { id: page[0], label: page[1], icon: page[2], group: page[3], title: page[4], description: page[5], kind: page[6] } : null,
    routes: Object.fromEntries((DASHBOARD_PAGES[requestedWorkspace] || []).map((row) => [row[0], routeForPage(row[0], requestedWorkspace)])),
    csrfToken: sourceLocals.csrfToken || '',
  };
}

function renderUnifiedSource(request, response, originalRender, sourceView, sourceLocals, callback) {
  const allowedWorkspaces = allowedWorkspacesFor(request.user, sourceLocals);
  const requestedWorkspace = sourceWorkspace(request, sourceView, sourceLocals, allowedWorkspaces);
  const requestedPage = requestedPageFor(request, sourceView, sourceLocals, requestedWorkspace);
  const authorizationContext = request.user?.authorizationContext || null;

  request.app.render(sourceView, { ...response.locals, ...sourceLocals }, (sourceError, sourceHtml) => {
    if (sourceError) return callback(sourceError);
    const approvedSourceScriptSrcs = sourceScriptSrcs(sourceHtml);
    const trustedServerRenderedDashboardHtml = stripOuterDocument(sourceHtml);
    const dashboardContext = dashboardContextFor(
      request,
      sourceView,
      sourceLocals,
      allowedWorkspaces,
      requestedWorkspace,
      requestedPage,
    );
    const dashboardContextJson = safeJson(dashboardContext);

    return originalRender('unified-dashboard', {
      ...sourceLocals,
      sourceView,
      sourceLocals,
      sourceContent: trustedServerRenderedDashboardHtml,
      trustedServerRenderedDashboardHtml,
      allowedWorkspaces,
      requestedWorkspace,
      requestedPage: dashboardContext.requestedPage,
      dashboardContext,
      dashboardContextJson,
      sourceScriptSrcs: approvedSourceScriptSrcs,
      dashboardAuthorizationContext: authorizationContext,
      dashboardPages: DASHBOARD_PAGES,
      dashboardWorkspaces: DASHBOARD_WORKSPACES,
      routeForPage,
      currentPath: request.originalUrl || request.url || '/',
      csrfToken: response.locals.csrfToken || sourceLocals.csrfToken || '',
    }, callback);
  });
}

export function unifiedDashboardRenderer(request, response, next) {
  const originalRender = response.render.bind(response);
  response.render = (view, options = {}, callback) => {
    const requestedDashboardWorkspace = String(request.query?.workspace || '').trim();
    const marketplaceDashboardView = DASHBOARD_MARKETPLACE_VIEWS.has(view) && requestedDashboardWorkspace === 'customer';
    if ((!LEGACY_DASHBOARD_VIEWS.has(view) && !marketplaceDashboardView) || options?.unifiedDashboard === false || !request.user) {
      return originalRender(view, options, callback);
    }

    const handler = typeof callback === 'function'
      ? callback
      : (error, html) => {
          if (error) return next(error);
          return response.send(html);
        };

    return renderUnifiedSource(request, response, originalRender, view, options, handler);
  };
  next();
}
