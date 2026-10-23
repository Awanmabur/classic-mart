import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
test('real purchase and referral reversals retain immutable lineage, debt, original market and independent chargeback proof',{skip:!uri,timeout:120000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/test|verification/i);
  await mongoose.connect(uri,{dbName:'classicmart_loyalty_recovery_test_'+crypto.randomBytes(8).toString('hex')});
  try{
    const models=await import('../src/models/index.js');
    const {LoyaltyAccount,LoyaltyEntry,Referral,Order,Refund,PaymentIntent,Chargeback}=models;
    const {addLoyaltyPoints,reverseGrowthForRefund,reverseGrowthForLostChargeback,assertLoyaltyBenefitsAvailable}=await import('../src/services/loyalty.js');
    for(const Model of Object.values(models))if(Model.init)await Model.init();
    let sequence=0;
    const tx=async work=>{const session=await mongoose.startSession();try{return await session.withTransaction(()=>work(session));}finally{await session.endSession();}};
    async function fixture({earning=1000,referral=true}={}){
      const buyer=new mongoose.Types.ObjectId(),referrer=new mongoose.Types.ObjectId();
      const key='case_'+(++sequence),_id=new mongoose.Types.ObjectId(),publicId='ord_'+key;
      await Order.collection.insertOne({_id,publicId,idempotencyKey:'order_'+key,checkoutId:'checkout_'+key,cartPublicId:'cart_'+key,sessionKey:'session_'+key,userId:buyer,country:'UG',paymentState:'paid',totals:{totalMinor:10000,currency:'UGX'},loyaltySnapshot:{eligibleMinor:10000},items:[]});
      const order=await Order.findById(_id),intent=await PaymentIntent.create({publicId:'pay_'+key,orderId:_id,orderPublicId:publicId,country:'UG',currency:'UGX',provider:'pesapal',method:'card',idempotencyKey:'paykey_'+key,status:'succeeded',amountMinor:10000,providerTrackingId:'tracking_'+key,paidAt:new Date()});
      let referralRow=null;
      await tx(async session=>{
        if(earning)await addLoyaltyPoints({userId:buyer,country:'UG',points:earning,idempotencyKey:`order:${publicId}:loyalty`,type:'order_earn',referenceType:'order',referencePublicId:publicId},session);
        if(referral){referralRow=await Referral.create([{publicId:'ref_'+key,code:'CODE'+key,referrerUserId:referrer,referredUserId:buyer,country:'UG',status:'rewarded',qualifiedOrderPublicId:publicId,referrerRewardPoints:100,referredRewardPoints:100}],{session}).then(rows=>rows[0]);for(const [side,userId] of [['referrer',referrer],['referred',buyer]])await addLoyaltyPoints({userId,country:'UG',points:100,idempotencyKey:`referral:${referralRow.publicId}:${side}`,type:'referral_earn',referenceType:'referral',referencePublicId:referralRow.publicId},session);}
      });return{order,intent,referral:referralRow,buyer,referrer};
    }
    async function refund(f,amount){const [row]=await Refund.create([{publicId:'rfd_'+(++sequence),idempotencyKey:'refund_'+sequence,orderId:f.order._id,paymentIntentId:f.intent._id,amountMinor:amount,currency:'UGX',provider:'wallet',status:'completed',reason:'Verified fixture refund',allocations:[{storePublicId:'sto_fixture',orderLineId:'line_fixture',grossMinor:amount}]}]);await tx(session=>reverseGrowthForRefund(f.order,row,session));return row;}
    async function lost(f,{independent=true,status='lost'}={}){
      await Order.collection.updateOne({_id:f.order._id},{$set:{paymentState:'failed'}});await PaymentIntent.updateOne({_id:f.intent._id},{$set:{status:'reversed',providerStatus:'REVERSED',lastVerifiedAt:new Date()}});
      const reviewer=new mongoose.Types.ObjectId();return Chargeback.create({publicId:'cbk_'+(++sequence),orderId:f.order._id,orderPublicId:f.order.publicId,paymentIntentId:f.intent._id,paymentIntentPublicId:f.intent.publicId,providerTrackingId:f.intent.providerTrackingId,country:'UG',currency:'UGX',amountMinor:10000,status,reviewedByUserId:reviewer,resolvedByUserId:independent?new mongoose.Types.ObjectId():reviewer,reviewedAt:new Date(),resolvedAt:new Date()});
    }
    await t.test('partial refund then final loss recovers only remaining original points and both referral bonuses',async()=>{
      const f=await fixture();await refund(f,4000);
      const original=await LoyaltyEntry.findOne({idempotencyKey:`order:${f.order.publicId}:loyalty`});
      const cbk=await lost(f);await tx(session=>reverseGrowthForLostChargeback(cbk,session));await tx(session=>reverseGrowthForLostChargeback(cbk,session));
      const reversals=await LoyaltyEntry.find({reversalOfEntryPublicId:original.publicId}).lean();assert.equal(reversals.reduce((sum,row)=>sum+row.reversedPoints,0),1000);assert.equal(reversals.filter(row=>row.type==='order_chargeback').length,1);
      assert.equal((await Referral.findById(f.referral._id)).status,'rejected');assert.equal(await LoyaltyEntry.countDocuments({chargebackPublicId:cbk.publicId,type:'referral_chargeback'}),2);
      const doc=await LoyaltyEntry.findById(original._id);doc.pointsDelta=999;await assert.rejects(doc.save(),/immutable/);assert.equal((await LoyaltyEntry.findById(original._id)).pointsDelta,1000);
    });
    await t.test('spent earnings create recovery debt, pause benefits and future real earnings repay it first',async()=>{
      const f=await fixture({earning:500,referral:false});
      const before=await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'});await tx(session=>addLoyaltyPoints({userId:f.buyer,country:'UG',points:-before.points,idempotencyKey:'spend_'+sequence,type:'reward_redeem'},session));
      await refund(f,10000);let account=await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'});assert.equal(account.points,0);assert.equal(account.reversalDebtPoints,500);assert.throws(()=>assertLoyaltyBenefitsAvailable(account),error=>error.code==='LOYALTY_REVERSAL_DEBT');
      await tx(session=>addLoyaltyPoints({userId:f.buyer,country:'UG',points:600,idempotencyKey:'repay_'+sequence,type:'manual_adjustment'},session));account=await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'});assert.equal(account.reversalDebtPoints,0);assert.equal(account.points,100);
      await tx(session=>addLoyaltyPoints({userId:f.buyer,country:'KE',points:17,idempotencyKey:'othermarket_'+sequence,type:'manual_adjustment'},session));assert.equal((await LoyaltyAccount.findOne({userId:f.buyer,country:'KE'})).points,17);
    });
    await t.test('referral recovery still runs when no purchase earning exists',async()=>{const f=await fixture({earning:0}),completed=await refund(f,10000);assert.equal(await LoyaltyEntry.countDocuments({type:'referral_refund',refundPublicId:completed.publicId,reversalOfEntryPublicId:{$ne:''}}),2);assert.equal((await Referral.findById(f.referral._id)).status,'rejected');});
    await t.test('a fully refunded purchase has no second loyalty exposure when the provider later confirms loss',async()=>{const f=await fixture({earning:80,referral:false});await refund(f,10000);const before=await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'}).lean(),cbk=await lost(f);await tx(session=>reverseGrowthForLostChargeback(cbk,session));assert.deepEqual(await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'}).lean(),before);assert.equal(await LoyaltyEntry.countDocuments({chargebackPublicId:cbk.publicId}),0);});
    await t.test('forged, unresolved and same-operator chargebacks cannot move points',async()=>{
      const f=await fixture({referral:false}),before=await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'}).lean();
      await assert.rejects(tx(session=>reverseGrowthForLostChargeback({_id:new mongoose.Types.ObjectId(),publicId:'cbk_fake'},session)),error=>error.code==='LOYALTY_CHARGEBACK_PROOF');
      const cbk=await lost(f,{independent:false});await assert.rejects(tx(session=>reverseGrowthForLostChargeback(cbk,session)),error=>error.code==='LOYALTY_CHARGEBACK_PROOF');
      await Chargeback.updateOne({_id:cbk._id},{$set:{resolvedByUserId:new mongoose.Types.ObjectId(),status:'reviewing'}});await assert.rejects(tx(session=>reverseGrowthForLostChargeback(cbk,session)),error=>error.code==='LOYALTY_CHARGEBACK_PROOF');
      assert.deepEqual(await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'}).lean(),before);
    });
    await t.test('transaction failure rolls back both balance and immutable reversal entries',async()=>{
      const f=await fixture({referral:false}),cbk=await lost(f),before=await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'}).lean();
      await assert.rejects(tx(async session=>{await reverseGrowthForLostChargeback(cbk,session);throw new Error('forced audit failure');}),/audit failure/);
      assert.deepEqual(await LoyaltyAccount.findOne({userId:f.buyer,country:'UG'}).lean(),before);assert.equal(await LoyaltyEntry.countDocuments({chargebackPublicId:cbk.publicId}),0);
      await Promise.all([tx(session=>reverseGrowthForLostChargeback(cbk,session)),tx(session=>reverseGrowthForLostChargeback(cbk,session))]);assert.equal(await LoyaltyEntry.countDocuments({chargebackPublicId:cbk.publicId}),1);
    });
  }finally{try{await mongoose.connection.dropDatabase();}finally{await mongoose.disconnect();}}
});
