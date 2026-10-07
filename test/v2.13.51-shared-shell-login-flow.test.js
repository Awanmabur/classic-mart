import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sharedShellViews = [
  'views/index.ejs',
  'views/products.ejs',
  'views/categories.ejs',
  'views/search.ejs',
  'views/about.ejs',
  'views/careers.ejs',
  'views/cart.ejs',
  'views/compare.ejs',
  'views/contact.ejs',
  'views/cookies.ejs',
  'views/help.ejs',
  'views/payment-policy.ejs',
  'views/press.ejs',
  'views/privacy.ejs',
  'views/promoter-profile.ejs',
  'views/promoters.ejs',
  'views/returns.ejs',
  'views/seller-profile.ejs',
  'views/sellers.ejs',
  'views/shipping.ejs',
  'views/terms.ejs',
  'views/track-order.ejs',
  'views/wishlist.ejs',
  'views/ask-classic.ejs',
  'views/mobile-app.ejs',
];

test('public marketplace pages use one shared storefront header and footer', () => {
  const header = read('views/partials/storefront-header.ejs');
  const footer = read('views/partials/storefront-footer.ejs');
  assert.match(header, /class="site-header"/);
  assert.match(header, /href="\/ask-classic"/);
  assert.match(footer, /class="site-footer"/);
  assert.match(footer, /include\(["']social-links["']\)/);

  for (const viewPath of sharedShellViews) {
    const view = read(viewPath);
    assert.match(view, /include\(["']partials\/storefront-header["']/i, `${viewPath} must include the shared storefront header`);
    assert.match(view, /include\(["']partials\/storefront-footer["']/i, `${viewPath} must include the shared storefront footer`);
    assert.doesNotMatch(view, /<header class="site-header"/, `${viewPath} must not carry a copied site header`);
    assert.doesNotMatch(view, /<footer class="site-footer"/, `${viewPath} must not carry a copied site footer`);
  }
});

test('Classic AI no longer uses a separate topbar in place of the marketplace shell', () => {
  const view = read('views/ask-classic.ejs');
  assert.doesNotMatch(view, /class="classic-ai-topbar"/);
  assert.match(view, /include\(["']partials\/storefront-header["']/i);
  assert.match(view, /include\(["']partials\/storefront-footer["']/i);
});

test('view locals expose the current request path for account return navigation', () => {
  const viewLocals = read('src/middleware/view.js');
  assert.match(viewLocals, /currentPath:\s*request\.originalUrl/);
});

test('direct sign-in returns to the marketplace while protected routes keep their requested destination', () => {
  const identity = read('src/routes/identity.js');
  assert.match(identity, /function safeNext\([\s\S]*?:\s*'\/'\s*;/);
  const loginStart = identity.indexOf("router.get('/login'");
  const loginEnd = identity.indexOf('router.post(', loginStart);
  const loginRoute = identity.slice(loginStart, loginEnd);
  assert.match(loginRoute, /safeNext\(request\.query\.next\)/);
  assert.match(loginRoute, /if \(request\.user\) return response\.redirect\(safeNext\(request\.query\.next\)\)/);
  assert.doesNotMatch(loginRoute, /redirect\('\/dashboard'\)/);

  const auth = read('src/middleware/auth.js');
  assert.match(auth, /request\.originalUrl/);
  assert.match(auth, /\/login\?next=/);
});
