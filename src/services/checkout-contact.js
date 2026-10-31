import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { canonicalPhone } from '../core/phone.js';

export const checkoutContactSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(32),
  address: z.string().trim().min(4).max(240),
  city: z.string().trim().min(2).max(120),
  country: z.string().trim().min(2).max(80),
  note: z.string().trim().max(500).default(''),
});

export function normalizedCheckoutContact(input, market) {
  const contact = checkoutContactSchema.parse(input);
  if (![market.code, market.name].filter(Boolean).some(value => value.toLowerCase() === contact.country.toLowerCase())) {
    throw new AppError('The delivery country must match the selected marketplace.', 409, 'CHECKOUT_COUNTRY_CHANGED');
  }
  return { ...contact, email: contact.email.toLowerCase(), phone: canonicalPhone(contact.phone), country: market.code };
}
