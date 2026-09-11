import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectMongoUri } from '../src/core/project-env.js';
import mongoose from 'mongoose';
import { mongoDatabaseName, mongoUriWithDatabase } from '../src/core/mongo-uri.js';

const sourceUri=projectMongoUri();
if(!sourceUri)throw new Error('MONGO_URI is required.');
const targetUri=String(process.env.BACKUP_DRILL_MONGO_URI||'').trim()||mongoUriWithDatabase(sourceUri,'classic-mart-restore-test');
const sourceDb=mongoDatabaseName(sourceUri),targetDb=mongoDatabaseName(targetUri);
if(!/restore-test$/i.test(targetDb))throw new Error('BACKUP_DRILL_MONGO_URI database name must end in restore-test.');
if(sourceDb===targetDb)throw new Error('Restore-test database must be different from the application database.');

function evidencePath(){
  const configured=String(process.env.BACKUP_DRILL_EVIDENCE_PATH||'').trim();
  if(!configured)return '';
  if(!path.isAbsolute(configured))throw new Error('BACKUP_DRILL_EVIDENCE_PATH must be an absolute .json path outside the application tree.');
  if(path.extname(configured).toLowerCase()!=='.json')throw new Error('BACKUP_DRILL_EVIDENCE_PATH must end in .json.');
  const resolved=path.resolve(configured),root=path.resolve(process.cwd());
  if(resolved===root||resolved.startsWith(`${root}${path.sep}`))throw new Error('BACKUP_DRILL_EVIDENCE_PATH must be outside the application tree so evidence cannot enter a release archive.');
  return resolved;
}

function safeIndexSpec(index){
  const allowed=['name','key','unique','sparse','expireAfterSeconds','partialFilterExpression','collation','hidden','wildcardProjection'];
  return Object.fromEntries(allowed.filter(key=>index[key]!==undefined).map(key=>[key,index[key]]));
}

async function copyCollection(source,target,name){
  let copied=0;
  let batch=[];
  for await(const doc of source.db.collection(name).find({}).batchSize(500)){
    batch.push(doc);
    if(batch.length>=500){await target.db.collection(name).insertMany(batch,{ordered:false});copied+=batch.length;batch=[];}
  }
  if(batch.length){await target.db.collection(name).insertMany(batch,{ordered:false});copied+=batch.length;}
  const restored=await target.db.collection(name).countDocuments();
  if(restored!==copied)throw new Error(`${name}: restored ${restored}, expected ${copied}`);
  const indexes=(await source.db.collection(name).indexes()).filter(index=>index.name!=='_id_');
  if(indexes.length)await target.db.collection(name).createIndexes(indexes.map(safeIndexSpec));
  const restoredIndexes=await target.db.collection(name).indexes();
  const expectedNames=new Set(indexes.map(index=>index.name));
  const restoredNames=new Set(restoredIndexes.map(index=>index.name));
  const missingIndexes=[...expectedNames].filter(index=>!restoredNames.has(index));
  if(missingIndexes.length)throw new Error(`${name}: missing restored indexes ${missingIndexes.join(', ')}`);
  return {documents:restored,indexes:restoredIndexes.length};
}

const startedAt=new Date();
const drillId=`logical-restore-${startedAt.toISOString().replace(/[:.]/g,'-')}-${crypto.randomBytes(4).toString('hex')}`;
const source=mongoose.createConnection(sourceUri,{serverSelectionTimeoutMS:5000});
const target=mongoose.createConnection(targetUri,{serverSelectionTimeoutMS:5000});
await Promise.all([source.asPromise(),target.asPromise()]);
try{
  await target.dropDatabase();
  const available=(await source.db.listCollections().toArray()).map(x=>x.name);
  const wanted=['users','products','productvariants','stockitems','orders','sellerorders','paymentintents','ledgertransactions','auditlogs','securityevents'];
  const copied={};
  for(const name of wanted.filter(name=>available.includes(name)))copied[name]=await copyCollection(source,target,name);
  if(!Object.keys(copied).length)throw new Error('No critical collections were available to restore.');
  const restoredAt=new Date();
  const rtoMinutes=Number(((restoredAt-startedAt)/60_000).toFixed(3));
  const result={
    schemaVersion:1,
    evidenceType:'logical_restore',
    drillId,
    passed:true,
    pitrProven:false,
    rpoMinutes:null,
    rtoMinutes,
    sourceSnapshotAt:startedAt.toISOString(),
    restoredAt:restoredAt.toISOString(),
    sourceDatabase:sourceDb,
    targetDatabase:targetDb,
    copied,
    scope:'MongoDB critical collections, document counts and declared collection indexes. Object/media storage, provider PITR, deployment configuration and encryption-key recovery require separate infrastructure evidence.',
  };
  const out=evidencePath();
  if(out){fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});fs.writeFileSync(out,`${JSON.stringify(result,null,2)}\n`,{mode:0o600});}
  console.log(JSON.stringify(result));
}finally{await Promise.allSettled([source.close(),target.close()]);}
