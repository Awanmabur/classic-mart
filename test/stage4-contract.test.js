import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Stage 4 cart page routes mutations through the server-synchronizing cart store', async () => {
  const source = await read('public/cart-page.js');
  assert.match(source, /requireCartService\('setQuantity'\)\.setQuantity/);
  assert.match(source, /requireCartService\('remove'\)\.remove/);
  assert.match(source, /requireCartService\('clear'\)\.clear/);
  assert.match(source, /requireCartService\('add'\)\.add/);
  assert.doesNotMatch(source, /else\s*\{\s*(?:delete\s+cart|cart\[id\]\s*=|cart\s*=\s*\{\})/s);
});

test('Stage 4 does not simulate client-side discounts or collect raw card credentials', async () => {
  const source = await read('public/cart-page.js');
  const view = await read('views/cart.ejs');
  assert.doesNotMatch(source, /CLASSIC10 applied/);
  assert.doesNotMatch(view, /name="cvv"|id="cardCvv"|CVV/i);
  assert.match(view, /Card details are not collected here/);
});

test('Stage 4 checkout creates pending-payment orders with idempotency and reservations', async () => {
  const service = await read('src/services/checkout.js');
  const order = await read('src/models/Order.js');
  assert.match(service, /idempotencyKey: input\.idempotencyKey/);
  assert.match(service, /\$inc: \{ reserved: item\.quantity \}/);
  assert.match(service, /status: 'pending_payment'/);
  assert.match(order, /sessionKey: 1, idempotencyKey: 1/);
});

test('Stage 4 delivery-location control persists server-side and validates configured zones', async () => {
  const routes = await read('src/routes/checkout.js');
  const browser = await read('public/script.js');
  assert.match(routes, /\/api\/v1\/delivery-location/);
  assert.match(routes, /checkoutOptions\(request, city\)/);
  assert.match(routes, /DELIVERY_AREA_UNAVAILABLE/);
  assert.match(browser, /Checking delivery coverage/);
  assert.match(browser, /x-csrf-token/);
});
