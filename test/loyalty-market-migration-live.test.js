import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
test('loyalty market migration preserves balances and establishes replacement uniqueness before retiring the global index',{skip:!uri,timeout:120000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/test|verification/i);
  await mongoose.connect(uri,{dbName:'classicmart_loyalty_migration_test_'+crypto.randomBytes(8).toString('hex')});
  try{
    const {LoyaltyAccount}=await import('../src/models/LoyaltyAccount.js');
    const {migrateLoyaltyMarkets,inspectLoyaltyMarketMigration}=await import('../src/services/loyalty-market-migration.js');
    await LoyaltyAccount.createCollection();
    await LoyaltyAccount.collection.createIndex({userId:1},{unique:true,name:'legacy_user_unique'});
    const userId=new mongoose.Types.ObjectId(),row={publicId:'loy_legacy',userId,country:'UG',points:287,lifetimeEarned:991,lifetimeRedeemed:704,reversalDebtPoints:0};
    await LoyaltyAccount.collection.insertOne(row);
    await t.test('failed legacy retirement leaves both indexes and every source value unchanged',async()=>{
      const before=await LoyaltyAccount.collection.findOne({userId});
      const original=LoyaltyAccount.collection.dropIndex.bind(LoyaltyAccount.collection);
      t.mock.method(LoyaltyAccount.collection,'dropIndex',async name=>{if(name==='legacy_user_unique')throw new Error('forced index retirement failure');return original(name);});
      await assert.rejects(migrateLoyaltyMarkets(),/retirement failure/);t.mock.restoreAll();
      const indexes=await LoyaltyAccount.collection.indexes();assert.ok(indexes.some(index=>index.name==='legacy_user_unique'));assert.ok(indexes.some(index=>index.name==='loyalty_user_country_unique'&&index.unique));
      assert.deepEqual(await LoyaltyAccount.collection.findOne({userId}),before);
    });
    await t.test('retry permits one account in each market without copying the original balance',async()=>{
      await migrateLoyaltyMarkets();await migrateLoyaltyMarkets();
      await LoyaltyAccount.create({publicId:'loy_new_market',userId,country:'KE'});
      assert.equal((await LoyaltyAccount.findOne({userId,country:'UG'})).points,287);
      assert.equal((await LoyaltyAccount.findOne({userId,country:'KE'})).points,0);
      await assert.rejects(LoyaltyAccount.create({publicId:'loy_duplicate',userId,country:'UG'}),error=>error.code===11000);
    });
    await t.test('invalid source data fails preflight without changing indexes or balances',async()=>{
      await LoyaltyAccount.collection.insertOne({publicId:'loy_invalid',userId:new mongoose.Types.ObjectId(),country:'invalid',points:-1});
      const before=await LoyaltyAccount.collection.find({}).sort({_id:1}).toArray(),indexes=await LoyaltyAccount.collection.indexes();
      const plan=await inspectLoyaltyMarketMigration();assert.equal(plan.invalid.length,1);
      await assert.rejects(migrateLoyaltyMarkets(),error=>error.code==='LOYALTY_MIGRATION_PREFLIGHT');
      assert.deepEqual(await LoyaltyAccount.collection.find({}).sort({_id:1}).toArray(),before);assert.deepEqual(await LoyaltyAccount.collection.indexes(),indexes);
    });
  }finally{t.mock.restoreAll();try{await mongoose.connection.dropDatabase();}finally{await mongoose.disconnect();}}
});
