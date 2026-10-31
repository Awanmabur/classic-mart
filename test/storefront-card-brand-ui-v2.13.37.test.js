import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function block(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Could not isolate ${start}`);
  return source.slice(from, to);
}

test('product cards show only the live selling price while preview retains compare-at pricing', () => {
  const home = read('views/index.ejs');
  const script = read('public/script.js');
  const catalogue = read('public/catalog-page.js');
  const wishlist = read('public/wishlist.js');
  const compare = read('public/compare.js');
  const preview = read('public/product-preview.js');

  const homeCard = block(script, 'function productCard(product)', 'function compactProductCard(product)');
  const dealCard = block(script, 'function compactProductCard(product)', 'function recommendCard(product)');
  const catalogueCard = block(catalogue, 'function productCard(product)', 'function renderProducts()');

  assert.doesNotMatch(home, /<del>/);
  assert.doesNotMatch(homeCard, /<del>/);
  assert.doesNotMatch(dealCard, /<del>/);
  assert.doesNotMatch(catalogueCard, /<del>/);
  assert.doesNotMatch(wishlist, /<del>/);
  assert.doesNotMatch(compare, /<del>/);

  assert.match(script, /<del id="previewOldPrice"/);
  assert.match(preview, /<del id="previewOldPrice"/);
  assert.match(catalogueCard, /<b>-\$\{discount\}%<\/b>/);
  assert.match(dealCard, /deal-badge/);
});

test('review score and count remain beside the current price on desktop and phone cards', () => {
  const styles = read('public/styles.css');
  const marketplace = read('public/marketplace-pages.css');
  const script = read('public/script.js');
  const catalogue = read('public/catalog-page.js');

  assert.match(styles, /v2\.13\.39 final card alignment[\s\S]*\.product-meta-row\s*\{[^}]*justify-content:\s*space-between\s*!important/);
  assert.match(styles, /v2\.13\.39 final card alignment[\s\S]*\.product-meta-row \.rating span:last-child \{[^}]*display:\s*inline\s*!important/);
  assert.match(marketplace, /v2\.13\.39 catalogue-card commerce alignment[\s\S]*\.catalog-card-commerce\s*\{[^}]*justify-content:\s*space-between\s*!important/);
  assert.match(marketplace, /v2\.13\.39 catalogue-card commerce alignment[\s\S]*\.catalog-card-rating small \{[^}]*display:\s*inline\s*!important/);
  assert.match(script, /<div class="price"><strong>\$\{money\(product\.price, product\.currency\)\}<\/strong><\/div>\s*<div class="rating"/);
  assert.match(catalogue, /catalog-card-price[\s\S]*catalog-card-rating/);
});

test('Top Brands uses full-country published brand metrics without unbounding normal product hydration', () => {
  const storefront = read('src/services/storefront.js');
  const home = read('views/index.ejs');
  const script = read('public/script.js');

  const load = block(storefront, 'async function loadStorefront(country)', 'export async function getStorefront(country)');
  const hydrate = block(storefront, 'async function hydrateProducts(products, country', 'async function loadStorefront(country)');

  assert.match(load, /Product\.find\(\{[\s\S]*\.limit\(MAX_PRODUCTS\)/);
  assert.match(load, /Product\.aggregate\(\[[\s\S]*brandId:[\s\S]*\$group:[\s\S]*count:/);
  assert.match(load, /hydrateProducts\(products, country, \{ brandMetrics \}\)/);
  assert.doesNotMatch(hydrate, /Product\.aggregate\(\[/);
  assert.match(storefront, /brandMetrics\.map\(\(item\) => \[key\(item\._id\), Number\(item\.count \|\| 0\)\]\)/);
  assert.doesNotMatch(storefront, /\.filter\(\(brand\) => brand\.count > 0\)/);
  assert.match(storefront, /\.sort\(\(a, b\) => b\.count - a\.count \|\| a\.name\.localeCompare\(b\.name\)\)/);

  assert.match(home, /initialStorefront\?\.brands\?\.length/);
  assert.match(home, /initialStorefront\.brands\.forEach\(brand/);
  assert.doesNotMatch(home, /data-brand="Samsung"/);
  assert.match(script, /function renderBrands\(\)/);
  assert.match(script, /brands\.map\(\(brand\)/);
});
