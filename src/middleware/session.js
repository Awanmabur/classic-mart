import session from 'express-session';
import MongoStore from 'connect-mongo';
import { RedisStore } from 'connect-redis';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

export function createSessionMiddleware(redisClient) {
  const store = env.isTest
    ? new session.MemoryStore()
    : redisClient
    ? new RedisStore({
        client: redisClient,
        prefix: 'classic-mart:sess:',
        ttl: 30 * 24 * 60 * 60,
      })
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
