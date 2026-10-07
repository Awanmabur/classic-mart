import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root=path.resolve(import.meta.dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

const shell=read('views/customer-dashboard.ejs');
const customer=read('views/partials/dashboard-customer.ejs');

const spriteIds=[
  'i-cart','i-search','i-dashboard','i-grid','i-heart','i-bell','i-bag','i-clipboard','i-pin','i-award','i-wallet','i-refresh','i-support','i-user','i-logout','i-crown','i-star','i-sparkles','i-tag','i-card','i-phone','i-chevron-down','i-chevron-right','i-arrow-right','i-menu','i-close','i-plus','i-minus','i-trash','i-edit','i-check','i-truck','i-box','i-clock','i-filter','i-download','i-shield','i-message','i-eye','i-home'
];
const pages=['dashboard','orders','wishlist','addresses','rewards','wallet','returns','support','profile','categories','cart','notifications','club'];

test('Customer shell preserves the Final 19 shell hierarchy and complete icon sprite',()=>{
  for(const id of spriteIds) assert.match(shell,new RegExp(`id=["']${id}["']`),`missing ${id}`);
  assert.match(shell,/class=["']app-shell["']/);
  assert.match(shell,/class=["']topbar["']/);
  assert.match(shell,/class=["']sidebar["'][^>]*id=["']sidebar["']/);
  assert.match(shell,/class=["']sidebar-overlay["'][^>]*id=["']sidebarOverlay["']/);
  assert.match(shell,/class=["']dashboard page-host["'][^>]*id=["']pageHost["']/);
  assert.doesNotMatch(shell,/class=["']main-content["']/);
});

test('Customer shell preserves the native Final 19 workspace pill and profile control',()=>{
  assert.match(shell,/class=["']workspace-switcher["'][^>]*id=["']workspaceSwitcher["']/);
  assert.match(shell,/id=["']roleSwitcher["']/);
  assert.match(shell,/>Customer Dashboard</);
  assert.match(shell,/class=["']workspace-switcher-chevron["']/);
  assert.match(shell,/id=["']profileButton["'][\s\S]*?#i-chevron-down/);
});

test('Customer partial retains all 13 Final 19 page surfaces with canonical data-page identity',()=>{
  for(const page of pages){
    assert.match(customer,new RegExp(`data-page=["']${page}["']`),`missing data-page=${page}`);
  }
});

test('Customer overview uses the literal Final 19 composition instead of a reconstructed generic layout',()=>{
  const required=[
    'dashboard-overview','left-column','welcome-card panel','stats-grid','orders-card panel','orders-list swipe-zone','quick-actions-card panel','quick-actions-grid','right-column','club-card','rewards-card panel','reward-content','wishlist-card panel','wishlist-grid swipe-zone','help-card panel'
  ];
  for(const classes of required) assert.match(customer,new RegExp(`class=["']${classes.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["']`),`missing ${classes}`);
});

test('Customer navigation keeps Final 19 badges and approved labels',()=>{
  for(const label of ['Dashboard','My Orders','Wishlist','Addresses','Rewards','Wallet','Returns &amp; Refunds','Support Tickets','Profile Settings']) assert.match(shell,new RegExp(label));
  assert.match(shell,/id=["']sidePoints["']/);
  assert.match(shell,/id=["']sideWallet["']/);
  assert.match(shell,/id=["']wishlistBadge["']/);
  assert.match(shell,/id=["']cartBadge["']/);
  assert.match(shell,/id=["']notificationBadge["']/);
});

test('secondary Customer pages preserve Final 19 composition contracts',()=>{
  const requiredByPage={
    orders:['summary-grid four','toolbar','rich-order-list','rich-order'],
    wishlist:['wishlist-hero panel','product-grid','product-card panel'],
    addresses:['two-column-page address-layout','stack-list','address-card panel','panel form-panel','dashboard-form'],
    rewards:['reward-hero','reward-catalog','two-column-page rewards-lower','activity-list','panel tier-card'],
    wallet:['wallet-top-grid','wallet-hero','panel form-panel compact','two-column-page wallet-lower','transaction-list','secure-note'],
    returns:['summary-grid three','two-column-page return-layout','eligible-list','policy-box'],
    support:['stats-grid support-category-grid','two-column-page support-layout','panel form-panel','ticket-list'],
    profile:['profile-layout','panel profile-summary','panel form-panel settings-content active','settings-nav'],
    categories:['category-grid','panel content-panel','product-grid compact-products'],
    cart:['cart-layout','cart-list','panel checkout-card','secure-checkout'],
    notifications:['notification-layout','notification-tabs','notification-list','panel content-panel notification-settings'],
    club:['club-page-hero','benefit-grid','tier-table'],
  };
  for(const [page,classes] of Object.entries(requiredByPage)){
    const start=customer.indexOf(`data-page="${page}"`);
    assert.notEqual(start,-1,`missing ${page}`);
    const next=customer.indexOf('data-page="',start+12);
    const section=customer.slice(start,next===-1?customer.length:next);
    for(const classesValue of classes) assert.match(section,new RegExp(`class=[\"']${classesValue.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:\\s|[\"'])`),`${page} missing ${classesValue}`);
  }
});



test('Customer overview preserves Final 19 visible card contract',()=>{
  const start=customer.indexOf('data-page="dashboard"');
  const next=customer.indexOf('data-page="orders"',start);
  const overview=customer.slice(start,next);
  assert.match(overview,/Savings This Month/);
  assert.match(overview,/class=["']saved["']/);
  assert.match(overview,/Rewards &amp; Benefits/);
  assert.match(overview,/class=["']help-card panel["']/);
  assert.doesNotMatch(overview,/class=["']recent-card panel["']/);
});

test('Customer pages retain the distinctive Final 19 visual structures instead of reduced substitutes',()=>{
  const required=[
    'deal-badge','rating','soft-button','amount-chips','ghost-light-button','payment-card',
    'return-product','card-actions','profile-completion','security-setting','choice-grid',
    'heart-button','quick-icon blue','quick-icon pink','quick-icon green','benefit-card panel locked'
  ];
  for(const token of required) assert.match(customer,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`missing Final 19 token ${token}`);
});







test('Final 19 address edit control uses the real owned update route',()=>{
  const runtime=read('public/dashboard/customer.js');
  assert.match(customer,/data-address-edit/);
  assert.match(customer,/id=["']addressForm["']/);
  assert.match(runtime,/addressForm/);
  assert.match(runtime,/data-address-edit/);
  assert.match(runtime,/\/dashboard\/addresses\//);
});

test('Final 19 cart presentation keeps real clear-cart and promotion controls',()=>{
  const runtime=read('public/dashboard/customer.js');
  for(const token of ['coupon-row','delivery-note','wallet-use','data-cart-clear','data-cart-promo']) assert.match(customer,new RegExp(token));
  assert.match(runtime,/api\/v1\/cart['"]?/);
  assert.match(runtime,/api\/v1\/cart\/promotions/);
});

test('Final 19 wallet controls are wired to real Customer behavior',()=>{
  const runtime=read('public/dashboard/customer.js');
  const route=read('src/routes/dashboard.js');
  assert.match(customer,/\/dashboard\/wallet\/statement\.csv/);
  assert.match(route,/router\.get\('\/dashboard\/wallet\/statement\.csv'/);
  assert.match(route,/text\/csv/);
  assert.match(runtime,/data-wallet-amount/);
  assert.match(runtime,/walletAmount/);
});

test('Final 19 mobile sidebar and profile controls remain operable without demo runtime',()=>{
  const runtime=read('public/dashboard/customer.js');
  assert.match(runtime,/sidebarOverlay/);
  assert.match(runtime,/classList\.remove\(['"]open['"]\)/);
  assert.doesNotMatch(shell,/id=["']profileMenu["'][^>]*\shidden(?:\s|>)/);
  assert.match(runtime,/aria-expanded/);
});
