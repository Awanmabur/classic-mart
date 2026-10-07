import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ensureModelIndexes, reconcileTtlIndex, ttlIndexEntriesForModels } from '../src/core/indexes.js';
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');

test('seed discovers every declared TTL index instead of maintaining a partial hand list',()=>{
  const ttl0={modelName:'Presence',schema:{indexes:()=>[[{expiresAt:1},{expireAfterSeconds:0}]]}};
  const ttl180={modelName:'Usage',schema:{indexes:()=>[[{createdAt:1},{expireAfterSeconds:180*86400}]]}};
  const normal={modelName:'Normal',schema:{indexes:()=>[[{createdAt:-1},{}],[{country:1,createdAt:-1},{}]]}};
  const entries=ttlIndexEntriesForModels([ttl0,ttl180,normal]);
  assert.deepEqual(entries.map(({model,field,expireAfterSeconds})=>[model.modelName,field,expireAfterSeconds]),[
    ['Presence','expiresAt',0],['Usage','createdAt',180*86400],
  ]);
  const seed=read('scripts/seed.js');
  assert.match(seed,/ttlIndexEntriesForModels\(indexModels\)/);
  assert.doesNotMatch(seed,/\{ model: SupportTicketPresence, field: 'expiresAt' \}/);
});

test('TTL fallback recreates the corrected index immediately instead of leaving it for a later global phase',async()=>{
  let dropCalls=0,createCalls=0;
  const model={
    modelName:'SupportTicketPresence',
    collection:{
      collectionName:'supportticketpresences',
      indexes:async()=>[{name:'expiresAt_1',key:{expiresAt:1}}],
      dropIndex:async()=>{dropCalls+=1;},
      createIndex:async(key,options)=>{createCalls+=1;assert.deepEqual(key,{expiresAt:1});assert.deepEqual(options,{name:'expiresAt_1',expireAfterSeconds:0});return 'expiresAt_1';},
    },
    db:{db:{command:async()=>{const error=new Error('legacy normal index');error.code=85;error.codeName='IndexOptionsConflict';throw error;}}},
  };
  await reconcileTtlIndex(model,'expiresAt',0);
  assert.equal(dropCalls,1);
  assert.equal(createCalls,1);
});

test('index creation identifies the exact model and seed logs Error objects through pino err serialization',async()=>{
  const ok={modelName:'OkModel',createIndexes:async()=>{}};
  const broken={modelName:'WorkerHeartbeat',createIndexes:async()=>{const error=new Error('expiresAt_1 conflict');error.code=85;error.codeName='IndexOptionsConflict';throw error;}};
  const events=[];
  await assert.rejects(()=>ensureModelIndexes([ok,broken],{error:(meta,msg)=>events.push({meta,msg})}),/Index creation failed for WorkerHeartbeat: expiresAt_1 conflict/);
  assert.equal(events.length,1);
  assert.equal(events[0].meta.modelName,'WorkerHeartbeat');
  assert.equal(events[0].meta.err.message,'expiresAt_1 conflict');
  assert.match(read('scripts/seed.js'),/logger\.error\(\{ err: error \}, 'Seed failed'\)/);
});

test('dependency policy pins patched sharp and qs lines',()=>{
  const pkg=JSON.parse(read('package.json'));
  const lock=JSON.parse(read('package-lock.json'));
  assert.equal(pkg.dependencies.sharp,'0.35.5');
  assert.equal(pkg.overrides?.qs,'6.16.0');
  assert.equal(lock.packages['node_modules/sharp'].version,'0.35.5');
  assert.equal(lock.packages['node_modules/qs'].version,'6.16.0');
});
