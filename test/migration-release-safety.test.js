import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../scripts/migrate-production.js', import.meta.url), 'utf8');
const preflight = fs.readFileSync(new URL('../scripts/check-release-scripts.js', import.meta.url), 'utf8');
const checker = fs.readFileSync(new URL('../scripts/check-project.js', import.meta.url), 'utf8');

test('migration dry-run detects partially backfilled order item arrays', () => {
  assert.match(migration, /ordersNeedingLineBackfill:await Order\.countDocuments\(\{items:\{\$elemMatch:/);
  assert.doesNotMatch(migration, /'items\.linePublicId':\{\$exists:false\}/);
});

test('migration index creation failures block release certification', () => {
  assert.match(migration, /failures\.push\(`\$\{name\}: \$\{error\.message\}`\)/);
  assert.match(migration, /if\(indexResult\.failures\.length\)/);
  assert.match(migration, /process\.exitCode=2/);
});

test('release preflight permanently guards migration safety contracts', () => {
  assert.match(preflight, /partially backfilled order item arrays/);
  assert.match(preflight, /production index creation fails/);
});

test('project checker resolves current release artifacts dynamically', () => {
  assert.match(checker, /const releaseVersion = String\(pkg\.version/);
  assert.match(checker, /`RELEASE_NOTES_v\$\{releaseVersion\}\.md`/);
  assert.match(checker, /`docs\/SBOM_v\$\{releaseVersion\}\.cdx\.json`/);
});
