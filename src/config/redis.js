import { createClient } from 'redis';
import { env } from './env.js';
import { logger } from './logger.js';

let client;
let connectionPromise;

export async function getRedisClient() {
  if (!env.redisUrl) return null;
  if (client?.isReady) return client;
  if (connectionPromise) return connectionPromise;

  client = createClient({
    url: env.redisUrl,
    socket: {
      connectTimeout: 3_000,
      reconnectStrategy(retries) {
        if (retries > 5) return false;
        return Math.min(retries * 200, 1_000);
      },
    },
  });
  client.on('error', (error) =>
    logger.warn({ error: error.message }, 'Redis connection issue'),
  );

  connectionPromise = client
    .connect()
    .then(() => {
      logger.info('Redis connected');
      return client;
    })
    .catch((error) => {
      if (env.isProduction) {
        client = undefined;
        throw error;
      }
      logger.warn(
        { error: error.message },
        'Redis unavailable; MongoDB-backed sessions will be used',
      );
      client = undefined;
      return null;
    })
    .finally(() => {
      connectionPromise = undefined;
    });

  return connectionPromise;
}

export async function disconnectRedis() {
  if (client?.isOpen) await client.quit();
  client = undefined;
}

export function isRedisReady() {
  return Boolean(client?.isReady);
}
