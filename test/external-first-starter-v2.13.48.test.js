import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(file)=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

const pkg=JSON.parse(read('package.json'));
const mediaUrl=read('src/services/product-media-url.js');
const prodBuilder=read('scripts/build-production-release.js');

test('development is external-service first and never rewrites Mongo settings automatically',()=>{
  assert.equal(pkg.scripts.dev,'node src/server.js');
  assert.equal(pkg.scripts['dev:watch'],'node --watch src/server.js');
  assert.doesNotMatch(pkg.scripts.dev,/db:local|ensure-local-mongo/);
  assert.equal(pkg.scripts['setup:external'],'npm run db:verify && npm run media:r2:check && npm run seed:initial');
  assert.equal(pkg.scripts['seed:initial'],'node scripts/seed-initial-catalogue.js');
});

test('initial catalogue seeder is explicitly Atlas/R2 and deliberate-confirmation only',()=>{
  const seed=read('scripts/seed-initial-catalogue.js');
  assert.match(seed,/INITIAL_CATALOGUE_CONFIRM/);
  assert.match(seed,/SEED_REAL_CLASSIC_MART/);
  assert.match(seed,/MONGO_MODE.*external/);
  assert.match(seed,/MEDIA_STORAGE_DRIVER.*r2/);
  assert.match(seed,/database name is required/i);
  assert.match(seed,/putMediaObject/);
  assert.match(seed,/deleteMediaObject/);
  assert.doesNotMatch(seed,/fs\.writeFile|env\.uploadDir/);
});

test('initial catalogue contains useful products but no fake promoter campaign or local demo accounts',()=>{
  const seed=read('scripts/seed-initial-catalogue.js');
  const catalogue=read('src/config/initial-catalogue.js');
  assert.match(catalogue,/initialProducts/);
  assert.match(catalogue,/wireless-headphones/);
  assert.match(catalogue,/portable-speaker/);
  assert.match(catalogue,/https:\/\/images\.pexels\.com\//);
  assert.doesNotMatch(seed,/promoter\.demo@classicmart\.local|cmp_demo_|cpa_demo_|prv_demo_/i);
  assert.doesNotMatch(catalogue,/promoter\.demo@classicmart\.local|cmp_demo_|cpa_demo_|prv_demo_/i);
});

test('R2-backed initial catalogue media is delivered through the protected catalogue media route',()=>{
  assert.match(mediaUrl,/env\.mediaStorageDriver !== 'r2'/);
  assert.match(mediaUrl,/\/media\/catalogue\//);
});


test('R2-backed initial catalogue media also feeds visual search through object storage',()=>{
  const visual=read('src/services/visual-search.js');
  assert.match(visual,/media\.source === 'seed_asset' && env\.mediaStorageDriver !== 'r2'/);
  assert.match(visual,/readMediaObjectBuffer\(media\.thumbnailStorageKey \|\| media\.storageKey\)/);
});

test('production artifact excludes starter seed tooling and local-only Mongo helpers',()=>{
  for(const file of ['scripts/seed-initial-catalogue.js','src/config/initial-catalogue.js','scripts/ensure-local-mongo.js','scripts/stop-local-mongo.js','scripts/reset-local.js']){
    assert.match(prodBuilder,new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  }
});

test('clean app release builder strips tests local Mongo tooling old demo seed and local data',()=>{
  const builder=read('scripts/build-clean-app-release.js');
  for(const token of ['test','tests','.github','scripts/ensure-local-mongo.js','scripts/stop-local-mongo.js','scripts/reset-local.js','scripts/seed.js','scripts/fetch-seed-product-images.js','src/core/local-mongo.js','storage','node_modules']){
    assert.match(builder,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  }
  assert.match(builder,/scripts\/seed-initial-catalogue\.js/);
  assert.match(builder,/src\/config\/initial-catalogue\.js/);
});
