// Public account types describe marketplace participation. Operational staff
// privileges are provisioned separately through authoritative platform grants.
export const PUBLIC_ACCOUNT_TYPES = Object.freeze([
  'customer', 'seller', 'promoter', 'business', 'delivery',
]);

export function publicAccountType(value) {
  return PUBLIC_ACCOUNT_TYPES.includes(value) ? value : 'customer';
}
