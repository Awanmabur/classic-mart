import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const publicRoutes = readFileSync(new URL('../src/routes/public.js', import.meta.url), 'utf8');
const appTest = readFileSync(new URL('./app.test.js', import.meta.url), 'utf8');

test('profile aliases preserve seller slugs and promoter IDs', () => {
  assert.match(publicRoutes, /router\.get\('\/sellers\/profile'[\s\S]*request\.query\.slug[\s\S]*`\/sellers\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(publicRoutes, /router\.get\('\/promoters\/profile'[\s\S]*request\.query\.id[\s\S]*`\/promoters\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(publicRoutes, /router\.get\('\/seller-profile\.html'[\s\S]*request\.query\.slug[\s\S]*`\/sellers\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(publicRoutes, /router\.get\('\/promoter-profile\.html'[\s\S]*request\.query\.id[\s\S]*`\/promoters\/\$\{encodeURIComponent\(id\)\}`/);
});

test('public-page sweep treats profile aliases as redirects and dynamic profiles as pages', () => {
  const publicRoutesBlock = appTest.match(/const routes = \[([\s\S]*?)\];/)?.[1] || '';
  assert.doesNotMatch(publicRoutesBlock, /['"]\/promoters\/profile['"]/);
  assert.match(appTest, /get\('\/promoters\/profile'\)\.expect\(301\)\.expect\('location', '\/promoters'\)/);
  assert.match(appTest, /get\('\/promoters\/verified-promoter'\)\.expect\(200\)/);
  assert.match(appTest, /get\('\/sellers\/verified-store'\)\.expect\(200\)/);
});
