import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { launchReadiness } from '../src/services/launch.js';
import mongoose from 'mongoose';
import { ensureMediaStorageReady } from '../src/services/object-storage.js';
const configFailures=[];
const developmentDataChecks=[
  ['users',{$or:[{publicId:/^usr_demo_/},{emailNormalized:/@classicmart\.local$/i}]}],
  ['products',{publicId:{$in:[/^prd_seed_/,/^prd_starter_/]}}],['productmedias',{publicId:{$in:[/^med_seed_/,/^med_starter_/]}}],['productvariants',{publicId:{$in:[/^var_seed_/,/^var_starter_/]}}],
  ['stores',{publicId:{$in:['str_classic_mart_starter']}}],['campaigns',{publicId:/^cmp_demo_/}],['campaignapplications',{publicId:/^cpa_demo_/}],
  ['promoterverifications',{publicId:/^prv_demo_/}],['inventorymovements',{reference:{$in:['initial_catalogue_seed','starter_catalogue_seed']}}],
];
if(!env.isProduction)configFailures.push('NODE_ENV must be production for launch sign-off');
if(!env.security.launchCountries.length)configFailures.push('LAUNCH_COUNTRIES is empty');
if(!env.security.privilegedMfaRequired)configFailures.push('PRIVILEGED_MFA_REQUIRED is not true');
if(env.security.siem.mode==='off')configFailures.push('SIEM_MODE is off');
if(!env.pesapal.notificationId)configFailures.push('PESAPAL_IPN_ID is not configured');
if(!env.security.idsEnabled||!env.security.ipsEnabled)configFailures.push('IDS/IPS must be enabled');
await ensureMediaStorageReady();
await connectDatabase();
try{
  const developmentData=[];
  for(const [collection,filter] of developmentDataChecks){const found=await mongoose.connection.db.collection(collection).findOne(filter,{projection:{_id:1}});if(found)developmentData.push(collection);}
  const readiness=await launchReadiness();
  const failures=[...configFailures,...developmentData.map(collection=>`development data present: ${collection}`),...readiness.missing.map(item=>`${item.key}: ${item.status}`),...readiness.recoveryIssues,...readiness.unresolved.map(item=>`${item.publicId}: unresolved ${item.severity} finding` )];
  if(failures.length){console.error('Launch gate blocked:\n- '+failures.join('\n- '));process.exitCode=1;}else console.log(`Stage 12 launch gate passed for ${env.security.launchCountries.join(', ')}.`);
}finally{await disconnectDatabase();}
