import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? files(relative) : /\.(?:js|mjs|cjs)$/.test(entry.name) ? [relative] : [];
  });
}
const sources = ['src', 'scripts', 'public', 'test'].flatMap(files).sort();
let failed = 0;
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(`${source}\n${result.stderr || result.error?.message || 'Syntax check failed.'}\n`);
  }
}
if (failed) { process.stderr.write(`JavaScript syntax check failed for ${failed} file(s).\n`); process.exitCode = 1; }
else process.stdout.write(`JavaScript syntax check passed (${sources.length} files).\n`);
