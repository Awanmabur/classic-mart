import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';

if (!env.isProduction) throw new Error('NODE_ENV must be production for production data checks.');

const checks = [
  ['users', { $or: [{ publicId: /^usr_demo_/ }, { emailNormalized: /@classicmart\.local$/i }] }],
  ['products', { publicId: { $in: [/^prd_seed_/, /^prd_starter_/] } }],
  ['productmedias', { publicId: { $in: [/^med_seed_/, /^med_starter_/] } }],
  ['productvariants', { publicId: { $in: [/^var_seed_/, /^var_starter_/] } }],
  ['stores', { publicId: { $in: ['str_classic_mart_starter'] } }],
  ['campaigns', { publicId: /^cmp_demo_/ }],
  ['campaignapplications', { publicId: /^cpa_demo_/ }],
  ['promoterverifications', { publicId: /^prv_demo_/ }],
  ['inventorymovements', { reference: { $in: ['initial_catalogue_seed', 'starter_catalogue_seed'] } }],
];

await connectDatabase({ autoIndex: false });
try {
  const findings = [];
  for (const [collection, filter] of checks) {
    const exists = await mongoose.connection.db.collection(collection).findOne(filter, { projection: { _id: 1 } });
    if (exists) findings.push(collection);
  }
  if (findings.length) {
    throw new Error(`Production database contains development/reference data in: ${findings.join(', ')}. Launch from a clean production database or remove those records through a reviewed migration.`);
  }
  console.log('Production data check passed: no known development/demo marketplace records detected.');
} finally {
  await disconnectDatabase();
}
