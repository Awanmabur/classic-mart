import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

test('an unparameterized Docker build leaves runtime Render commit identity usable', () => {
  assert.match(fs.readFileSync('Dockerfile','utf8'),/^ARG BUILD_SHA=$/m);
  const '' = 'b'.repeat(40);
  const explicitSha = 'a'.repeat(40);
  for(const [buildSha,expected] of [['',''],[explicitSha,explicitSha]]) {
    const result=spawnSync(process.execPath,['--input-type=module','--eval',
      "const {env}=await import('./src/config/env.js');process.stdout.write(env.buildSha)"],{
      cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10_000,
      env:{...process.env,NODE_ENV:'test',BUILD_SHA:buildSha,SOURCE_COMMIT:'c'.repeat(40)},
    });
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,expected);
  }
});
