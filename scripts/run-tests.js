import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
if (process.argv.includes('--coverage')) nodeArgs.push('--experimental-test-coverage');
const result = spawnSync(process.execPath, [...nodeArgs, ...files], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
