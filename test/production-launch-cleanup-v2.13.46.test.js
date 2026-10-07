import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(file)=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

const index=read('views/index.ejs');
const script=read('public/script.js');
const styles=read('public/styles.css');
const envSource=read('src/config/env.js');
const pkg=JSON.parse(read('package.json'));

test('homepage category carousel renders every category in one row with primary categories first',()=>{
  assert.match(index,/homepageOrderedCategories/);
  assert.match(index,/homepagePrimaryCategoryIds[\s\S]*homepageExtraCategories[\s\S]*homepageOrderedCategories/);
  assert.match(index,/homepageOrderedCategories\.forEach\(category/);
  assert.doesNotMatch(index,/homepagePrimaryCategories\.forEach\(category/);
  assert.match(styles,/#categories \.category-row[\s\S]*display:\s*grid[\s\S]*grid-auto-flow:\s*column[\s\S]*overflow-x:\s*auto/);
  assert.doesNotMatch(styles,/#categories \.category-row[\s\S]{0,350}grid-template-columns:\s*repeat\(10/);
});

test('client category hydration keeps all categories and More jumps instead of gating visibility',()=>{
  assert.match(script,/const visibleCategories = ordered;/);
  assert.doesNotMatch(script,/categoriesExpanded\s*\?/);
  assert.match(script,/data-category-more[\s\S]*firstExtra[\s\S]*scrollTo/);
  assert.doesNotMatch(script,/categoriesExpanded\s*=\s*!categoriesExpanded/);
});

test('production runtime fails closed on real infrastructure requirements',()=>{
  assert.match(envSource,/Production requires REDIS_URL/);
  assert.match(envSource,/Production requires PESAPAL_SANDBOX=false/);
  assert.match(envSource,/PERSISTENT_STORAGE_ROOT/);
  assert.match(envSource,/STORAGE_PERSISTENCE/);
  assert.match(envSource,/outside the application source tree/);
  assert.match(envSource,/Production requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM/);
  assert.doesNotMatch(envSource,/classicmart\.local/);
});

test('production environment template contains no localhost or sandbox defaults',()=>{
  const prod=read('.env.production.example');
  assert.match(prod,/^NODE_ENV=production$/m);
  assert.match(prod,/^PESAPAL_SANDBOX=false$/m);
  assert.match(prod,/^PESAPAL_BASE_URL=https:\/\/pay\.pesapal\.com\/v3$/m);
  assert.match(prod,/^STORAGE_PERSISTENCE=mounted$/m);
  assert.doesNotMatch(prod,/localhost|127\.0\.0\.1|cybqa|MONGO_MODE=local|MAIL_MODE=log|SMS_MODE=log/i);
});

test('production bootstrap creates platform primitives but no demo marketplace activity',()=>{
  const bootstrap=read('scripts/bootstrap-production.js');
  assert.match(bootstrap,/NODE_ENV must be production/);
  assert.match(bootstrap,/PlatformGrant/);
  assert.match(bootstrap,/CountrySetting/);
  assert.match(bootstrap,/Category/);
  assert.doesNotMatch(bootstrap,/\bProduct(?:Media|Variant)?\b|\bStore\b|\bCampaign\b|\bPromoterVerification\b|\bReview\b|\bOrder\b/);
  assert.doesNotMatch(bootstrap,/demo|fixture|seed product|reference catalogue/i);
  assert.equal(pkg.scripts['bootstrap:production'],'node scripts/bootstrap-production.js');
});

test('production release builder excludes development and demo tooling',()=>{
  const builder=read('scripts/build-production-release.js');
  for(const forbidden of ['test','tests','.github','scripts/ensure-local-mongo.js','scripts/reset-local.js','scripts/fetch-seed-product-images.js','scripts/seed.js','src/core/local-mongo.js','public/assets/products','public/dashboard-assets']){
    assert.match(builder,new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  }
  assert.match(builder,/\.env\.production\.example/);
  assert.equal(pkg.scripts['release:production'],'node scripts/build-production-release.js');
  assert.match(builder,/stagedPackage\.scripts=\{/);
  assert.match(builder,/delete stagedPackage\.devDependencies/);
  assert.match(read('Dockerfile'),/npm ci --omit=dev/);
});


test('production launch supervises web and worker in one service when mounted storage is used',()=>{
  const supervisorUrl=new URL('../scripts/run-production.js',import.meta.url);
  assert.ok(fs.existsSync(supervisorUrl),'scripts/run-production.js must exist');
  const supervisor=fs.readFileSync(supervisorUrl,'utf8');
  const docker=read('Dockerfile');
  const builder=read('scripts/build-production-release.js');
  assert.match(supervisor,/src\/server\.js/);
  assert.match(supervisor,/src\/worker\.js/);
  assert.match(supervisor,/spawn\(/);
  assert.match(supervisor,/SIGTERM/);
  assert.match(supervisor,/SIGINT/);
  assert.match(docker,/CMD \["node", "scripts\/run-production\.js"\]/);
  assert.match(builder,/scripts\/run-production\.js/);
  assert.match(builder,/start:'node scripts\/run-production\.js'/);
});

test('production web and worker verify durable storage is writable before connecting',()=>{
  const storageUrl=new URL('../src/config/storage.js',import.meta.url);
  assert.ok(fs.existsSync(storageUrl),'src/config/storage.js must exist');
  const storage=fs.readFileSync(storageUrl,'utf8');
  const server=read('src/server.js');
  const worker=read('src/worker.js');
  assert.match(storage,/ensureStorageReady/);
  assert.match(storage,/env\.uploadDir/);
  assert.match(storage,/env\.exportDir/);
  assert.match(storage,/env\.privacyExportDir/);
  assert.match(storage,/writeFile/);
  assert.match(storage,/unlink/);
  assert.match(server,/await ensureStorageReady\(\);[\s\S]*await connectDatabase\(\)/);
  assert.match(worker,/async function start\(\)\{await ensureStorageReady\(\);await connectDatabase\(\)/);
});

test('production bootstrap can be rerun after ADMIN_PASSWORD is removed',()=>{
  const bootstrap=read('scripts/bootstrap-production.js');
  assert.doesNotMatch(bootstrap,/if \(!env\.admin\.email \|\| !env\.admin\.phone \|\| !env\.admin\.password\)[^\n]*first production bootstrap/);
  assert.match(bootstrap,/let admin = await User\.findOne[\s\S]*if \(!admin\) \{[\s\S]*ADMIN_PASSWORD/);
  assert.match(bootstrap,/if \(!admin\) \{[\s\S]*assertStrongPassword\(env\.admin\.password\)/);
});

test('category carousel cache namespace advances for always-loaded taxonomy',()=>{
  assert.match(read('public/sw.js'),/classic-mart-public-v26/);
});


test('production release includes a Render launch blueprint with secret prompts and durable disk',()=>{
  const blueprintUrl=new URL('../render.yaml',import.meta.url);
  assert.ok(fs.existsSync(blueprintUrl),'render.yaml must exist for production launch');
  const blueprint=fs.readFileSync(blueprintUrl,'utf8');
  const builder=read('scripts/build-production-release.js');
  assert.match(blueprint,/type:\s*web/);
  assert.match(blueprint,/runtime:\s*docker/);
  assert.match(blueprint,/plan:\s*1c-2g/);
  assert.match(blueprint,/healthCheckPath:\s*\/health\/ready/);
  assert.match(blueprint,/mountPath:\s*\/var\/data/);
  assert.match(blueprint,/numInstances:\s*1/);
  assert.match(blueprint,/preDeployCommand:\s*npm run migrate:apply && npm run bootstrap:production && npm run production:data-check/);
  for(const key of ['MONGO_URI','PESAPAL_CONSUMER_KEY','PESAPAL_CONSUMER_SECRET','SMTP_PASSWORD','TWILIO_AUTH_TOKEN','SIEM_TOKEN']){
    assert.match(blueprint,new RegExp(`key:\\s*${key}[\\s\\S]{0,80}sync:\\s*false`));
  }
  assert.match(builder,/['"]render\.yaml['"]/);
});

test('production release demo-path scan uses real word boundaries',()=>{
  const builder=read('scripts/build-production-release.js');
  assert.doesNotMatch(builder,/\x08/);
  assert.match(builder,/\\b\(\?:demo\|fixture\)\\b/);
});


test('production Docker image carries its own malware scanner for same-day launch',()=>{
  const docker=read('Dockerfile');
  const prod=read('.env.production.example');
  assert.match(docker,/apt-get install[\s\S]*clamav/);
  assert.match(docker,/freshclam/);
  assert.match(prod,/^MALWARE_SCAN_MODE=clamscan$/m);
  assert.match(prod,/^CLAMAV_PATH=\/usr\/bin\/clamscan$/m);
  assert.doesNotMatch(prod,/^CLAMAV_HOST=/m);
});

test('production release content scan blocks development identities outside data guards',()=>{
  const builder=read('scripts/build-production-release.js');
  assert.match(builder,/forbiddenContent/);
  assert.match(builder,/contentScanExemptions/);
  assert.ok(builder.includes('admin@classicmart\\.local'));
  for(const token of ['prd_seed_','usr_demo_','initial_catalogue_seed']) assert.ok(builder.includes(token));
  assert.match(builder,/scripts\/check-production-data\.js/);
  assert.match(builder,/scripts\/launch-check\.js/);
});

test('first production deploy can precede Pesapal IPN registration while checkout and launch remain fail-closed',()=>{
  const pesapal=read('src/services/pesapal.js');
  const launch=read('scripts/launch-check.js');
  const blueprint=read('render.yaml');
  assert.doesNotMatch(envSource,/\['PESAPAL_CONSUMER_KEY','PESAPAL_CONSUMER_SECRET','PESAPAL_IPN_ID'\]/);
  assert.match(pesapal,/if \(!env\.pesapal\.notificationId\) throw new AppError\('Pesapal IPN ID is not configured\.'/);
  assert.match(launch,/!env\.pesapal\.notificationId[\s\S]{0,120}PESAPAL_IPN_ID/);
  assert.doesNotMatch(blueprint,/key:\s*PESAPAL_IPN_ID/);
});
