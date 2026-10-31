import { createHmac } from 'node:crypto';
import expressRateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';
import { getRedisClient } from '../config/redis.js';
import { RedisRateLimitStore } from '../core/redis-rate-limit-store.js';

const boundedIdentity = value => {
  const text = value == null ? '' : String(value);
  return /^[a-zA-Z0-9:_-]{1,160}$/.test(text) ? text : '';
};
const digest = value => createHmac('sha256', env.tokenPepper).update(value).digest('hex');
const actorId = request => boundedIdentity((request.user || request.mobileUser)?._id);

export function accountRateLimitKey(request) {
  const actor = actorId(request);
  return actor ? digest('account:' + actor) : '';
}

export function deviceRateLimitKey(request) {
  const actor = actorId(request);
  const device = request.device || request.mobileSession;
  if (actor && device && !device.revokedAt && boundedIdentity(device.userId) === actor) {
    const id = boundedIdentity(device._id || device.publicId);
    if (id) return digest('device:' + actor + ':' + id);
  }
  // Express supplies this server-side session after signature/store validation.
  // A user-agent, arbitrary device header, or raw cookie never establishes identity.
  const session = boundedIdentity(request.sessionID);
  if (session && typeof request.session?.csrfToken === 'string' && request.session.csrfToken.length >= 16
    && (!actor || boundedIdentity(request.session.userId) === actor)) return digest('session:' + session);
  return '';
}

export default function rateLimit({ scope, accountLimit, deviceLimit, ...options }) {
  if (!/^[a-z0-9:-]{1,108}$/.test(scope || '')) throw new Error('Every limiter requires a stable, unique scope.');
  const makeLimiter = (name, settings) => expressRateLimit({
    ...settings,
    ...(env.isProduction ? { store: new RedisRateLimitStore({ scope: name, getClient: getRedisClient }) } : {}),
    // A failed shared counter must never silently open authentication/uploads.
    passOnStoreError: false,
  });
  const primary = makeLimiter(scope, options);
  // The global request gate runs before identity/session loading; route gates
  // add independent identity buckets after those identities have been verified.
  if (scope === 'global') return primary;
  const { keyGenerator: _keyGenerator, skip: shouldSkip, store: _store, ...shared } = options;
  const limiters = [];
  if (options.keyGenerator) {
    // Existing account/MFA keys remain authoritative, with an additional IP cap.
    // IPv6 addresses share a /56 bucket so address rotation cannot reset it.
    limiters.push(makeLimiter(scope + ':ip', { ...shared,
      keyGenerator: request => ipKeyGenerator(request.ip, 56), skip: shouldSkip,
      requestPropertyName: 'ipRateLimit', identifier: scope + '-ip' }));
  }
  limiters.push(primary);
  for (const [kind, key, limit] of [
    ['account', accountRateLimitKey, accountLimit ?? options.limit],
    ['device', deviceRateLimitKey, deviceLimit ?? options.limit],
  ]) {
    limiters.push(makeLimiter(scope + ':' + kind, { ...shared,
      ...(limit === undefined ? {} : { limit }),
      keyGenerator: key,
      skip: async (request, response) => !key(request) || Boolean(await shouldSkip?.(request, response)),
      requestPropertyName: kind + 'RateLimit', identifier: scope + '-' + kind,
    }));
  }
  return function layeredRateLimit(request, response, next) {
    let index = 0;
    const run = error => {
      if (error || index === limiters.length) return next(error);
      return limiters[index++](request, response, run);
    };
    return run();
  };
}
