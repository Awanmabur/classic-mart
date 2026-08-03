import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(file)=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

test('role workspaces share a real responsive operational shell',()=>{
  const css=read('public/server-ui.css');
  for(const selector of ['.catalog-workspace {','.catalog-topbar {','.catalog-actions {','.catalog-page-head {','.catalog-form {','.table-wrap {','.status-chip {','.secondary-button {','.catalogue-table-wrap {','.catalogue-table-actions {']){
    assert.match(css,new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  }
  assert.match(css,/\.table-wrap\s+table[\s\S]*min-width:\s*680px/);
  assert.match(css,/@media \(max-width: 760px\)[\s\S]*\.catalog-form \{ grid-template-columns: 1fr; \}/);
});

test('all server rendered views receive locale-aware money formatting',()=>{
  const view=read('src/middleware/view.js');
  assert.match(view,/formatMoney\(value, currency/);
  assert.match(view,/new Set\(\['UGX', 'RWF', 'JPY', 'KRW'\]\)/);
  assert.match(view,/style: 'currency'/);
});

test('money-facing workspaces display financial values through formatMoney',()=>{
  const files=['views/payout-workspace.ejs','views/money-workspace.ejs','views/returns-workspace.ejs','views/promoter-workspace.ejs','views/business-workspace.ejs','views/seller-growth.ejs'];
  for(const file of files) assert.match(read(file),/formatMoney\(/,`${file} should render human-readable currency`);
});
