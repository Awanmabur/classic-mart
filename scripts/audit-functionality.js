import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const failures = [];
const requireText = (rel, pattern, message) => { if (!pattern.test(read(rel))) failures.push(`${rel}: ${message}`); };
const forbidText = (rel, pattern, message) => { if (pattern.test(read(rel))) failures.push(`${rel}: ${message}`); };

for (const [rel, pattern, message] of [
  ['public/script.js', /setText\('#previewUnitPrice', money\(product\.price \* quantity, product\.currency\)\)/, 'product preview original price does not increase with quantity'],
  ['public/script.js', /setPreviewVariant\(previewOption\.dataset\.previewOption\)/, 'variant selection does not update the live preview state'],
  ['public/script.js', /addToCart\(buyNow\.dataset\.buyNow, previewState\.quantity, previewState\.variantId\)/, 'Buy Now does not use the selected variant and quantity'],
  ['public/script.js', /const added = await addToCart\(buyNow/, 'Buy Now does not wait for the server cart write'],
  ['public/script.js', /const added = await addToCart\(modalAdd/, 'preview Add to Cart does not wait for the server cart write'],
  ['public/cart-store.js', /id: item\.variantId/, 'browser cart lines are not keyed by variant'],
  ['public/cart-page.js', /map\(\(\[lineId, quantity\]\)/, 'cart page does not preserve variant line identities'],
  ['public/cart-page.js', /data-cart-plus="\$\{escapeHtml\(lineId\)\}"/, 'cart quantity controls do not target the variant line'],
  ['src/services/checkout.js', /Only \$\{sellable\.available\} item\(s\) are available for this option/, 'server cart does not reject insufficient stock clearly'],
  ['public/catalog-page.js', /await window\.ClassicMartCart\.add/, 'catalogue Add to Cart does not wait for persistence'],
  ['public/wishlist.js', /await window\.ClassicMartCart\.add/, 'wishlist Add to Cart does not wait for persistence'],
]) requireText(rel, pattern, message);

for (const [rel, pattern, message] of [
  ['public/script.js', /previewLineTotal|previewUnitPriceNote|preview-line-total/, 'product preview still renders a duplicate quantity price'],
  ['public/product-preview.js', /previewLineTotal|previewUnitPriceNote|preview-line-total/, 'shared product preview still renders a duplicate quantity price'],
  ['public/script.js', /addToCart\(buyNow[^\n]+\);\s*window\.location\.assign/s, 'Buy Now still navigates before the cart write finishes'],
  ['public/script.js', /addToCart\(modalAdd[^\n]+\);\s*window\.location\.assign/s, 'preview Add to Cart still redirects immediately'],
  ['public/cart-store.js', /id: item\.productId,\s*quantity:/s, 'multiple variants of one product still collapse to one cart key'],
  ['public/cart-page.js', /if \(!latest\.length && Object\.keys\(cart\)\.length\) return/, 'clearing the last cart item can leave stale cart UI'],
  ['src/services/checkout.js', /const qty = Math\.min\(quantity, sellable\.available/, 'server still silently clamps requested cart quantity'],
  ['public/wishlist.js', /\.forEach\(addCart\)/, 'Add all wishlist items still fires unsafe concurrent cart writes'],
]) forbidText(rel, pattern, message);


const publicRoot = path.join(root, 'public');
const viewsRoot = path.join(root, 'views');
const viewFiles = fs.readdirSync(viewsRoot).filter((name) => name.endsWith('.ejs')).sort();
const camelDataName = (attribute) => attribute.slice(5).split('-').map((part, index) => index ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part).join('');

for (const name of viewFiles) {
  const rel = `views/${name}`;
  const source = read(rel);
  const scriptSources = [...source.matchAll(/<script[^>]+\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
  let handlers = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n');
  for (const scriptSource of scriptSources) {
    if (!scriptSource.startsWith('/')) continue;
    const file = path.join(publicRoot, scriptSource.slice(1));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) handlers += `\n${fs.readFileSync(file, 'utf8')}`;
  }

  for (const form of source.matchAll(/<form\b([^>]*)>/gi)) {
    const attributes = form[1];
    if (/\baction\s*=/i.test(attributes)) continue;
    const id = attributes.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!id) failures.push(`${rel}: actionless form is missing a JavaScript hook id`);
    else if (!handlers.includes(id)) failures.push(`${rel}: actionless form #${id} has no handler in a script loaded by that page`);
  }

  for (const button of source.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/gi)) {
    const attributes = button[1];
    if (!/\btype\s*=\s*["']button["']/i.test(attributes) || /\bonclick\s*=/i.test(attributes)) continue;
    const hooks = [];
    const id = attributes.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    if (id) hooks.push(id);
    for (const match of attributes.matchAll(/\b(data-[\w-]+)(?:\s*=\s*["'][^"']*["'])?/gi)) {
      hooks.push(match[1].toLowerCase(), camelDataName(match[1].toLowerCase()));
    }
    if (!hooks.length || !hooks.some((hook) => handlers.includes(hook))) {
      const label = button[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'unlabelled button';
      failures.push(`${rel}: non-submit button “${label}” has no handler in a script loaded by that page`);
    }
  }

  if (/href\s*=\s*["'](?:#["']|javascript:)/i.test(source)) failures.push(`${rel}: contains a placeholder or JavaScript href`);
}

forbidText('views/cart.ejs', /id=["'](?:orderComplete|copyOrderNumber)["']/, 'cart still includes a dead client-only order confirmation instead of the real tracked-order flow');

if (failures.length) {
  console.error('End-to-end functionality audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`End-to-end functionality audit passed (${viewFiles.length} views plus preview, variants, cart, catalogue and wishlist).`);
