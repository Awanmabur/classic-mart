const ROLE_CAPABILITIES = Object.freeze({
  owner: ['catalogue', 'inventory', 'fulfilment', 'support', 'finance', 'growth', 'staff', 'analytics'],
  admin: ['catalogue', 'inventory', 'fulfilment', 'support', 'finance', 'growth', 'staff', 'analytics'],
  catalogue: ['catalogue', 'inventory'],
  fulfilment: ['inventory', 'fulfilment'],
  finance: ['finance'],
  support: ['support'],
});

/**
 * Dependency-free least-privilege read plan for the Seller dashboard.
 *
 * This is intentionally separate from database/model code so authorization
 * decisions can be tested without loading Mongoose. Unknown roles receive no
 * sensitive dashboard capability.
 */
export function sellerDashboardDataPlan(role = '') {
  const normalizedRole = String(role || '').trim().toLowerCase();
  const capabilities = new Set(ROLE_CAPABILITIES[normalizedRole] || []);
  const has = (name) => capabilities.has(name);
  const staff = has('staff');
  const support = has('support');
  const finance = has('finance');
  const fulfilment = has('fulfilment');
  const analytics = has('analytics') || has('growth') || staff;

  return Object.freeze({
    role: normalizedRole || 'unknown',
    capabilities: Object.freeze([...capabilities]),
    catalogue: has('catalogue'),
    inventory: has('inventory'),
    fulfilment,
    orders: fulfilment || support || analytics,
    support,
    customerPii: support || fulfilment,
    finance,
    payouts: finance,
    growth: has('growth'),
    staff,
    subscriptions: staff,
    analytics,
  });
}

export function sellerDashboardViewAccess(role = '') {
  const plan = sellerDashboardDataPlan(role);
  return Object.freeze({
    role: plan.role,
    capabilities: plan.capabilities,
    canCatalogue: plan.catalogue,
    canInventory: plan.inventory,
    canFulfilment: plan.fulfilment,
    canSupport: plan.support,
    canFinance: plan.finance,
    canGrowth: plan.growth,
    canStaff: plan.staff,
    canAnalytics: plan.analytics,
  });
}
