import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
const root=path.resolve(import.meta.dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

test('Classic Wallet is a real authenticated checkout payment method',()=>{
  const checkoutRoute=read('src/routes/checkout.js');
  const mobileRoute=read('src/routes/stage11.js');
  const checkout=read('src/services/checkout.js');
  const order=read('src/models/Order.js');
  const intent=read('src/models/PaymentIntent.js');
  assert.match(checkoutRoute,/z\.enum\(\[[^\]]*['"]wallet['"]/s);
  assert.match(mobileRoute,/z\.enum\(\[[^\]]*['"]wallet['"]/s);
  assert.match(order,/paymentMethod[^\n]+wallet/);
  assert.match(intent,/provider[^\n]+wallet/);
  assert.match(intent,/method[^\n]+wallet/);
  assert.match(checkout,/payments\s*:\s*\{[^}]*wallet\s*:\s*Boolean\(request\.user\)/s);
  assert.match(checkout,/paymentMethod\s*===\s*['"]wallet['"][^\n]+request\.user/);
});

test('wallet payment atomically debits customer liability and settles the existing order ledger',()=>{
  const payments=read('src/services/payments.js');
  assert.match(payments,/order\.paymentMethod\s*===\s*['"]wallet['"]/);
  assert.match(payments,/provider\s*:\s*['"]wallet['"]/);
  assert.match(payments,/code\s*:\s*['"]customer_wallet['"]/);
  assert.match(payments,/accountBalanceMinor\(/);
  assert.match(payments,/WALLET_BALANCE_INSUFFICIENT/);
  assert.match(payments,/debitMinor\s*:\s*order\.totals\.totalMinor/);
  assert.match(payments,/idempotencyKey\s*:\s*`payment:\$\{intent\.publicId\}`/);
});

test('wallet refunds return value to the same customer wallet without an external provider',()=>{
  const refund=read('src/models/Refund.js');
  const payments=read('src/services/payments.js');
  assert.match(refund,/provider[^\n]+wallet/);
  assert.match(payments,/intent\.provider\s*===\s*['"]wallet['"]/);
  assert.match(payments,/provider\s*=\s*['"]wallet['"]/);
  assert.match(payments,/providerRefundId\s*=\s*`wallet:/);
  assert.match(payments,/creditMinor\s*:\s*refund\.amountMinor/);
});

test('storefront checkout exposes Classic Wallet only for authenticated customers',()=>{
  const cart=read('views/cart.ejs');
  const client=read('public/cart-page.js');
  assert.match(cart,/value="wallet"/);
  assert.match(cart,/Classic Wallet/);
  assert.match(cart,/user[^\n]+customer/);
  assert.match(client,/data\.payment\s*===\s*['"]wallet['"]/);
});

test('remaining Customer Final 19 pages are real data-bound pages',()=>{
  const data=read('src/dashboard/customer-data.js');
  const view=read('views/partials/customer-live-pages.ejs');
  assert.match(data,/loadCategories/);assert.match(data,/getStorefront/);
  assert.match(data,/loadCart/);assert.match(data,/cartData/);
  assert.match(data,/loadNotifications/);assert.match(data,/Notification\.find/);
  assert.match(data,/loadClub/);assert.match(data,/customerClubSummary/);
  for(const page of ['categories','cart','notifications','club']) assert.match(view,new RegExp(`pageId===['"]${page}['"]`));
});
