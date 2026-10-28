import session from 'express-session';
import MongoStore from 'connect-mongo';
import { RedisStore } from 'connect-redis';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { requireRedisCommand } from '../core/redis-command.js';

export function createRedisSessionStore(redisClient) {
  // Keep the shared reconnecting client. Only this store's operations receive
  // reply deadlines; a healthy idle connection is never closed by a timer.
  const client = Object.fromEntries(['get', 'set', 'expire', 'del', 'mGet'].map(method => [
    method, (...args) => requireRedisCommand(() => redisClient[method](...args)),
  ]));
  client.scanIterator = async function* (...args) {
    const iterator = redisClient.scanIterator(...args);
    for (;;) {
      const { done, value } = await requireRedisCommand(() => iterator.next());
      if (done) return;
      yield value;
    }
  };
  return new RedisStore({ client, prefix: 'classic-mart:sess:', ttl: 30 * 24 * 60 * 60 });
}

export function createSessionMiddleware(redisClient) {
  const store = env.isTest
    ? new session.MemoryStore()
    : redisClient
    ? createRedisSessionStore(redisClient)
      : MongoStore.create({
        client: mongoose.connection.getClient(),
        collectionName: 'sessions',
        ttl: 30 * 24 * 60 * 60,
        touchAfter: 60,
        autoRemove: 'native',
        stringify: false,
      });

  return session({
    name: 'cm.sid',
    secret: env.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: env.trustProxy > 0,
    cookie: {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 8 * 60 * 60_000,
    },
  });
}
