import { createClient } from 'redis';
import { env } from './env.js';
import { logger } from './logger.js';
import { REDIS_COMMAND_TIMEOUT_MS } from '../core/redis-command.js';

/** One client is shared by sessions and distributed rate limits. Replacing it
 * during an outage would strand RedisStore on the old, permanently closed
 * client. After its first successful connection, let that same client reconnect
 * while requests fail closed rather than queuing authenticated work offline.
 */
export function createRedisConnection({ url, production = false, makeClient = createClient, log = logger, now = Date.now } = {}) {
  let client;
  let connectionPromise;
  let retryAfter = 0;
  let outageReported = false;
  let stopping = false;

  function destroy(target) {
    if (target?.isOpen) target.destroy();
  }

  async function get() {
    if (!url) return null;
    if (client?.isReady) return client;
    if (connectionPromise) return connectionPromise;
    // A connected RedisStore still owns this object. Returning its unready
    // client lets the shared limiter reject immediately without a new pool.
    if (client?.isOpen) return client;
    if (!production && now() < retryAfter) return null;

    let wasReady = false;
    stopping = false;
    const pending = makeClient({
      url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
      // Redis traffic keeps quiet sessions ahead of 30-second idle cutoffs;
      // TCP keepalive probes alone may not keep an intermediary connection open.
      pingInterval: 15_000,
      socket: {
        connectTimeout: 3_000,
        reconnectStrategy(retries) {
          if (stopping || (!wasReady && (!production || retries > 5))) return false;
          return Math.min(250 * 2 ** Math.min(retries, 5), wasReady ? 5_000 : 1_000);
        },
      },
    });
    client = pending;
    pending.on('error', (error) => {
      // Failed initial attempts produce one final diagnostic, not a line for
      // every TCP refusal. Runtime failures log once until the ready event.
      if (!wasReady || outageReported || stopping) return;
      outageReported = true;
      log.warn({ err: error }, 'Redis unavailable; shared storage requests remain blocked until recovery');
    });
    pending.on('ready', () => {
      const recovered = outageReported;
      wasReady = true;
      outageReported = false;
      log.info(recovered ? 'Redis connection restored' : 'Redis connected');
    });

    connectionPromise = pending.connect().then(() => pending).catch((error) => {
      destroy(pending);
      if (client === pending) client = undefined;
      if (production) throw error;
      retryAfter = now() + 30_000;
      if (!outageReported) {
        outageReported = true;
        log.warn({ err: error }, 'Redis unavailable; development sessions will use MongoDB. Leave REDIS_URL blank if Redis is not installed.');
      }
      return null;
    }).finally(() => { connectionPromise = undefined; });
    return connectionPromise;
  }

  async function disconnect() {
    stopping = true;
    const current = client;
    client = undefined;
    // Shutdown must not wait for an unavailable server or an offline queue.
    destroy(current);
    if (connectionPromise) await connectionPromise.catch(() => {});
    connectionPromise = undefined;
    retryAfter = 0;
    outageReported = false;
  }

  return Object.freeze({ get, disconnect, isReady: () => Boolean(client?.isReady) });
}

const connection = createRedisConnection({ url: env.redisUrl, production: env.isProduction });

export async function getRedisClient() {
  if (!env.redisUrl) return null;
  return connection.get();
}

export const disconnectRedis = () => connection.disconnect();
export const isRedisReady = () => connection.isReady();
