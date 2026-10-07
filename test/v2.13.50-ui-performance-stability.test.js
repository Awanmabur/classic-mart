import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');

function cssHeight(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`${escaped}\\s*\\{[^}]*height:\\s*(\\d+)px`, 'gs'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

test('Classic AI uses a dedicated platform-aligned stylesheet instead of bespoke inline styling', () => {
  const view = read('views/ask-classic.ejs');
  assert.match(view, /href="\/classic-ai\.css"/);
  assert.doesNotMatch(view, /<style>/);
  assert.match(view, /class="classic-ai-shell"/);
  assert.match(view, /include\(["\']partials\/storefront-header["\']/i);
  assert.doesNotMatch(view, /class="classic-ai-topbar"/);
  const css = read('public/classic-ai.css');
  assert.match(css, /var\(--orange|#ff6500/i);
  assert.match(css, /\.classic-ai-grid/);
  assert.match(css, /@media\s*\(max-width:/);
});

test('product photography is compact across homepage, catalogue, and related products', () => {
  const home = read('public/styles.css');
  const catalogue = read('public/marketplace-pages.css');
  const related = read('public/storefront-pages.css');
  assert.match(home, /v2\.13\.50 compact marketplace media/);
  assert.match(home, /#trending\s+\.product-image\s*\{[^}]*height:\s*(?:14\d|15\d)px/s);
  assert.match(home, /\.product-grid\s+\.product-image\s*\{[^}]*height:\s*(?:14\d|15\d|16\d)px/s);
  assert.match(catalogue, /v2\.13\.50 compact catalogue media/);
  assert.ok((cssHeight(catalogue, '.catalog-product-image') ?? 999) <= 165);
  assert.match(related, /v2\.13\.50 compact related media/);
  assert.match(related, /\.preview-related-image\s*\{[^}]*height:\s*(?:9\d|10\d|11\d)px/s);
});

test('Shop by Category hides the native scrollbar without disabling horizontal overflow', () => {
  const css = read('public/styles.css');
  const block = css.match(/#categories \.category-row\s*\{[^}]*scrollbar-width:\s*none[^}]*\}/s);
  assert.ok(block, 'category row must hide Firefox scrollbar');
  assert.match(css, /#categories \.category-row::\-webkit\-scrollbar\s*\{[^}]*display:\s*none/s);
  assert.match(css, /#categories \.category-row\s*\{[^}]*overflow-x:\s*auto/s);
});

test('footer socials are real configured links through the shared storefront footer', () => {
  const partial = read('views/partials/social-links.ejs');
  assert.match(partial, /socialLinks/);
  assert.match(partial, /<a\s/);
  assert.match(partial, /target="_blank"/);
  assert.match(partial, /rel="noopener noreferrer"/);
  const footer = read('views/partials/storefront-footer.ejs');
  assert.match(footer, /include\(["']social-links["']\)/);
  const views = ['index.ejs', 'products.ejs', 'categories.ejs', 'search.ejs', 'help.ejs'];
  for (const file of views) {
    const source = read(`views/${file}`);
    assert.match(source, /include\(["']partials\/storefront-footer["']\)/, file);
    assert.doesNotMatch(source, /channel not published/i, file);
  }
  const locals = read('src/middleware/view.js');
  assert.match(locals, /socialLinks/);
  const css = read('public/styles.css');
  assert.match(css, /\.site-footer \.socials a:hover/);
  assert.match(css, /cursor:\s*pointer/);
});

test('homepage catalogue and CMS load concurrently', () => {
  const source = read('src/routes/public.js');
  const homepage = source.slice(source.indexOf("router.get('/',"), source.indexOf("router.get('/press'"));
  assert.match(homepage, /Promise\.all\(\[\s*getStorefront\(/s);
  assert.doesNotMatch(homepage, /const catalogue = connected\s*\? await getStorefront/);
});

test('authentication loads user and device in parallel without caching revocation state', () => {
  const source = read('src/middleware/auth.js');
  assert.match(source, /const \[actor, device\]\s*=\s*await Promise\.all\(\[/);
  assert.match(source, /User\.findById/);
  assert.match(source, /Device\.findOne/);
  assert.match(source, /await hydratePlatformAuthorization\(actor\)/);
});

test('feature flags use a short-lived shared raw-flag cache with explicit invalidation', () => {
  const source = read('src/services/stage9.js');
  assert.match(source, /FEATURE_FLAG_CACHE_TTL_MS/);
  assert.match(source, /featureFlagCache/);
  assert.match(source, /export function clearActiveFeatureCache/);
  assert.match(source, /clearActiveFeatureCache\(\)/);
});

test('login session establishment overlaps independent device and guest-cart writes', () => {
  const source = read('src/routes/identity.js');
  const start = source.indexOf('async function establishSession');
  const end = source.indexOf('\n}', start) + 2;
  const fn = source.slice(start, end);
  assert.match(fn, /await Promise\.all\(\[/);
  assert.match(fn, /createDevice/);
  assert.match(fn, /Order\.updateMany/);
});

test('development command is stable by default and watch mode is opt-in', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.dev, 'node src/server.js');
  assert.equal(pkg.scripts['dev:watch'], 'node --watch src/server.js');
  const builder = read('scripts/build-clean-app-release.js');
  assert.match(builder, /dev:'node src\/server\.js'/);
  assert.match(builder, /'dev:watch':'node --watch src\/server\.js'/);
});

test('storefront cache serves recently stale catalogue immediately while one refresh runs', () => {
  const source = read('src/services/storefront.js');
  assert.match(source, /STALE_CACHE_TTL_MS/);
  assert.match(source, /staleUntil/);
  assert.match(source, /refreshStorefrontCache/);
  assert.match(source, /current\.value[\s\S]*current\.staleUntil\s*>\s*now/);
});

test('sponsored product decoration does not execute three Mongo queries on every page hit', () => {
  const source = read('src/services/seller-growth.js');
  assert.match(source, /SPONSORED_CACHE_TTL_MS/);
  assert.match(source, /sponsoredOfferCache/);
  assert.match(source, /loadSponsoredOfferState/);
  assert.match(source, /export function clearSponsoredOfferCache/);
});

test('user-scoped operational queues have compound indexes matching their sort patterns', () => {
  assert.match(read('src/models/ProductAlert.js'), /userId:1,country:1,status:1,updatedAt:-1/);
  assert.match(read('src/models/StoreMember.js'), /userId:\s*1,\s*status:\s*1,\s*updatedAt:\s*-1/);
  assert.match(read('src/models/BusinessMember.js'), /userId:1,status:1,updatedAt:-1/);
  assert.match(read('src/models/SellerContactRequest.js'), /customerUserId:\s*1,\s*lastMessageAt:\s*-1/);
  assert.match(read('src/models/PromoterContactRequest.js'), /customerUserId:\s*1,\s*lastMessageAt:\s*-1/);
});

test('repeat navigation can reuse static assets instead of forcing CSS and JS revalidation', () => {
  const app = read('src/app.js');
  assert.match(app, /env\.isProduction[\s\S]*stale-while-revalidate/i);
  assert.doesNotMatch(app, /file\.endsWith\('\.js'\)[\s\S]{0,180}no-cache, max-age=0, must-revalidate/);
  const sw = read('public/sw.js');
  assert.match(sw, /classic-mart-public-v26/);
  assert.match(sw, /staleWhileRevalidate/);
  assert.match(sw, /liveAsset[\s\S]*staleWhileRevalidate\(request\)/);
});

test('secondary shopping cards do not return to oversized product photography', () => {
  const home = read('public/styles.css');
  const wishlist = read('public/wishlist.css');
  assert.match(home, /v2\.13\.50 compact secondary shopping media/);
  assert.match(home, /\.recommend-card \.recommend-image\s*\{[^}]*height:\s*(?:14\d|15\d|16\d)px/s);
  assert.match(wishlist, /v2\.13\.50 compact wishlist media/);
  const matches = [...wishlist.matchAll(/\.wishlist-card-image\s*\{[^}]*height:\s*(\d+)px/gs)];
  assert.ok(matches.length);
  assert.ok(Number(matches.at(-1)[1]) <= 165);
});

test('service worker never places private or no-store media responses in the public cache', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /function cacheableResponse/);
  assert.match(sw, /cache-control/i);
  assert.match(sw, /no-store/);
  assert.match(sw, /private/);
  assert.match(sw, /cacheableResponse\(response\)/);
});
