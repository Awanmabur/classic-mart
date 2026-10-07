import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(file) { return fs.readFileSync(file, 'utf8'); }

test('PWA install surfaces load the manifest and install bootstrap', () => {
  for (const file of ['views/index.ejs', 'views/mobile-app.ejs']) {
    const source = read(file);
    assert.match(source, /manifest\.webmanifest/);
    assert.match(source, /\/pwa\.js/);
  }
  assert.match(read('src/app.js'), /manifest\.webmanifest/);
  assert.match(read('src/app.js'), /\/pwa\.js/);
  assert.match(read('views/connected-apps.ejs'), /data-pwa-install/);
});

test('internal delivery-location controls deep-link to the existing server-backed workflow', () => {
  const shell = read('public/shared-shell.js');
  const home = read('public/script.js');
  assert.match(shell, /locationModal:\s*'\/\?location=1#top'/);
  assert.match(home, /params\.get\('location'\)\s*===\s*'1'/);
  assert.match(home, /openModal\('locationModal'\)/);
  assert.match(home, /params\.delete\('location'\)/);
});

test('homepage category navigation and filters are database-driven after hydration', () => {
  const view = read('views/index.ejs');
  const script = read('public/script.js');
  assert.doesNotMatch(view, /tiny-badge">9</);
  assert.match(read('views/partials/storefront-header.ejs'), /href="\/categories"/);
  assert.match(view, /id="homepageFilterCategories"/);
  assert.match(view, /data-dynamic-categories/);
  assert.match(script, /badge\.textContent\s*=\s*String\(categories\.length\)/);
  assert.match(script, /const primaryCategories = orderedCategories\(\)\.slice\(0, PRIMARY_CATEGORY_IDS\.length\)/);
  assert.match(script, /panel\.innerHTML\s*=\s*primaryCategories\.map/);
  assert.match(script, /filterCategories\.innerHTML/);
});

test('service worker cache namespace is advanced for the frontend data/functionality release', () => {
  assert.match(read('public/sw.js'), /classic-mart-public-v26/);
});
