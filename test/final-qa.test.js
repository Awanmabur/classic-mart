import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(file) { return fs.readFileSync(file, 'utf8'); }

test('PWA install surfaces load the manifest and install bootstrap', () => {
  for (const file of ['views/index.ejs', 'views/mobile-app.ejs', 'views/connected-apps.ejs']) {
    const source = read(file);
    assert.match(source, /manifest\.webmanifest/);
    assert.match(source, /\/pwa\.js/);
  }
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
  assert.match(view, /id="categoryCountBadge"/);
  assert.match(view, /id="homepageFilterCategories"/);
  assert.match(view, /data-dynamic-categories/);
  assert.match(script, /badge\.textContent\s*=\s*String\(categories\.length\)/);
  assert.match(script, /panel\.innerHTML\s*=\s*categories\.map/);
  assert.match(script, /filterCategories\.innerHTML/);
});

test('service worker cache namespace is advanced for the frontend data/functionality release', () => {
  assert.match(read('public/sw.js'), /classic-mart-public-v17/);
});
