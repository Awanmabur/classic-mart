import expressRateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { getRedisClient } from '../config/redis.js';
import { RedisRateLimitStore } from '../core/redis-rate-limit-store.js';

export default function rateLimit({ scope, ...options }) {
  if (!/^[a-z0-9:-]{1,120}$/.test(scope || '')) throw new Error('Every limiter requires a stable, unique scope.');
  return expressRateLimit({
    ...options,
    ...(env.isProduction ? { store: new RedisRateLimitStore({ scope, getClient: getRedisClient }) } : {}),
    // A failed shared counter must never silently open authentication/uploads.
    passOnStoreError: false,
  });
}
