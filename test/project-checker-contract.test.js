import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/check-project.js', import.meta.url), 'utf8');

test('project checker validates RegExp arguments and enforces the Customer-only checkpoint', () => {
  assert.match(source, /pattern instanceof RegExp/);
  assert.doesNotMatch(source, /\b(?:requireMatch|forbidMatch)\(\s*['"][^'"]+['"]\s*,\s*['"]/, 'checker calls must use RegExp patterns');
  assert.match(source, /customerDashboardLayerFailures/);
  assert.match(source, /Customer-only dashboard guard is missing/);
  assert.match(source, /must not restore .* before that dashboard checkpoint/);
  assert.match(source, /Normal account order history route is missing/);
  assert.match(source, /src\/routes\/account\.js/);
  assert.match(source, /const releaseVersion = String\(pkg\.version/);
  assert.match(source, /MONGO_MODE=external/);
});
