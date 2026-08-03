import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('local reset is explicit, development-only, stops MongoDB first and regenerates secrets', async()=>{
  const source=await read('scripts/reset-local.js');
  const pkg=JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['reset:local'],'node scripts/reset-local.js');
  assert.match(source,/NODE_ENV==='production'/);
  assert.match(source,/process\.argv\.includes\('--yes'\)/);
  assert.match(source,/scripts\/stop-local-mongo\.js/);
  assert.match(source,/\.classic-mart/);
  assert.match(source,/\.env\.example/);
  assert.match(source,/crypto\.randomBytes\(32\)/);
  assert.match(source,/ADMIN_PASSWORD/);
  assert.match(source,/MONGO_MODE=local/);
  assert.match(source,/MONGO_URI=/);
});
