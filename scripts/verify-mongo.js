import 'dotenv/config';
import mongoose from 'mongoose';
import { assertMongoTransactions } from '../src/config/mongo-topology.js';
import { mongoUriOption } from '../src/core/mongo-uri.js';
import { projectMongoUri } from '../src/core/project-env.js';

const mongoUri = projectMongoUri();
if (!mongoUri) {
  throw new Error(
    'MONGO_URI is required for verification. Run `npm run db:local` for automatic local setup, or configure Atlas/another transaction-capable replica-set/mongos URI.',
  );
}

let connection;
try {
  connection = await mongoose.createConnection(mongoUri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 20_000,
    maxPoolSize: 2,
  }).asPromise();

  const expectedReplicaSet = mongoUriOption(mongoUri, 'replicaSet');

  const topology = await assertMongoTransactions(connection.db, expectedReplicaSet);
  console.log(
    `MongoDB transaction topology ready — ${topology.isMongos ? 'mongos' : `replicaSet=${topology.setName || 'detected'}`}`,
  );
} catch (error) {
  if (error?.code === 'MONGO_TRANSACTIONS_REQUIRED') {
    throw new Error(
      `${error.message} The configured MONGO_URI is reachable but is not suitable for Classic Mart transaction workflows.`,
    );
  }
  throw error;
} finally {
  if (connection) await connection.close().catch(() => {});
}
