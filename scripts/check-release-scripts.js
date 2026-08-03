import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
const pkg = JSON.parse(read('package.json'));
const version = String(pkg.version || '').trim();

const failures = [];
const requireFile = (rel) => { if (!exists(rel)) failures.push(`Missing release file: ${rel}`); };

for (const rel of [
  '.env.example',
  'scripts/check-project.js',
  'scripts/check-imports.js',
  'scripts/security-check.js',
  'scripts/audit-frontend.js',
  'scripts/audit-integration.js',
  'scripts/verify-mongo.js',
  `RELEASE_NOTES_v${version}.md`,
  `docs/SBOM_v${version}.cdx.json`,
]) requireFile(rel);

const checker = read('scripts/check-project.js');
if (!/function assertPattern\(pattern, helperName, rel\)/.test(checker)) {
  failures.push('check-project.js must validate requireMatch/forbidMatch pattern arguments before calling .test().');
}
if (/\b(?:requireMatch|forbidMatch)\(\s*['"][^'"]+['"]\s*,\s*['"]/.test(checker)) {
  failures.push('check-project.js contains a helper call whose pattern argument is a string instead of a RegExp.');
}

const requiredScripts = {
  'check:imports': 'scripts/check-imports.js',
  'security:check': 'scripts/security-check.js',
  'frontend:audit': 'scripts/audit-frontend.js',
  'audit:integration': 'scripts/audit-integration.js',
  'db:verify': 'scripts/verify-mongo.js',
  'reset:local': 'scripts/reset-local.js',
};
for (const [name, rel] of Object.entries(requiredScripts)) {
  if (!pkg.scripts?.[name]) failures.push(`package.json is missing required script: ${name}`);
  if (!exists(rel)) failures.push(`package script ${name} target is missing: ${rel}`);
}

for (const [name, command] of Object.entries(pkg.scripts || {})) {
  for (const match of String(command).matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
    if (!pkg.scripts?.[match[1]]) failures.push(`package script ${name} references missing npm script ${match[1]}.`);
  }
  for (const match of String(command).matchAll(/\bnode(?:\s+--[A-Za-z0-9:_=-]+)*\s+([^&|;\s]+\.js)\b/g)) {
    const target = match[1];
    if (!exists(target)) failures.push(`package script ${name} references missing Node entrypoint ${target}.`);
  }
}

for (const [name, expected] of Object.entries({
  'verify:local': ['db:setup','release:check'],
  'release:check': ['check','security:check','frontend:audit','test','db:verify','audit:integration'],
  'check': ['check:release-scripts','check:imports'],
})) {
  const command = String(pkg.scripts?.[name] || '');
  for (const token of expected) if (!command.includes(token)) failures.push(`package script ${name} is missing required gate ${token}.`);
}

if (exists(`docs/SBOM_v${version}.cdx.json`)) {
  try {
    const sbom = JSON.parse(read(`docs/SBOM_v${version}.cdx.json`));
    const componentVersion = String(sbom?.metadata?.component?.version || '');
    if (componentVersion !== version) failures.push(`SBOM component version ${componentVersion || '(blank)'} does not match package version ${version}.`);
  } catch (error) {
    failures.push(`Current SBOM is invalid JSON: ${error.message}`);
  }
}

const lock = JSON.parse(read('package-lock.json'));
const lockRootVersion = String(lock?.packages?.['']?.version || lock?.version || '');
if (lockRootVersion !== version) failures.push(`package-lock root version ${lockRootVersion || '(blank)'} does not match package version ${version}.`);

if (failures.length) {
  console.error('Release-script preflight failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release-script preflight passed for Classic Mart v${version}.`);
