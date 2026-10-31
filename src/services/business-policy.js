import { z } from 'zod';
import { AppError } from '../core/errors.js';

const schema = z.object({ returnWindowDays: z.number().int().min(0).max(365), platformFeeBps: z.number().int().min(0).max(5000), taxBps: z.number().int().min(0).max(10000), policyVersion: z.string().trim().min(1).max(40) }).strict();
export function businessCommercialPolicy(value) {
  const parsed = schema.safeParse(value?.toObject ? value.toObject() : value);
  if (!parsed.success) throw new AppError('This purchase needs a complete reviewed commercial policy. Resubmit it for independent approval.', 409, 'BUSINESS_POLICY_REVIEW_REQUIRED');
  return parsed.data;
}
export function reviewedMarketPolicy(market) {
  return businessCommercialPolicy({ returnWindowDays: market.returnWindowDays, platformFeeBps: market.platformFeeBps, taxBps: market.taxBps, policyVersion: market.policyVersion });
}
export function equalBusinessPolicy(left, right) {
  const a = businessCommercialPolicy(left), b = businessCommercialPolicy(right);
  return Object.keys(a).every(key => a[key] === b[key]);
}
