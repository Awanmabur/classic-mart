import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('every storefront product receives the dynamic country promoter rate', () => {
  const country = read('src/models/CountrySetting.js');
  const growth = read('src/services/seller-growth.js');
  const publicRoutes = read('src/routes/public.js');
  const storefrontRoutes = read('src/routes/storefront.js');
  const seed = read('scripts/seed.js');

  assert.match(country, /promoterCommissionBps:\s*\{[^}]*default:\s*300/);
  assert.match(growth, /CountrySetting\.findOne\([^\n]+growth\.promoterCommissionBps/);
  assert.match(growth, /for \(const id of ids\)[\s\S]*promoterCommissionBps:\s*defaultCommissionBps/);
  assert.match(growth, /marketplacePromoterCampaignPublicId\(countryCode\)/);
  assert.match(growth, /campaignCommissionBps/);
  assert.doesNotMatch(growth, /promoterCommissionBps:\s*commissionBps/);
  assert.match(publicRoutes, /activeSponsoredProducts\(countryCode,\s*\(catalogue\.products \|\| \[\]\)\.map\(\(product\) => product\.id\)\)/);
  assert.match(storefrontRoutes, /activeSponsoredProducts\(countryCode,\s*\(catalogue\.products \|\| \[\]\)\.map\(\(product\) => product\.id\)\)/);
  assert.match(seed, /growth\.promoterCommissionBps[\s\S]*\$set:\s*\{\s*'growth\.promoterCommissionBps':\s*300/);
});

test('promoter badge is on the image corner for every homepage card renderer', () => {
  const script = read('public/script.js');
  const home = read('views/index.ejs');
  const styles = read('public/styles.css');

  for (const name of ['productCard', 'compactProductCard', 'recommendCard', 'miniProductCard']) {
    const start = script.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    const next = script.indexOf('\n  function ', start + 12);
    const body = script.slice(start, next === -1 ? start + 2200 : next);
    assert.match(body, /sponsoredBadge\(product\)/, `${name} must render the promoter badge`);
  }
  assert.match(home, /<div class="product-image">[\s\S]*class="promoter-badge"/);
  assert.match(styles, /\.promoter-badge\s*\{[\s\S]*position:\s*absolute[\s\S]*right:[^;]+;[\s\S]*bottom:[^;]+;/);
});

test('dynamic commission policy is snapshotted at attribution and drives actual earnings', () => {
  const campaign = read('src/models/Campaign.js');
  const touch = read('src/models/AttributionTouch.js');
  const promoters = read('src/services/promoters.js');

  assert.match(campaign, /scope:\{type:String,enum:\['seller','marketplace'\]/);
  assert.match(promoters, /ensureMarketplacePromoterCampaign/);
  assert.match(promoters, /Classic Mart Marketplace Promoter Program/);
  assert.match(touch, /commissionBps:\{type:Number,min:0,max:5000\}/);
  assert.match(touch, /policyVersion:\{type:String,maxlength:40/);
  assert.match(promoters, /commissionBps:\s*campaign\.commissionBps,\s*policyVersion:\s*campaign\.policyVersion/);
  assert.match(promoters, /touch\.commissionBps \?\? campaign\.commissionBps/);
  assert.match(promoters, /Math\.floor\(item\.lineTotalMinor \* commissionBps \/ 10000\)/);
  assert.match(promoters, /commissionBps, policyVersion, status: 'pending'/);
  assert.match(promoters, /campaign\.scope === 'marketplace'[\s\S]*promoterStoreIds\.has/);
});

test('old strike-through price stays out of cards and Top Brands wraps the full live directory', () => {
  const script = read('public/script.js');
  const catalogue = read('public/catalog-page.js');
  const home = read('views/index.ejs');
  const styles = read('public/styles.css');

  const cardArea = script.slice(script.indexOf('function productCard'), script.indexOf('function renderCategories'));
  assert.doesNotMatch(cardArea, /<del/);
  assert.doesNotMatch(catalogue, /<del/);
  assert.doesNotMatch(home.slice(home.indexOf('id="trendingGrid"'), home.indexOf('id="brandRow"')), /<del/);
  assert.match(script, /<del id="previewOldPrice"/);
  assert.match(home, /initialStorefront\.brands\.forEach\(brand/);
  assert.match(styles, /#brands \.brand-row\s*\{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*repeat\(auto-fit/);
  assert.match(styles, /#brands \[data-scroll-next="brandRow"\]\s*\{\s*display:\s*none/);
});
