export const ROLES = Object.freeze([
  'customer',
  'business',
  'seller',
  'promoter',
  'delivery',
  'warehouse',
  'support',
  'moderator',
  'finance',
  'country_admin',
  'super_admin',
]);

export const ROLE_PERMISSIONS = Object.freeze({
  customer: ['account:read', 'account:update', 'orders:own'],
  business: [
    'account:read',
    'account:update',
    'orders:own',
    'business:manage',
  ],
  seller: [
    'account:read',
    'account:update',
    'orders:own',
    'seller:manage',
    'catalogue:own',
  ],
  promoter: [
    'account:read',
    'account:update',
    'orders:own',
    'promoter:manage',
  ],
  delivery: [
    'account:read',
    'account:update',
    'orders:own',
    'delivery:manage',
  ],
  warehouse: [
    'account:read',
    'account:update',
    'warehouse:manage',
  ],
  support: [
    'account:read',
    'account:update',
    'support:manage',
    'orders:support',
  ],
  moderator: [
    'account:read',
    'account:update',
    'catalogue:moderate',
    'trust:manage',
  ],
  finance: [
    'account:read',
    'account:update',
    'finance:manage',
    'payouts:review',
  ],
  country_admin: [
    'account:read',
    'account:update',
    'country:manage',
    'users:country',
    'catalogue:moderate',
    'support:manage',
    'finance:country',
  ],
  super_admin: ['*'],
});

export function hasPermission(user, permission) {
  if (!user || user.status !== 'active') return false;
  const context=user.authorizationContext;
  if(context?.platformManaged){
    const granted=new Set(['account:read','account:update']);
    for(const grant of context.activePlatformGrants||[]){
      for(const item of ROLE_PERMISSIONS[grant.role]||[])granted.add(item);
      for(const item of grant.capabilities||[])granted.add(item);
    }
    return granted.has('*')||granted.has(permission);
  }
  const granted = ROLE_PERMISSIONS[user.role] || [];
  return granted.includes('*') || granted.includes(permission);
}

export function roleLabel(role) {
  return (
    {
      customer: 'Customer',
      business: 'Business Buyer',
      seller: 'Seller',
      promoter: 'Promoter',
      delivery: 'Delivery Partner',
      warehouse: 'Warehouse Staff',
      support: 'Support Agent',
      moderator: 'Moderator',
      finance: 'Finance Operator',
      country_admin: 'Country Admin',
      super_admin: 'Super Admin',
    }[role] || 'Member'
  );
}
