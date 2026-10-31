import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('product preview recalculates price, stock and SKU for quantity and variant changes', () => {
  const source = read('public/script.js');
  assert.match(source, /function updatePreviewPurchaseSummary/);
  assert.match(source, /setText\('#previewUnitPrice', money\(product\.price \* quantity, product\.currency\)\)/);
  assert.doesNotMatch(source, /previewLineTotal|previewUnitPriceNote|preview-line-total/);
  assert.match(source, /setPreviewVariant\(previewOption\.dataset\.previewOption\)/);
  assert.match(source, /previewStockCount/);
  assert.match(source, /previewSku/);
});

test('preview cart actions persist the selected variant before navigation', () => {
  const source = read('public/script.js');
  assert.match(source, /const added = await addToCart\(buyNow\.dataset\.buyNow, previewState\.quantity, previewState\.variantId\)/);
  assert.match(source, /const added = await addToCart\(modalAdd\.dataset\.modalAddCart, previewState\.quantity, previewState\.variantId\)/);
  assert.doesNotMatch(source, /addToCart\(buyNow[^\n]+\);\s*window\.location\.assign/s);
  assert.doesNotMatch(source, /addToCart\(modalAdd[^\n]+\);\s*window\.location\.assign/s);
});

test('browser cart keeps separate variants and clears its final rendered line', () => {
  const store = read('public/cart-store.js');
  const page = read('public/cart-page.js');
  assert.match(store, /id: item\.variantId/);
  assert.match(store, /cartLineId: item\.variantId/);
  assert.match(page, /\{ lineId, product, quantity \}/);
  assert.match(page, /data-cart-minus="\$\{escapeHtml\(lineId\)\}"/);
  assert.doesNotMatch(page, /if \(!latest\.length && Object\.keys\(cart\)\.length\) return/);
});

test('server and all product-list surfaces use reliable cart writes', () => {
  const checkout = read('src/services/checkout.js');
  const catalogue = read('public/catalog-page.js');
  const wishlist = read('public/wishlist.js');
  assert.match(checkout, /INSUFFICIENT_STOCK/);
  assert.doesNotMatch(checkout, /const qty = Math\.min\(quantity, sellable\.available/);
  assert.match(catalogue, /await window\.ClassicMartCart\.add/);
  assert.match(wishlist, /await window\.ClassicMartCart\.add/);
  assert.doesNotMatch(wishlist, /\.forEach\(addCart\)/);
});
