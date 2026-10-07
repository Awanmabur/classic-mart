import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { GiftCard, CountrySetting, LoyaltyAccount, LoyaltyEntry } from '../src/models/index.js';
import { hashToken } from '../src/core/crypto.js';
import { encryptSensitive } from '../src/core/sensitive.js';
import { redeemGiftCard } from '../src/services/stage9.js';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
test('real MongoDB gift-card redemption credits one concurrent claimant and rolls back failed credit', { skip: !uri }, async () => {
  const target = new URL(uri);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /verification|test/i);
  await mongoose.connect(uri);
  // ZZ is confined to the isolated test database and avoids changing live settings.
  await CountrySetting.collection.updateOne({ code: 'ZZ' }, { $set: { growth: { giftCardsEnabled: true, loyaltyPointsPer1000Minor: 1 } } }, { upsert: true });
  const users = [0, 1].map(() => ({ _id: new mongoose.Types.ObjectId(), country: 'ZZ' }));
  const cards = [];
  async function issue() {
    const code = crypto.randomBytes(20).toString('hex');
    const card = await GiftCard.create({ publicId: 'gft_' + code, codeHash: hashToken(code), codeEncrypted: encryptSensitive(code), codeLast4: code.slice(-4), country: 'ZZ', currency: 'UGX', initialValueMinor: 5000, balanceMinor: 5000, issuedByUserId: users[0]._id });
    cards.push(card._id);
    return { card, code };
  }
  try {
    await Promise.all([GiftCard.init(), LoyaltyAccount.init(), LoyaltyEntry.init()]);
    const first = await issue();
    const results = await Promise.allSettled(users.map(user => redeemGiftCard({ user, code: first.code })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failed = results.find(result => result.status === 'rejected');
    assert.equal(failed.reason.code, 'GIFT_CARD_INVALID');
    const stored = await GiftCard.findById(first.card._id).lean();
    assert.equal(stored.status, 'redeemed');
    assert.equal(stored.balanceMinor, 0);
    const entries = await LoyaltyEntry.find({ referencePublicId: stored.publicId }).lean();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].pointsDelta, 5);
    assert.equal(String(entries[0].userId), String(stored.redeemedByUserId));
    const accounts = await LoyaltyAccount.find({ userId: { $in: users.map(user => user._id) } }).lean();
    assert.equal(accounts.reduce((sum, account) => sum + account.points, 0), 5);

    const second = await issue();
    // Force a genuine MongoDB duplicate-key failure during the credit insert.
    await LoyaltyEntry.collection.createIndex({ referencePublicId: 1 }, { unique: true, name: 'verification_credit_failure', partialFilterExpression: { referencePublicId: second.card.publicId } });
    await LoyaltyEntry.collection.insertOne({ publicId: 'test_conflict_' + second.card.publicId, idempotencyKey: 'unrelated_' + second.card.publicId, userId: users[0]._id, referencePublicId: second.card.publicId });
    const before = await LoyaltyAccount.findOne({ userId: users[0]._id }).lean();
    await assert.rejects(redeemGiftCard({ user: users[0], code: second.code }), error => error.code === 11000);
    const unclaimed = await GiftCard.findById(second.card._id).lean();
    assert.equal(unclaimed.status, 'active');
    assert.equal(unclaimed.balanceMinor, 5000);
    assert.equal(unclaimed.redeemedByUserId, undefined);
    const after = await LoyaltyAccount.findOne({ userId: users[0]._id }).lean();
    assert.equal(after?.points || 0, before?.points || 0);
  } finally {
    await LoyaltyEntry.collection.dropIndex('verification_credit_failure').catch(() => {});
    await GiftCard.deleteMany({ _id: { $in: cards } });
    await LoyaltyEntry.collection.deleteMany({ userId: { $in: users.map(user => user._id) } });
    await LoyaltyAccount.deleteMany({ userId: { $in: users.map(user => user._id) } });
    await CountrySetting.collection.deleteOne({ code: 'ZZ' });
    await mongoose.disconnect();
  }
});
