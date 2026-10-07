import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Cart } from '../src/models/index.js';
import { getOrCreateCart } from '../src/services/checkout.js';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
test('real MongoDB merges carts once and preserves one cart across concurrent authenticated sessions', {skip:!uri}, async () => {
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/verification|test/i);
  await mongoose.connect(uri);
  const userId = new mongoose.Types.ObjectId(), productId = new mongoose.Types.ObjectId(), variantId = new mongoose.Types.ObjectId();
  const guestKey = crypto.randomUUID();
  const keys = [guestKey,`account:${userId}:UG`];
  try {
    await Cart.init();
    await Cart.create({publicId:'crt_'+crypto.randomUUID(),sessionKey:guestKey,country:'UG',items:[{productId,variantId,quantity:2}]});
    await Cart.create({publicId:'crt_'+crypto.randomUUID(),sessionKey:crypto.randomUUID(),userId,country:'UG',items:[{productId,variantId,quantity:3}]});
    const requests = Array.from({length:4},()=>({user:{_id:userId},country:{code:'UG'},session:{cartKey:guestKey}}));
    const carts = await Promise.all(requests.map(getOrCreateCart));
    for (const cart of carts) assert.equal(cart.items[0].quantity,5);
    assert.equal(await Cart.countDocuments({userId}),1);
    assert.equal(await Cart.countDocuments({sessionKey:guestKey}),0);
    for(const request of requests) assert.equal(request.session.cartKey,`account:${userId}:UG`);
    const restored = await getOrCreateCart({user:{_id:userId},country:{code:'UG'},session:{}});
    assert.equal(restored.items[0].quantity,5);
    await assert.rejects(getOrCreateCart({country:{code:'UG'},session:{cartKey:restored.sessionKey}}),error=>error.code==='CART_FORBIDDEN');
  } finally {
    await Cart.deleteMany({$or:[{userId},{sessionKey:{$in:keys}}]});
    await mongoose.disconnect();
  }
});
