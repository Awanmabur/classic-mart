import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/check-project.js', import.meta.url), 'utf8');

test('project checker validates RegExp helper arguments and keeps procurement regressions separate', () => {
  assert.match(source, /function assertPattern\(pattern, helperName, rel\)/, 'Checker helpers must validate their pattern argument before calling .test().');
  assert.doesNotMatch(
    source,
    /\b(?:requireMatch|forbidMatch)\(\s*['"][^'"]+['"]\s*,\s*['"]/, 
    'A checker call must never pass a filename/string where a RegExp pattern is required.',
  );
  assert.match(source, /requireMatch\('test\/business-seller-growth\.test\.js',\/business buyer domain covers\//, 'Business/seller-growth contract check is missing.');
  assert.match(source, /requireMatch\('test\/procurement-core\.test\.js',\/remainingProcurementItems\//, 'Procurement-core contract check is missing.');
});
