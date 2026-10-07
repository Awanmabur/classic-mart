import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const home = read('views/index.ejs');
const script = read('public/script.js');
const css = read('public/styles.css');

test('shop by category restores a right-arrow control for the category carousel', () => {
  assert.match(home, /class="section-next-button"[^>]*data-scroll-next="categoryRow"/);
  assert.match(home, /aria-label="Show more categories"/);
});

test('category row remains one horizontal carousel on desktop and phone', () => {
  assert.match(css, /\.category-row\s*\{[^}]*display:\s*grid[^}]*grid-auto-flow:\s*column[^}]*grid-auto-columns:/s);
  assert.match(css, /\.category-row\s*\{[^}]*overflow-x:\s*auto/s);
  assert.doesNotMatch(css, /#categories \.category-row\.categories-expanded\s*\{[^}]*(?:repeat\(|grid-auto-flow:\s*row)/s);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.category-row\s*\{[^}]*grid-auto-columns:/s);
});

test('all categories stay loaded and More jumps to the first additional category', () => {
  assert.match(script, /const visibleCategories = ordered;/);
  assert.doesNotMatch(script, /categoriesExpanded\s*\?/);
  assert.doesNotMatch(script, /categoriesExpanded\s*=\s*!categoriesExpanded/);
  assert.match(script, /const firstExtra = target\.children\[PRIMARY_CATEGORY_IDS\.length\]/);
  assert.match(script, /target\.scrollTo\(\{\s*left:\s*nextLeft[^}]*behavior:\s*'smooth'/s);
});

test('category right-arrow uses the shared section scrolling behavior for all currently loaded categories', () => {
  assert.match(script, /const sectionNext = event\.target\.closest\('\[data-scroll-next\]'\)/);
  assert.match(script, /target\.scrollWidth\s*-\s*target\.clientWidth/);
  assert.match(script, /target\.scrollTo\(\{\s*left:\s*nextLeft[^}]*behavior:\s*'smooth'/s);
});

test('public cache advances for the restored category carousel shell', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /classic-mart-public-v28/);
});
