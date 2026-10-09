import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('promoter commission money is sourced from the live country marketplace rule', () => {
  const growth = read('src/services/seller-growth.js');
  const publicRoutes = read('src/routes/public.js');
  const storefrontRoutes = read('src/routes/storefront.js');
  const home = read('views/index.ejs');
  const script = read('public/script.js');
  const catalogue = read('public/catalog-page.js');

  assert.match(growth, /CountrySetting\.findOne/);
  assert.match(growth, /growth\.promoterCommissionBps/);
  assert.match(growth, /promoterCommissionBps: defaultCommissionBps/);
  assert.match(publicRoutes, /promoterCommissionBps: Number\(offer\.promoterCommissionBps\)/);
  assert.match(storefrontRoutes, /decoratePromotedProduct/);
  assert.match(home, /product\.promoterCommissionBps/);
  assert.match(script, /Prom \$\{escapeHtml\(amount\)\}/);
  assert.match(catalogue, /catalog-promoter-badge/);
  assert.doesNotMatch(script, /Prom \$\{escapeHtml\(percent\)\}|Promo amount is 3%|Prom amount is 3%|\*\s*0\.03/);
});

test('approved phone arrows, coloured search tools and brand wordmarks stay in front', () => {
  const script = read('public/script.js');
  const styles = read('public/styles.css');

  assert.match(script, /function approvedBrandMark/);
  assert.match(script, /brand-samsung/);
  assert.match(script, /qsa\('\.mobile-more-wrap'\)\.forEach/);
  assert.doesNotMatch(script, /wrap\.innerHTML = `<button class="mobile-section-more"/);
  assert.match(styles, /data-image-search.*color: var\(--orange\)/s);
  assert.match(styles, /data-voice-search.*color: #1165df/s);
  assert.match(styles, /#brands \.brand-row[\s\S]*z-index: 7/);
  assert.match(styles, /section-heading-actions \.section-next-button[\s\S]*position: static !important/);
  assert.match(styles, /\.mobile-more-wrap,[\s\S]*display: none !important/);
});

test('product preview keeps one live price and the approved action labels', () => {
  for (const file of ['public/script.js', 'public/product-preview.js']) {
    const source = read(file);
    assert.match(source, /product\.price \* quantity/);
    assert.match(source, /'Add to Cart'/);
    assert.match(source, /'Buy Now'/);
    assert.doesNotMatch(source, /Add \$\{quantity\} to Cart|Buy \$\{quantity\} Now/);
    assert.doesNotMatch(source, /previewLineTotal|previewUnitPriceNote|preview-line-total/);
  }
});

