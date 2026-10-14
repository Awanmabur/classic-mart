// Public account types describe marketplace participation. Operational staff
// privileges are provisioned separately through authoritative platform grants.
export const PUBLIC_ACCOUNT_TYPES = Object.freeze([
  'customer', 'seller', 'promoter', 'business', 'delivery',
]);

export function publicAccountType(value) {
  return PUBLIC_ACCOUNT_TYPES.includes(value) ? value : 'customer';
}
import { AppError } from './errors.js';


// Expand this release policy only after the corresponding workspace is complete.
export const RELEASED_ACCOUNT_TYPES = Object.freeze(['customer', 'seller', 'promoter']);

export function openRegistrationTypes({ production = process.env.NODE_ENV === 'production', configured = process.env.PUBLIC_REGISTRATION_TYPES } = {}) {
  if (!production) return [...PUBLIC_ACCOUNT_TYPES];
  const selected = configured === undefined || configured === '' ? RELEASED_ACCOUNT_TYPES
    : String(configured).split(',').map(value => value.trim()).filter(Boolean);
  if (!selected.length || selected.some(value => !RELEASED_ACCOUNT_TYPES.includes(value))) {
    throw new Error('PUBLIC_REGISTRATION_TYPES must contain only released customer, seller or promoter account types.');
  }
  return [...new Set(selected)];
}

export function assertPublicRegistrationOpen(type, options) {
  if (!openRegistrationTypes(options).includes(type)) {
    throw new AppError('Registration for this account type is not open yet.', 403, 'REGISTRATION_NOT_OPEN');
  }
}
