import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');

test('PlatformGrant validation middleware uses promise/throw semantics compatible with Mongoose 9',()=>{
  const model=read('src/models/PlatformGrant.js');
  assert.match(model,/schema\.pre\('validate',function\(\)\{/);
  assert.doesNotMatch(model,/pre\('validate',function\(next\)/);
  assert.doesNotMatch(model,/\bnext\(/);
  assert.match(model,/throw new Error\('Platform grant expiry must be after its start time\.'\)/);
  assert.match(model,/throw new Error\('Super Admin grant must use global operational scope\.'\)/);
  assert.match(model,/throw new Error\('Only Super Admin may receive global operational scope\.'\)/);
});

test('Buying details renders exactly two buyer-facing cards in both product preview paths',()=>{
  for(const path of ['public/product-preview.js','public/script.js']){
    const js=read(path);
    const section=js.match(/<section class="preview-panel preview-buying-details"[\s\S]*?<\/section>/)?.[0] || '';
    assert.match(section,/preview-buying-cards/);
    assert.equal((section.match(/<article class="preview-buying-card"/g)||[]).length,2,`${path} must render exactly two buying-detail cards`);
    assert.match(section,/Delivery &amp; payment/);
    assert.match(section,/Listing &amp; seller/);
  }
  const css=read('public/styles.css');
  assert.match(css,/\.preview-buying-cards\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:640px\)\{\.preview-buying-cards\{grid-template-columns:1fr\}/);
});
