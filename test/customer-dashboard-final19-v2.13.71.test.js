import { approvedAssetWithSharedFlash } from './approved-ui-fidelity.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';

const root=path.resolve(import.meta.dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const exists=(p)=>fs.existsSync(path.join(root,p));
const sha=(p)=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
const pages=['dashboard','orders','wishlist','addresses','rewards','wallet','returns','support','profile','categories','cart','notifications','club'];

test('Customer registry defines exactly the 13 approved Final 19 pages',()=>{
  assert.ok(exists('src/dashboard/customer-registry.js'));
  const source=read('src/dashboard/customer-registry.js');
  for(const id of pages) assert.match(source,new RegExp(`['\"]${id}['\"]`));
  assert.doesNotMatch(source,/seller|promoter|finance|warehouse|moderator|country_admin|super_admin/i);
});

test('Customer dashboard preserves uploaded Final 19 styles except the requested legacy toast retirement',()=>{
  const approved={
    'styles.css':'274d501fa785fcb299da0cc29cdda25b056d1b3f51b0ccab9de42898c61172d7',
    'role-workspaces.css':'1ef002c3f19472d36d94ddfa7de9ffa0e11e7ad8a4a42a6dc2fd4e4cfda0d9ef',
    'design-system.css':'91d65cc60b8f2739b1577da636ad49f51c298d5df5f07f9bca7d798402ba028a',
  };
  for(const [name,digest] of Object.entries(approved)){
    const frozen=`dashboard-preview/final19/${name}`,runtime=`public/approved-dashboard/${name}`;
    assert.equal(sha(frozen),digest,`${name}: original uploaded preview must stay frozen`);
    if(name==='role-workspaces.css'){
      assert.equal(sha(runtime),digest,`${name}: all role layout styles stay byte-identical`);
      continue;
    }
    assert.deepEqual(fs.readFileSync(path.join(root,runtime)),approvedAssetWithSharedFlash(name,fs.readFileSync(path.join(root,frozen))),`${name}: only the retired notification rules may differ`);
    assert.doesNotMatch(read(runtime),/^\.toast(?:\.show)?\s*\{/m);
  }
});

test('single Customer shell/partial exists and no demo runtime ships',()=>{
  for(const p of ['views/approved-dashboard.ejs','views/partials/customer-live-pages.ejs','public/approved-dashboard/customer-live.js']) assert.ok(exists(p),p);
  for(const p of ['public/dashboard/role-workspaces.js','public/dashboard/script.js','public/dashboard/enhancements.js']) assert.equal(exists(p),false,p);
});

test('customer actions require account permission and authenticated routing',()=>{
  assert.ok(exists('src/routes/dashboard.js'));
  const route=read('src/routes/dashboard.js');
  assert.match(route,/hasPermission\(request\.user,'account:read'\)/);
  assert.match(read('src/routes/approved-dashboard.js'),/Object\.entries\(CUSTOMER_ROUTES\)/);
  assert.match(route,/const gates=\[noStore,requireAuth,requireVerified,requireOnboarding,accountOnly\]/);
  assert.doesNotMatch(route,/\/dashboard\/:page\?/);
  assert.doesNotMatch(route,/seller|promoter|finance|warehouse|moderator|country_admin|super_admin/i);
  assert.match(read('src/app.js'),/app\.use\(dashboardRoutes\)/);
});

test('Customer page loader is page-scoped, not all-pages preload',()=>{
  assert.ok(exists('src/dashboard/customer-data.js'));
  const source=read('src/dashboard/customer-data.js');
  assert.match(source,/loadCustomerDashboardPage/);
  assert.match(source,/LOADERS\[pageId\]/);
  assert.doesNotMatch(source,/Promise\.all\(\s*Object\.values\(LOADERS\)/);
});

test('retired role compatibility views are removed and unsupported operational pages remain blocked in every environment',()=>{
  const wrappers=['seller-dashboard.ejs','promoter-dashboard.ejs','finance-dashboard.ejs','support-dashboard.ejs','warehouse-dashboard.ejs','moderator-dashboard.ejs','country-admin-dashboard.ejs','super-admin-dashboard.ejs'];
  for(const name of wrappers) assert.equal(exists(`views/${name}`),false);
  const router=read('src/routes/approved-dashboard.js');
  assert.match(router,/if \(workspace !== 'customer'\) throw new AppError\('This operational page is unavailable\.', 404, 'DASHBOARD_PAGE_NOT_FOUND'\)/);
  assert.doesNotMatch(router,/DASHBOARD_NOT_CONNECTED|env\.isProduction\s*\)/);
  assert.match(router,/workspaceForPage\(request\.user, page\)/);
});
