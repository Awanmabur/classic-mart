import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = read('public/styles.css');
const storefrontCss = read('public/storefront-pages.css');
const marketplaceCss = read('public/marketplace-pages.css');
const script = read('public/script.js');
const sharedShell = read('public/shared-shell.js');
const seed = read('scripts/seed.js');
const marketplaceReference = read('src/config/marketplace-reference.js');
const publicViews = ['index','categories','search','products','wishlist','cart','about','help'].map((name) => read(`views/${name}.ejs`)).join('\n');

const oldCategoryKeys = [
  'electronics', 'fashion', 'home-living', 'beauty', 'sports-fitness',
  'automotive', 'books', 'groceries', 'baby', 'office',
];

test('all storefront product media uses the same filled image treatment', () => {
  assert.match(css, /\.product-image\s*>\s*img[\s\S]*?object-fit:\s*cover/);
  assert.match(css, /\.compact-image\s*>\s*img[\s\S]*?object-fit:\s*cover/);
  assert.match(css, /\.recommend-image\s*>\s*img[\s\S]*?object-fit:\s*cover/);
  assert.match(css, /\.mini-product-image\s*>\s*img[\s\S]*?object-fit:\s*cover/);
  assert.match(css, /\.gallery-main\s+img[\s\S]*?object-fit:\s*cover/);
  assert.match(css, /\.gallery-thumb\s+img[\s\S]*?object-fit:\s*cover/);
  assert.match(marketplaceCss, /\.catalog-product-image\s*>?\s*img[\s\S]*?object-fit:\s*cover/);
  assert.match(storefrontCss, /\.preview-related-image\s+img[\s\S]*?object-fit:\s*cover/);
});

test('mobile keeps search visible, removes category nav line, and uses capsule bottom navigation', () => {
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.nav-shell\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.header-main \.search-bar,[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
  assert.match(css, /\.header-main \.search-bar,[\s\S]*?opacity:\s*1\s*!important/);
  assert.match(css, /\.header-main \.search-bar,[\s\S]*?visibility:\s*visible\s*!important/);
  assert.match(css, /\.mobile-search-button\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(css, /\.mobile-bottom-nav\s*\{[\s\S]*?border-radius:\s*999px/);
  assert.match(css, /\.mobile-bottom-nav\.is-scrolling/);
  assert.match(script, /function\s+ensureMobileBottomNav\s*\(/);
  for (const href of ['/', '/categories', '/signup?role=seller', '/wishlist', '/account/profile']) {
    assert.ok(script.includes(`['${href}'`) || script.includes(`\"${href}\"`), `bottom nav missing ${href}`);
  }
  assert.match(script, /classList\.add\(['"]is-scrolling['"]\)/);
  assert.match(script, /setTimeout\([\s\S]*?classList\.remove\(['"]is-scrolling['"]\)/);
});


test('shared public pages use the same persistent mobile search and capsule navigation', () => {
  assert.doesNotMatch(sharedShell, /mobileSearchButton\?\.addEventListener\(['"]click['"]/);
  assert.doesNotMatch(publicViews, /id="mobileSearchButton"/);
  assert.match(sharedShell, /function\s+ensureMobileBottomNav\s*\(/);
  assert.match(sharedShell, /\/categories/);
  assert.match(sharedShell, /\/signup\?role=seller/);
  assert.match(sharedShell, /\/wishlist/);
  assert.match(sharedShell, /\/account\/profile/);
  assert.match(sharedShell, /category\.id\s*\|\|\s*category\.slug/);
});

test('existing ten categories stay first while every category remains continuously swipeable', () => {
  for (const key of oldCategoryKeys) assert.ok(script.includes(`'${key}'`) || script.includes(`"${key}"`), `primary category missing ${key}`);
  assert.match(script, /PRIMARY_CATEGORY_IDS/);
  assert.match(script, /const visibleCategories = ordered/);
  assert.match(script, /data-category-more/);
  assert.match(script, /firstExtra[\s\S]*scrollTo/);
  assert.doesNotMatch(script, /categoriesExpanded/);
});

test('shared marketplace taxonomy retains original categories and supplies the expanded catalogue', () => {
  for (const key of oldCategoryKeys) assert.ok(marketplaceReference.includes(`key: '${key}'`), `marketplace taxonomy lost ${key}`);
  const categoryKeys = [...marketplaceReference.matchAll(/\bkey:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]);
  assert.ok(categoryKeys.length >= 25, `expected at least 25 marketplace categories, got ${categoryKeys.length}`);
  assert.match(seed, /const categories = marketplaceCategories/);
});

test('footer social controls are materially larger than the old 27px/11px treatment', () => {
  assert.match(css, /\.site-footer \.socials a,\s*\.site-footer \.socials\s*>\s*span\s*\{[^}]*width:\s*(?:3[4-9]|[4-9]\d)px[^}]*height:\s*(?:3[4-9]|[4-9]\d)px/);
  assert.match(css, /\.site-footer \.socials img\s*\{[^}]*width:\s*(?:1[6-9]|[2-9]\d)px[^}]*height:\s*(?:1[6-9]|[2-9]\d)px/);
});
