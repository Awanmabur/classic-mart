import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=(rel)=>fs.readFileSync(path.join(root,rel),'utf8');

test('bounded maintenance scanners have persistent eventual-progress cursors',()=>{
  const model=read('src/models/MaintenanceScanCursor.js');
  const scan=read('src/services/maintenance-scan.js');
  const maintenance=read('src/services/maintenance.js');
  const ai=read('src/services/ai.js');

  assert.match(model,/scanName:\s*\{[^}]*unique:\s*true/);
  assert.match(model,/lastId:/);
  assert.match(model,/completedPasses:/);
  assert.match(scan,/MaintenanceScanCursor\.findOne\(\{ scanName \}\)/);
  assert.match(scan,/\{ _id: \{ \$gt: state\.lastId \} \}/);
  assert.match(scan,/passCompleted/);
  assert.match(scan,/lastId: nextId/);
  assert.match(scan,/\$inc: \{ completedPasses: 1 \}/);

  assert.match(maintenance,/scanMaintenanceBatch\(ProductAlert, 'product_alerts_active'/);
  assert.doesNotMatch(maintenance,/ProductAlert\.find\(\{ status: 'active' \}\)\.sort\(\{ updatedAt: 1 \}\)\.limit/);
  assert.match(ai,/scanMaintenanceBatch\(Product,'published_product_embeddings'/);
  assert.doesNotMatch(ai,/Product\.find\(\{status:'published'\}\)\.sort\(\{updatedAt:1\}\)\.limit/);
});

test('embedding discovery is source, country and active-model aware',()=>{
  const ai=read('src/services/ai.js');
  assert.match(ai,/async function embeddingTargets\(countries,role='seller'\)/);
  assert.match(ai,/modelKey:`\$\{model\.provider\}:\$\{model\.model\}`/);
  assert.match(ai,/sourceHash:sh,\$or:targets\.map/);
  assert.match(ai,/current<targets\.length/);
  assert.match(ai,/for\(const \[modelKey,group\] of groups\)/);
});

test('AI jobs use reclaimable leases and fail exhausted interrupted claims',()=>{
  const model=read('src/models/AiJob.js');
  const ai=read('src/services/ai.js');
  assert.match(model,/lockedUntil:\{type:Date,default:null\}/);
  assert.match(model,/schema\.index\(\{status:1,lockedUntil:1,availableAt:1,createdAt:1\}\)/);
  assert.match(ai,/AI_JOB_LEASE_MS/);
  assert.match(ai,/status:'running',attempts:\{\$lt:10\}/);
  assert.match(ai,/lockedUntil/);
  assert.match(ai,/AI_JOB_LEASE_EXHAUSTED/);
  assert.match(ai,/job\.lockedUntil=null/);
});

test('product alerts reject meaningless restock watches and paginate history',()=>{
  const route=read('src/routes/storefront.js');
  const script=read('public/script.js');
  const preview=read('public/product-preview.js');
  assert.match(route,/PRODUCT_ALREADY_IN_STOCK/);
  assert.match(route,/ProductAlert\.find\(cursorScope\(base,request\.query\.after\)\)/);
  assert.match(route,/pageResult\(rows,\{limit,total\}\)/);
  assert.match(route,/country:request\.country\.code/);
  for(const source of [script,preview]){
    assert.match(source,/Number\(product\.stock\|\|0\)<=0\?/);
  }
});

test('database setup creates indexes for every exported model after TTL reconciliation',()=>{
  const seed=read('scripts/seed.js');
  assert.match(seed,/import \* as allModels from '\.\.\/src\/models\/index\.js'/);
  assert.match(seed,/reconcileExpiryIndexes\(/);
  assert.match(seed,/Object\.values\(allModels\)\.filter\(\(model\)=>model\?\.createIndexes\)/);
  assert.match(seed,/ttlIndexEntriesForModels\(indexModels\)/);
  assert.match(seed,/ensureModelIndexes\(indexModels, logger\)/);
});

test('demand forecasting aggregates in MongoDB instead of loading the 90-day order set into memory',()=>{
  const ai=read('src/services/ai.js');
  assert.match(ai,/job\.type==='demand_forecast'/);
  assert.match(ai,/Order\.aggregate\(\[/);
  assert.match(ai,/\$facet:\{summary:/);
  assert.match(ai,/\$group:\{_id:'\$items\.productPublicId',units:\{\$sum:'\$items\.quantity'\}\}/);
  assert.doesNotMatch(ai,/const orders=await Order\.find\(\{country:job\.country/);
});
