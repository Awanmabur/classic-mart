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

test('Customer dashboard uses the exact uploaded Final 19 styles',()=>{
  assert.equal(sha('public/dashboard/styles.css'),'274d501fa785fcb299da0cc29cdda25b056d1b3f51b0ccab9de42898c61172d7');
  assert.equal(sha('public/dashboard/role-workspaces.css'),'1ef002c3f19472d36d94ddfa7de9ffa0e11e7ad8a4a42a6dc2fd4e4cfda0d9ef');
  assert.equal(sha('public/dashboard/design-system.css'),'91d65cc60b8f2739b1577da636ad49f51c298d5df5f07f9bca7d798402ba028a');
});

test('single Customer shell/partial exists and no demo runtime ships',()=>{
  for(const p of ['views/customer-dashboard.ejs','views/partials/customer-live-pages.ejs','public/approved-dashboard/customer-live.js']) assert.ok(exists(p),p);
  for(const p of ['public/dashboard/role-workspaces.js','public/dashboard/script.js','public/dashboard/enhancements.js']) assert.equal(exists(p),false,p);
});

test('customer actions require account permission and authenticated routing',()=>{
  assert.ok(exists('src/routes/dashboard.js'));
  const route=read('src/routes/dashboard.js');
  assert.match(route,/hasPermission\(request\.user,'account:read'\)/);
  assert.match(route,/router\.get\(['"]\/dashboard\/:page['"]/);
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

test('role compatibility views use the approved shell and unfinished operations are blocked in production',()=>{
  const wrappers=['seller-dashboard.ejs','promoter-dashboard.ejs','finance-dashboard.ejs','support-dashboard.ejs','warehouse-dashboard.ejs','moderator-dashboard.ejs','country-admin-dashboard.ejs','super-admin-dashboard.ejs'];
  for(const name of wrappers) assert.match(read(`views/${name}`),/^<%- include\('approved-dashboard',/);
  assert.match(read('src/routes/approved-dashboard.js'),/workspace !== 'customer' && env.isProduction/);
  assert.match(read('src/routes/approved-dashboard.js'),/503, 'DASHBOARD_NOT_CONNECTED'/);
});
