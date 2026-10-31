import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { GiftCard, CountrySetting, LoyaltyAccount, LoyaltyEntry, User } from '../src/models/index.js';
import { hashToken } from '../src/core/crypto.js';
import { encryptSensitive } from '../src/core/sensitive.js';
import { redeemGiftCard } from '../src/services/stage9.js';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
test('real MongoDB gift-card redemption credits one concurrent claimant and rolls back failed credit', { skip: !uri, timeout: 120_000 }, async () => {
  const target = new URL(uri);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_gift_card_test_' + suffix });
  let users = [];
  const cards = [];
  async function issue() {
    const code = crypto.randomBytes(20).toString('hex');
    const card = await GiftCard.create({ publicId: 'gft_' + code, codeHash: hashToken(code), codeEncrypted: encryptSensitive(code), codeLast4: code.slice(-4), country: 'ZZ', currency: 'UGX', initialValueMinor: 5000, balanceMinor: 5000, issuedByUserId: users[0]._id });
    cards.push(card._id);
    return { card, code };
  }
  try {
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
  // ZZ is confined to the isolated test database and avoids changing live settings.
  await CountrySetting.create({ code: 'ZZ', name: 'Gift card test market', currency: 'UGX', locale: 'en-UG', timeZone: 'UTC', phonePrefix: '+256', active: true, growth: { giftCardsEnabled: true, loyaltyPointsPer1000Minor: 1 } });
  users = await User.create([0, 1].map(index => ({ publicId: 'usr_gift_' + suffix + '_' + index, name: 'Gift claimant ' + index, email: 'gift-' + suffix + '-' + index + '@example.com', emailNormalized: 'gift-' + suffix + '-' + index + '@example.com', phone: '+25670011100' + index, phoneNormalized: '+25670011100' + index, passwordHash: crypto.randomBytes(32).toString('hex'), role: 'customer', country: 'ZZ', currency: 'UGX', status: 'active', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } })));
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
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
