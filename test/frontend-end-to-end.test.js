import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('public discovery, editorial and customer proof surfaces are database backed', () => {
  const routes = read('src/routes/public.js');
  const home = read('views/index.ejs');
  const cms = read('src/models/CmsContent.js');
  assert.match(routes, /publishedCmsList\(\{ prefix: 'home\.hero\.'/);
  assert.match(routes, /publishedTestimonials/);
  assert.match(routes, /publishedCmsList\(\{ prefix: 'press\.article\.'/);
  assert.match(home, /homeHeroSlides/);
  assert.match(home, /homeTestimonials/);
  assert.match(home, /pressArticles/);
  assert.doesNotMatch(home, /Sarah J\.|Michael T\.|Emma L\.|Save up to <strong>70%/);
  assert.match(cms, /'hero','press'/);
});

test('promoter discovery, follows, contacts and replies are complete server workflows', () => {
  const storefront = read('src/routes/storefront.js');
  const promoterRoutes = read('src/routes/promoters.js');
  const accountRoutes = read('src/routes/account.js');
  const state = read('src/models/CustomerCatalogueState.js');
  const contacts = read('src/models/PromoterContactRequest.js');
  assert.match(storefront, /\/api\/v1\/storefront\/promoters/);
  assert.match(storefront, /promoters\/:id\/follow/);
  assert.match(storefront, /promoters\/:id\/contact/);
  assert.match(promoterRoutes, /promoter\/messages\/:id\/reply/);
  assert.match(accountRoutes, /account\/promoter-messages\/:id\/reply/);
  assert.match(state, /followedPromoterUserIds/);
  assert.match(contacts, /promoterUserId/);
});

test('cart, finance, seller growth and business forms use database selections instead of raw IDs', () => {
  const cart = read('public/cart-page.js');
  const cartView = read('views/cart.ejs');
  const finance = read('views/money-workspace.ejs');
  const growth = read('views/seller-growth.ejs');
  const business = read('views/business-workspace.ejs');
  assert.match(cart, /String\(product\.id/);
  assert.match(cartView, /id="cartRecommendedGrid"[^>]*><\/div>/);
  assert.doesNotMatch(cart, /Number\(product\.id\)|product\.price\s*<=\s*50/);
  assert.match(finance, /eligibleRefundOrders/);
  assert.doesNotMatch(finance, /placeholder="Order public ID"/);
  assert.match(growth, /view\.products/);
  assert.doesNotMatch(growth, /Product public IDs/);
  assert.doesNotMatch(business, /Product public ID|Seller store public ID/);
});
