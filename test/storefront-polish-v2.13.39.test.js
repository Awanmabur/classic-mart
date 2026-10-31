import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('homepage and catalogue put readable review evidence opposite the live price', () => {
  const styles = read('public/styles.css');
  const marketplace = read('public/marketplace-pages.css');
  assert.match(styles, /v2\.13\.39 final card alignment[\s\S]*justify-content:\s*space-between\s*!important/);
  assert.match(styles, /\.product-meta-row \.rating \{[^}]*font-size:\s*12px\s*!important/);
  assert.match(styles, /\.mini-card-footer \{[^}]*display:\s*flex\s*!important[^}]*justify-content:\s*space-between/);
  assert.match(marketplace, /v2\.13\.39 catalogue-card commerce alignment[\s\S]*justify-content:\s*space-between\s*!important/);
  assert.match(marketplace, /\.catalog-card-rating \{[^}]*font-size:\s*12px\s*!important/);
});

test('promotion badges display dynamic commission money, not a static percent', () => {
  const main = read('public/script.js');
  const catalogue = read('public/catalog-page.js');
  const home = read('views/index.ejs');
  assert.match(main, /price \* bps \/ 10000/);
  assert.match(main, /Prom \$\{escapeHtml\(amount\)\}/);
  assert.match(catalogue, /const amount = Math\.max\(0, Number\(product\?\.price\) \|\| 0\) \* bps \/ 10000/);
  assert.match(catalogue, /Prom \$\{escapeHtml\(earning\)\}/);
  assert.match(home, /promAmount = Number\(product\.price \|\| 0\) \* Number\(product\.promoterCommissionBps \|\| 0\) \/ 10000/);
  assert.doesNotMatch(main, /Prom \$\{[^}]*percent[^}]*\}%/);
  assert.doesNotMatch(catalogue, /Prom \$\{[^}]*percent[^}]*\}%/);
});

test('Top Brands returns every approved country brand while keeping product metrics for ranking', () => {
  const storefront = read('src/services/storefront.js');
  assert.match(storefront, /const publicBrands = brands[\s\S]*\.map\(\(brand\) => \(\{/);
  assert.doesNotMatch(storefront, /\.filter\(\(brand\) => brand\.count > 0\)/);
  assert.match(storefront, /\.sort\(\(a, b\) => b\.count - a\.count \|\| a\.name\.localeCompare\(b\.name\)\)/);
});

test('Daily Deals has a live per-second countdown and only lists genuine discounts', () => {
  const home = read('views/index.ejs');
  const main = read('public/script.js');
  assert.match(home, /id="dealHours">00/);
  assert.match(home, /id="dealMinutes">00/);
  assert.match(home, /id="dealSeconds">00/);
  assert.match(main, /setInterval\(updateDailyDealCountdown, 1000\)/);
  assert.match(main, /startDailyDealCountdown\(\)/);
  assert.match(main, /\.filter\(\(product\) => Number\(product\.oldPrice \|\| 0\) > Number\(product\.price \|\| 0\)\)/);
});

test('initial catalogue fetches validated real photos and stores processed media directly in R2', () => {
  const mediaUrl = read('src/services/product-media-url.js');
  const seed = read('scripts/seed-initial-catalogue.js');
  const catalogue = read('src/config/initial-catalogue.js');
  const pkg = JSON.parse(read('package.json'));
  assert.match(catalogue, /images\.pexels\.com/);
  assert.match(seed, /SOURCE_HOST = 'images\.pexels\.com'/);
  assert.match(seed, /content-type/);
  assert.match(seed, /MAX_SOURCE_BYTES/);
  assert.match(seed, /putMediaObject/);
  assert.doesNotMatch(seed, /fs\.writeFile|env\.uploadDir/);
  assert.match(mediaUrl, /env\.mediaStorageDriver !== 'r2'/);
  assert.equal(pkg.scripts['seed:initial'], 'node scripts/seed-initial-catalogue.js');
  assert.equal(pkg.scripts['db:setup'], 'npm run setup:external');
});

test('footer and related-product cards have readable, compact final styling', () => {
  const styles = read('public/styles.css');
  const storefrontPages = read('public/storefront-pages.css');
  const main = read('public/script.js');
  const preview = read('public/product-preview.js');
  assert.match(styles, /site-footer \.footer-about p[\s\S]*font-size:\s*12\.5px/);
  assert.match(styles, /site-footer \.footer-grid h3 \{ font-size: 14px; \}/);
  assert.match(storefrontPages, /v2\.13\.39 clean related-product cards/);
  assert.match(storefrontPages, /\.preview-related-commerce[\s\S]*justify-content:\s*space-between/);
  assert.doesNotMatch(main, /preview-related-copy[^`]*recommendationExplanation/);
  assert.doesNotMatch(preview, /preview-related-copy[^`]*recommendationExplanation/);
});
