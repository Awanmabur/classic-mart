import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reconcileTtlIndex } from '../src/core/indexes.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=(name)=>fs.readFileSync(path.join(root,name),'utf8');

test('expiry fields use exactly one TTL schema index and db setup reconciles legacy indexes',()=>{
  const cases=[
    ['src/models/AiCartDraft.js','expiresAt'],
    ['src/models/MobileSession.js','refreshExpiresAt'],
    ['src/models/MobileRefreshUse.js','expiresAt'],
    ['src/models/ApiIdempotency.js','expiresAt'],
  ];
  for(const [file,field] of cases){
    const source=read(file);
    assert.doesNotMatch(source,new RegExp(`${field}:\\{type:Date,required:true,index:true\\}`),`${file} must not declare a competing normal index on ${field}`);
    assert.match(source,new RegExp(`schema\\.index\\(\\{${field}:1\\},\\{expireAfterSeconds:0\\}\\)`),`${file} must retain its TTL index on ${field}`);
  }

  const helper=read('src/core/indexes.js');
  assert.match(helper,/collMod/);
  assert.match(helper,/dropIndex/);
  assert.match(helper,/Refusing to replace protected index/);
  assert.match(helper,/authorization failures are never converted into a destructive/);

  const db=read('src/config/db.js');
  assert.match(db,/connectWithRetry\(\{ autoIndex = !env\.isProduction \} = \{\}\)/);

  const seed=read('scripts/seed.js');
  assert.match(seed,/connectDatabase\(\{ autoIndex: false \}\)/);
  assert.match(seed,/reconcileExpiryIndexes/);
  for(const field of ['expiresAt','refreshExpiresAt'])assert.match(seed,new RegExp(`field: '${field}'`));
});


function fakeModel(index, commandImpl=async()=>({ok:1})){
  const dropped=[];
  const commands=[];
  return {
    modelName:'FakeModel',
    collection:{
      collectionName:'fake_collection',
      indexes:async()=>[index],
      dropIndex:async(name)=>{dropped.push(name);},
    },
    db:{db:{command:async(command)=>{commands.push(command);return commandImpl(command);}}},
    dropped,
    commands,
  };
}

test('TTL reconciliation converts a legacy normal index with collMod',async()=>{
  const model=fakeModel({name:'expiresAt_1',key:{expiresAt:1}});
  await reconcileTtlIndex(model,'expiresAt',0);
  assert.equal(model.commands.length,1);
  assert.equal(model.commands[0].collMod,'fake_collection');
  assert.equal(model.commands[0].index.name,'expiresAt_1');
  assert.equal(model.commands[0].index.expireAfterSeconds,0);
  assert.deepEqual(model.dropped,[]);
});

test('TTL reconciliation does not drop an index after authorization or transient failures',async()=>{
  const denied=Object.assign(new Error('not authorized'),{code:13,codeName:'Unauthorized'});
  const model=fakeModel({name:'expiresAt_1',key:{expiresAt:1}},async()=>{throw denied;});
  await assert.rejects(()=>reconcileTtlIndex(model,'expiresAt',0),/not authorized/);
  assert.deepEqual(model.dropped,[]);
});

test('TTL reconciliation uses guarded replacement only for unsupported collMod conversion',async()=>{
  const unsupported=Object.assign(new Error('invalid option'),{code:72,codeName:'InvalidOptions'});
  const model=fakeModel({name:'expiresAt_1',key:{expiresAt:1}},async()=>{throw unsupported;});
  await reconcileTtlIndex(model,'expiresAt',0);
  assert.deepEqual(model.dropped,['expiresAt_1']);
});
