import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = read('public/styles.css');
const script = read('public/script.js');
const sharedShell = read('public/shared-shell.js');
const home = read('views/index.ejs');

test('mobile bottom navigation uses a unique elevated seller signup action in the center', () => {
  for (const source of [script, sharedShell]) {
    assert.match(source, /\/signup\?role=seller/);
    assert.match(source, /plus\.svg/);
    assert.match(source, /\bSell\b/);
    assert.match(source, /mobile-bottom-nav__sell/);
  }
  assert.match(css, /\.mobile-bottom-nav a\.mobile-bottom-nav__sell\s*\{[^}]*background:\s*var\(--orange\)[^}]*transform:\s*translateY\(-/s);
  assert.match(css, /\.mobile-bottom-nav a\.mobile-bottom-nav__sell img\s*\{[^}]*filter:\s*brightness\(0\)\s*invert\(1\)/s);
});

test('mobile hero begins with the same compact seven-pixel rhythm used below the hero', () => {
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.header-main\s*\{[^}]*padding:\s*8px\s+0\s+0[^}]*\}/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.hero-grid\s*\{[^}]*margin-top:\s*7px/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.benefits\s*\{[^}]*margin-top:\s*7px/);
});

test('homepage category More control is a jump shortcut, not a visibility gate', () => {
  assert.match(home, /data-category-more/);
  assert.match(home, /data-category-more-label>More</);
  assert.match(script, /const visibleCategories = ordered;/);
  assert.doesNotMatch(script, /categoriesExpanded\s*\?/);
  assert.match(script, /const firstExtra = target\.children\[PRIMARY_CATEGORY_IDS\.length\]/);
});

test('public service worker advances its cache namespace for the v2.13.44 shell change', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /classic-mart-public-v28/);
});
