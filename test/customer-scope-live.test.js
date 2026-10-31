import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('refund pages join owned orders and ledger balance reads use an account index without mixing entries', {skip:!uri}, async () => {
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/verification|test/i);
  mongoose.set('strictQuery',true);
  await mongoose.connect(uri);
  const {Order,Refund,LedgerAccount,LedgerTransaction}=await import('../src/models/index.js');
  const {loadCustomerDashboardPage}=await import('../src/dashboard/customer-data.js');
  const {accountBalanceMinor}=await import('../src/services/money.js');
  const suffix=crypto.randomBytes(6).toString('hex');
  const owner=new mongoose.Types.ObjectId(), other=new mongoose.Types.ObjectId();
  const orders=[owner,other].map((userId,index)=>({_id:new mongoose.Types.ObjectId(),userId,publicId:`scope_${suffix}_${index}`,sessionKey:`scope_${suffix}`,idempotencyKey:`scope_${suffix}_${index}`,fulfillmentState:'unfulfilled',createdAt:new Date()}));
  const refunds=orders.map((order,index)=>({orderId:order._id,publicId:`refund_scope_${suffix}_${index}`,idempotencyKey:`refund_scope_${suffix}_${index}`,amountMinor:1000,status:'completed',createdAt:new Date()}));
  const accounts=[{_id:new mongoose.Types.ObjectId(),type:'asset'},{_id:new mongoose.Types.ObjectId(),type:'liability'},{_id:new mongoose.Types.ObjectId(),type:'liability'}].map((row,index)=>({...row,publicId:`ledger_scope_${suffix}_${index}`,code:`scope_${suffix}_${index}`,ownerType:'customer',ownerPublicId:`scope_${suffix}_${index}`,country:'UG',currency:'UGX',active:true}));
  const transactions=Array.from({length:22},(_,index)=>({publicId:`tx_scope_${suffix}_${index}`,idempotencyKey:`tx_scope_${suffix}_${index}`,entries:[{accountId:accounts[0]._id,debitMinor:100,creditMinor:0},{accountId:accounts[index===0?1:2]._id,debitMinor:0,creditMinor:100}],postedAt:new Date()}));
  try {
    await Order.collection.insertMany(orders);await Refund.collection.insertMany(refunds);
    assert.equal(Refund.schema.path('userId'),undefined,'refund scope must use its order relation');
    const view=await loadCustomerDashboardPage({user:{_id:owner,country:'UG'},country:{code:'UG'}},'returns');
    assert.deepEqual(view.refunds.map(row=>row.publicId),[refunds[0].publicId]);
    const foreign=await loadCustomerDashboardPage({user:{_id:other,country:'UG'},country:{code:'UG'}},'returns');
    assert.deepEqual(foreign.refunds.map(row=>row.publicId),[refunds[1].publicId]);
    await LedgerAccount.collection.insertMany(accounts);await LedgerTransaction.collection.insertMany(transactions);
    await LedgerTransaction.createIndexes();
    assert.equal(await accountBalanceMinor(accounts[1]._id),100);
    assert.equal(await accountBalanceMinor(accounts[2]._id),2100);
    assert.equal(await accountBalanceMinor(accounts[0]._id),2200);
    assert.equal(await accountBalanceMinor(accounts[1]._id,null,'liability'),100);
    const explained=await LedgerTransaction.find({'entries.accountId':accounts[1]._id}).hint({'entries.accountId':1,postedAt:-1}).explain('executionStats');
    assert.equal(explained.executionStats.totalDocsExamined,1);
  } finally {
    // Delete only these raw synthetic fixtures in the guarded local test database.
    await Refund.collection.deleteMany({publicId:{$in:refunds.map(row=>row.publicId)}});
    await Order.collection.deleteMany({_id:{$in:orders.map(row=>row._id)}});
    await LedgerTransaction.collection.deleteMany({publicId:{$in:transactions.map(row=>row.publicId)}});
    await LedgerAccount.collection.deleteMany({_id:{$in:accounts.map(row=>row._id)}});
    await mongoose.disconnect();
  }
});
