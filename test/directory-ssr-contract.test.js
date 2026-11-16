import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('public directories emit a safe JSON snapshot without user-specific state', () => {
  const routes = source('src/routes/public.js');
  assert.match(routes, /jsonForHtml\(\{ people: result\.items, page \}\)/);
  assert.match(routes, /jsonForHtml\(\{ people: publicPeople, page \}\)/);
  assert.match(routes, /request\.user \? null : jsonForHtml/);
  assert.match(routes, /\(\{ userMongoId, earnedMinor, \.\.\.person \}\)/);
  assert.match(routes, /setSeo\(request, response/);
  for (const page of ['views/sellers.ejs', 'views/promoters.ejs']) {
    const template = source(page);
    assert.match(template, /id="initialPeopleData" type="application\/json"/);
    assert.match(template, /<%- initialPeopleJson %>/);
  }
});

test('browser uses guest snapshots but fetches personal followed state when missing', () => {
  const js = source('public/people-page.js');
  assert.match(js, /document\.getElementById\('initialPeopleData'\)/);
  assert.match(js, /Array\.isArray\(parsed\.people\)/);
  assert.match(js, /if \(initialSnapshot\)/);
  assert.match(js, /if \(initialQuery\) render\(\)/);
  assert.match(js, /else \{\s*\/\/ Signed-in people need their personalized follow state and CSRF token\.\s*loadPeople\(\);/);
});
