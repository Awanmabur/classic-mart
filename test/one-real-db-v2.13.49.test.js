import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const seed = fs.readFileSync('scripts/seed-initial-catalogue.js','utf8');
const catalogue = fs.readFileSync('src/config/initial-catalogue.js','utf8');
const cleanBuilder = fs.readFileSync('scripts/build-clean-app-release.js','utf8');
const prodBuilder = fs.readFileSync('scripts/build-production-release.js','utf8');

test('external setup seeds the one explicit real database through an initial catalogue command',()=>{
  assert.equal(pkg.scripts['seed:initial'],'node scripts/seed-initial-catalogue.js');
  assert.equal(pkg.scripts['setup:external'],'npm run db:verify && npm run media:r2:check && npm run seed:initial');
  assert.equal(pkg.scripts['db:setup'],'npm run setup:external');
  assert.equal(pkg.scripts['db:seed'],'npm run seed:initial');
  assert.doesNotMatch(JSON.stringify(pkg.scripts),/seed:starter|seed-starter-catalogue/);
});

test('real database seed requires an explicit database name and deliberate confirmation',()=>{
  assert.match(seed,/INITIAL_CATALOGUE_CONFIRM/);
  assert.match(seed,/SEED_REAL_CLASSIC_MART/);
  assert.match(seed,/databaseNameFromUri/);
  assert.match(seed,/database name is required/i);
  assert.doesNotMatch(seed,/dev\|development\|staging\|test/);
  assert.doesNotMatch(seed,/NODE_ENV=production.*disabled/i);
});

test('initial catalogue uses production-style identities and no starter/demo markers',()=>{
  assert.doesNotMatch(seed,/prd_starter_|med_starter_|var_starter_|stk_starter_|mov_starter_|starter_catalogue_seed|Development\/staging starter|Starter Store|Starter Warehouse/);
  assert.match(seed,/prd_catalog_/);
  assert.match(seed,/med_catalog_/);
  assert.match(seed,/var_catalog_/);
  assert.match(seed,/initial_catalogue_import/);
  assert.doesNotMatch(catalogue,/development|staging|demo/i);
});

test('initial catalogue media is stored in R2 and repeat runs are idempotent',()=>{
  assert.match(seed,/MEDIA_STORAGE_DRIVER/);
  assert.match(seed,/putMediaObject/);
  assert.match(seed,/Product\.findOneAndUpdate/);
  assert.match(seed,/ProductMedia\.findOneAndUpdate/);
  assert.match(seed,/InventoryMovement\.exists/);
});



test('production guards allow the official catalogue identities while still blocking legacy demo markers',()=>{
  const dataCheck = fs.readFileSync('scripts/check-production-data.js','utf8');
  const launchCheck = fs.readFileSync('scripts/launch-check.js','utf8');
  for (const text of [dataCheck, launchCheck]) {
    assert.doesNotMatch(text,/['"]str_classic_mart['"]/);
    assert.doesNotMatch(text,/prd_catalog_|med_catalog_|var_catalog_|initial_catalogue_import/);
    assert.match(text,/prd_seed_/);
    assert.match(text,/prd_starter_/);
  }
});

test('clean app includes initial catalogue setup while production artifact excludes the seeder',()=>{
  assert.match(cleanBuilder,/scripts\/seed-initial-catalogue\.js/);
  assert.match(cleanBuilder,/src\/config\/initial-catalogue\.js/);
  assert.doesNotMatch(cleanBuilder,/seed-starter-catalogue|starter-catalogue/);
  assert.match(prodBuilder,/scripts\/seed-initial-catalogue\.js/);
  assert.match(prodBuilder,/src\/config\/initial-catalogue\.js/);
});
