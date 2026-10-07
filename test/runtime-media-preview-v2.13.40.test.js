import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
test('SupportTicketPresence has one TTL declaration and setup reconciles the legacy index',()=>{const model=read('src/models/SupportTicketPresence.js'),seed=read('scripts/seed.js');assert.doesNotMatch(model,/expiresAt:\{type:Date,required:true,index:true\}/);assert.match(model,/schema\.index\(\{expiresAt:1\},\{expireAfterSeconds:0\}\)/);assert.match(seed,/ttlIndexEntriesForModels\(indexModels\)/);assert.doesNotMatch(seed,/model: SupportTicketPresence, field: 'expiresAt'/);});
test('PWA assets and catalogue media use release-fresh stale-while-revalidate behavior',()=>{const sw=read('public/sw.js'),pwa=read('public/pwa.js'),media=read('src/routes/media.js');assert.match(sw,/classic-mart-public-v26/);assert.match(sw,/staleWhileRevalidate\(request\)/);assert.match(sw,/startsWith\('\/media\/catalogue\/'\)/);assert.match(pwa,/updateViaCache: 'none'/);assert.match(pwa,/registration\.update\(\)/);assert.doesNotMatch(media,/max-age=86400, immutable/);});
test('development seed provides three photos per each of 12 reference products',()=>{const fetcher=read('scripts/fetch-seed-product-images.js'),seed=read('scripts/seed.js');assert.equal((fetcher.match(/^  \['[^']+\.jpg'/gm)||[]).length,36);assert.equal((seed.match(/photos: \[/g)||[]).length,12);assert.match(seed,/seedPhotos = \(item\.photos \|\| \[\]\)\.slice\(0, 3\)/);assert.match(seed,/position = 0; position < seedPhotos\.length/);});
test('product preview exposes complete buyer context',()=>{for(const path of ['public/product-preview.js','public/script.js']){const js=read(path);assert.match(js,/preview-title-meta/);assert.match(js,/Promoter earns/);assert.match(js,/Watch product video/);assert.match(js,/Barcode/);assert.match(js,/Published/);assert.match(js,/attributeMarkup/);assert.match(js,/product\.returnPolicy/);assert.match(js,/product\.shippingInformation/);assert.match(js,/product\.warrantyInformation/);}});
test('favicon is packaged',()=>{assert.ok(fs.existsSync(new URL('../public/favicon.ico',import.meta.url)));});

test('local development removes stale service workers and unhashed assets revalidate',()=>{const pwa=read('public/pwa.js'),app=read('src/app.js');assert.match(pwa,/getRegistrations\(\)/);assert.match(pwa,/startsWith\('classic-mart-public-'\)/);assert.match(pwa,/registration\.unregister\(\)/);assert.match(app,/file === 'sw\.js'/);assert.match(app,/no-cache, max-age=0, must-revalidate/);});

test('product detail review breakdown uses real verified-purchase rating counts',()=>{const route=read('src/routes/storefront.js');for(const path of ['public/product-preview.js','public/script.js']){const js=read(path);assert.match(js,/ratingDistribution/);assert.match(js,/count \/ ratingTotal/);assert.match(js,/preview-buying-grid/);}assert.match(route,/verifiedPurchase:true/);assert.match(route,/\$group:\{_id:'\$rating',count:\{\$sum:1\}\}/);});

test('direct product URLs retain the requested product outside the bounded home catalogue',()=>{const route=read('src/routes/public.js');assert.match(route,/catalogue\.products\.some\(\(item\) => item\.id === product\.id\)/);assert.match(route,/catalogue\.products = \[product, \.\.\.catalogue\.products\]/);});

test('email dependency is upgraded beyond the September 2026 nodemailer advisories',()=>{const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));assert.equal(pkg.dependencies.nodemailer,'9.1.1');assert.equal(lock.packages['node_modules/nodemailer'].version,'9.1.1');});

test('TTL reconciliation converts the legacy index safely and refuses protected replacements',async()=>{
  const {reconcileTtlIndex}=await import('../src/core/indexes.js');
  let collModCalls=0,dropCalls=0;
  const base={modelName:'SupportTicketPresence',collection:{collectionName:'supportticketpresences',indexes:async()=>[{name:'expiresAt_1',key:{expiresAt:1}}],dropIndex:async()=>{dropCalls+=1;}},db:{db:{command:async()=>{collModCalls+=1;}}}};
  assert.equal((await reconcileTtlIndex(base,'expiresAt',0)).status,'reconciled');
  assert.equal(collModCalls,1);assert.equal(dropCalls,0);
  let fallbackDrops=0,fallbackCreates=0;
  const fallback={...base,collection:{...base.collection,dropIndex:async()=>{fallbackDrops+=1;},createIndex:async(key,options)=>{fallbackCreates+=1;assert.deepEqual(key,{expiresAt:1});assert.deepEqual(options,{name:'expiresAt_1',expireAfterSeconds:0});}},db:{db:{command:async()=>{const error=new Error('different options');error.code=85;error.codeName='IndexOptionsConflict';throw error;}}}};
  await reconcileTtlIndex(fallback,'expiresAt',0);assert.equal(fallbackDrops,1);assert.equal(fallbackCreates,1);
  let unsafeDropped=0;
  const protectedIndex={...base,collection:{...base.collection,indexes:async()=>[{name:'expiresAt_1',key:{expiresAt:1},unique:true}],dropIndex:async()=>{unsafeDropped+=1;}}};
  await assert.rejects(()=>reconcileTtlIndex(protectedIndex,'expiresAt',0),/Refusing to replace protected index/);assert.equal(unsafeDropped,0);
});
