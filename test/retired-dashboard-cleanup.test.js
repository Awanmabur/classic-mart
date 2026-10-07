import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pageWorkspace } from '../src/dashboard/registry.js';

const root=path.resolve(import.meta.dirname,'..');
test('retired dashboard layouts and assets cannot be served or revived by template links',()=>{
  for(const entry of ['public/dashboard','public/dashboard-v19','public/account.css','views/partials/account-top.ejs','views/partials/account-nav.ejs','src/middleware/unified-dashboard.js','views/catalog-workspace.ejs','views/moderation-workspace.ejs','views/business-workspace.ejs','views/privacy-workspace.ejs','views/returns-workspace.ejs','views/seller-growth.ejs','views/seller-campaigns.ejs','views/promoter-admin.ejs','views/developer-portal.ejs','views/dashboard.ejs','views/admin.ejs']) assert.equal(fs.existsSync(path.join(root,entry)),false,entry);
  for(const file of fs.readdirSync(path.join(root,'views'),{recursive:true}).filter(name=>name.endsWith('.ejs'))) {
    const source=fs.readFileSync(path.join(root,'views',file),'utf8');
    assert.doesNotMatch(source,/\/account\.css|\/dashboard-v19\/|\/dashboard\/(styles|design-system|role-workspaces)\.css|partials\/account-(top|nav)/,file);
  }
  assert.ok(fs.existsSync(path.join(root,'views/approved-dashboard.ejs')));
});

test('literal server render targets all resolve after retired templates are removed',()=>{
  for(const file of fs.readdirSync(path.join(root,'src/routes')).filter(name=>name.endsWith('.js'))) {
    const source=fs.readFileSync(path.join(root,'src/routes',file),'utf8');
    for(const match of source.matchAll(/render\('approved-dashboard',\s*\{\s*workspace:\s*'([^']+)',\s*initialPage:\s*'([^']+)'/g)) assert.equal(pageWorkspace(match[2]),match[1],`${file}: ${match[2]}`);
    for(const match of source.matchAll(/\.render\(['"]([^'"]+)['"]/g)) assert.ok(fs.existsSync(path.join(root,'views',match[1]+'.ejs')),`${file}: ${match[1]}`);
  }
});

test('retired asset URLs return 404 without redirecting to login',{skip:!process.env.CLASSIC_MART_LIVE_BASE_URL},async()=>{
  const base=process.env.CLASSIC_MART_LIVE_BASE_URL;
  assert.equal(new URL(base).hostname,'127.0.0.1');
  for(const asset of ['/account.css','/dashboard/styles.css','/dashboard/design-system.css','/dashboard-v19/styles.css']) {
    const response=await fetch(base+asset,{redirect:'manual'});
    assert.equal(response.status,404,asset);
    assert.equal(response.headers.get('location'),null);
  }
});
