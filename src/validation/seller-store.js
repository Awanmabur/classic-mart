import { z } from 'zod';
import { canonicalPhone } from '../core/phone.js';
import { isSupportedCountry } from 'libphonenumber-js/max';

const version = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sellerStoreIdentitySchema = z.object({
  version,
  name: z.string().trim().min(2).max(140),
  description: z.string().trim().max(1500).default(''),
  supportEmail: z.string().trim().email().max(254).or(z.literal('')).default(''),
  supportPhone: z.string().trim().max(30).default(''),
  supportPhoneCountry: z.string().regex(/^[A-Z]{2}$/).refine(isSupportedCountry, 'Choose a valid phone country.'),
}).transform(input => ({ ...input, supportEmail: input.supportEmail.toLowerCase(),
  supportPhone: input.supportPhone ? canonicalPhone(input.supportPhone, input.supportPhoneCountry) : '',
}));

export const sellerStoreOperationsSchema = z.object({
  version,
  primaryCategory: z.string().trim().max(100).default(''),
  pickupCity: z.string().trim().max(120).default(''),
  fulfillmentMode: z.enum(['merchant', 'warehouse', 'hybrid']),
});
