import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && ent.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const files = walk(path.resolve('test')).sort();
if (!files.length) {
  console.error('No canonical tests found under test/.');
  process.exit(1);
}
const nodeArgs = ['--test', '--test-reporter=spec'];
// Live fixtures create and drop isolated databases on the same MongoDB server.
// Serialize those files so index construction and teardown cannot interfere.
if (process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI) {
  nodeArgs.push('--test-concurrency=1', '--import', fileURLToPath(new URL('./live-test-model-lifecycle.js', import.meta.url)));
}
if (process.argv.includes('--coverage')) nodeArgs.push('--experimental-test-coverage');
const result = spawnSync(process.execPath, [...nodeArgs, ...files], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
