import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('normal command surface no longer exposes destructive local reset or local Mongo bootstrap', async()=>{
  const pkg=JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['reset:local'], undefined);
  assert.equal(pkg.scripts['db:local'], undefined);
  assert.equal(pkg.scripts['db:local:stop'], undefined);
  assert.equal(pkg.scripts.dev, 'node src/server.js');
  assert.equal(pkg.scripts['dev:watch'], 'node --watch src/server.js');
  assert.equal(pkg.scripts['db:setup'], 'npm run setup:external');
});

test('clean app package excludes local reset and local Mongo tooling entirely', async()=>{
  const builder=await read('scripts/build-clean-app-release.js');
  assert.match(builder,/scripts\/reset-local\.js/);
  assert.match(builder,/scripts\/ensure-local-mongo\.js/);
  assert.match(builder,/scripts\/stop-local-mongo\.js/);
  assert.match(builder,/src\/core\/local-mongo\.js/);
});
