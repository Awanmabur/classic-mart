import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyFiles = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'scripts/local-infra.js',
  'scripts/ensure-mongo-replica.js',
];

const removed = [];
for (const relative of legacyFiles) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) continue;
  fs.rmSync(target, { force: true });
  removed.push(relative);
}

if (removed.length) console.log(`Removed obsolete Docker-local infrastructure files: ${removed.join(', ')}`);
else console.log('No obsolete Docker-local infrastructure files found.');
