import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { projectMongoPort } from '../src/core/project-env.js';

const port = projectMongoPort();
const replicaSet = 'classicmart-rs';
const uri = `mongodb://127.0.0.1:${port}/admin?directConnection=true`;
const pidFile = path.join(process.cwd(), '.classic-mart', 'mongod.pid');
let connection;
try {
  connection = await mongoose.createConnection(uri, {
    autoIndex: false,
    maxPoolSize: 1,
    directConnection: true,
    serverSelectionTimeoutMS: 2_000,
  }).asPromise();
  const hello = await connection.db.admin().command({ hello: 1 });
  if (hello?.setName !== replicaSet) {
    throw new Error(`Refusing to stop MongoDB on port ${port}: it is not Classic Mart replica set ${replicaSet}.`);
  }
  try {
    await connection.db.admin().command({ shutdown: 1, force: true });
  } catch (error) {
    // A successful MongoDB shutdown closes the socket before a response can be returned.
    if (!/connection|closed|socket|ECONNRESET|pool/i.test(String(error?.message || ''))) throw error;
  }
  console.log('Classic Mart local MongoDB stopped. Data was preserved.');
} catch (error) {
  if (/ECONNREFUSED|Server selection timed out/i.test(String(error?.message || ''))) {
    console.log('Classic Mart local MongoDB is not running.');
  } else {
    throw error;
  }
} finally {
  if (connection) await connection.close().catch(() => {});
  fs.rmSync(pidFile, { force: true });
}
