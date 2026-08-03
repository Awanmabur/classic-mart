import mongoose from 'mongoose';
import { setTimeout as delay } from 'node:timers/promises';
import { env } from './env.js';
import { logger } from './logger.js';
import { assertMongoTransactions } from './mongo-topology.js';
import { mongoUriOption } from '../core/mongo-uri.js';

let connectionPromise;

async function connectWithRetry({ autoIndex = !env.isProduction } = {}) {
  if (!env.mongoUri) {
    const error = new Error('MONGO_URI is required. Run `npm run db:local` for automatic local development setup, or configure a managed transaction-capable MongoDB URI.');
    error.code = 'MONGO_URI_REQUIRED';
    throw error;
  }
  mongoose.set('strictQuery', true);
  // Request input is rejected if it contains MongoDB operator/path keys, and routes
  // build explicit schema-validated filters. Global sanitizeFilter would rewrite
  // legitimate server-built $in/$gte/$lte selectors into $eq objects.
  mongoose.set('sanitizeFilter', false);
  const maximumAttempts = env.isTest ? 1 : 6;
  let lastError;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const instance = await mongoose.connect(env.mongoUri, {
        autoIndex,
        maxPoolSize: 30,
        minPoolSize: env.isTest ? 0 : 2,
        maxIdleTimeMS: 30_000,
        serverSelectionTimeoutMS: 5_000,
        socketTimeoutMS: 20_000,
      });
      const expectedReplicaSet = mongoUriOption(env.mongoUri, 'replicaSet');
      const topology = await assertMongoTransactions(instance.connection.db, expectedReplicaSet);
      logger.info(
        { database: instance.connection.name, replicaSet: topology.setName || (topology.isMongos ? 'mongos' : undefined) },
        'MongoDB connected',
      );
      return instance;
    } catch (error) {
      lastError = error;
      await mongoose.disconnect().catch(() => {});
      if (attempt === maximumAttempts) break;
      logger.warn(
        { attempt, maximumAttempts, error: error.message },
        'MongoDB is not ready; retrying',
      );
      await delay(Math.min(attempt * 1_000, 3_000));
    }
  }

  throw lastError;
}

export function connectDatabase(options = {}) {
  if (connectionPromise) return connectionPromise;
  connectionPromise = connectWithRetry(options).catch((error) => {
    connectionPromise = undefined;
    throw error;
  });

  return connectionPromise;
}

export async function disconnectDatabase() {
  connectionPromise = undefined;
  await mongoose.disconnect();
}

export function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}
