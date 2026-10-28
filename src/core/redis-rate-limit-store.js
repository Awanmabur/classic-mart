import { createHash } from 'node:crypto';
import { requireRedisCommand } from './redis-command.js';

const incrementScript = `
local total = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if total == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {total, ttl}`;
const decrementScript = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
if total > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

/** Atomic fixed-window counters shared by every web process and replica. */
export class RedisRateLimitStore {
  localKeys = false;

  constructor({ scope, getClient }) {
    if (!/^[a-z0-9:-]{1,120}$/.test(scope || '')) throw new Error('A stable rate-limit scope is required.');
    this.prefix = `classic-mart:rate-limit:${scope}:`;
    this.getClient = getClient;
  }

  init({ windowMs }) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('Invalid rate-limit window.');
    this.windowMs = windowMs;
  }

  key(value) {
    return this.prefix + createHash('sha256').update(String(value)).digest('hex');
  }

  async client() {
    const client = await this.getClient();
    if (!client?.isReady) {
      const error = new Error('Shared rate-limit storage is unavailable.');
      error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
      throw error;
    }
    return client;
  }

  async increment(key) {
    const [totalHits, ttl] = await requireRedisCommand(async signal => {
      const client = await this.client();
      signal.throwIfAborted();
      return client.sendCommand(['EVAL', incrementScript, '1', this.key(key), String(this.windowMs)]);
    });
    return { totalHits: Number(totalHits), resetTime: new Date(Date.now() + Number(ttl)) };
  }

  async decrement(key) {
    await requireRedisCommand(async signal => {
      const client = await this.client();
      signal.throwIfAborted();
      return client.sendCommand(['EVAL', decrementScript, '1', this.key(key)]);
    });
  }

  async resetKey(key) {
    await requireRedisCommand(async signal => {
      const client = await this.client();
      signal.throwIfAborted();
      return client.del(this.key(key));
    });
  }
}
