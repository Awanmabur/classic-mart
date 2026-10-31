import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { User } from '../models/index.js';
import { isCountryPage } from './seo.js';

export async function saveShoppingCountry(request, country) {
  if (!request.user) return;
  // One atomic preference update. Home country, grants and order jurisdiction
  // remain server-controlled. Fence a revoked/changed account before saving.
  const actor = await User.findOneAndUpdate({ _id: request.user._id, status: 'active',
    __v: request.user.__v, 'security.tokenVersion': request.user.security.tokenVersion }, {
    $set: { shoppingCountry: country.code, currency: country.currency }, $inc: { __v: 1 },
  }, { returnDocument: 'after', runValidators: true });
  if (!actor) throw new AppError('Your account changed. Refresh and choose your country again.', 409, 'ACCOUNT_ACCESS_CHANGED');
  request.user = actor;
}

export function shoppingCountryReturn(referer, countryCode) {
  try {
    if (typeof referer !== 'string' || /[\\\u0000-\u0020\u007f]/.test(referer)) return '/';
    const target = new URL(referer, env.baseUrl);
    if (target.origin !== new URL(env.baseUrl).origin || target.username || target.password) return '/';
    if (isCountryPage(target.pathname) && target.searchParams.has('country')) target.searchParams.set('country', countryCode);
    return target.pathname + target.search + target.hash;
  } catch { return '/'; }
}
