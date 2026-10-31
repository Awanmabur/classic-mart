import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

const base=process.env.CLASSIC_MART_LIVE_BASE_URL, uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const token=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];
const suffix=()=>crypto.randomBytes(7).toString('hex');
const id=prefix=>`${prefix}_${suffix()}`;
const decode=value=>value.replaceAll('&amp;','&');
const older=(html,label)=>decode(html.match(new RegExp('href="([^"]+)" rel="next">Older '+label))?.[1]||'');
const rewardCard=(html,publicId)=>html.split('id="reward-').find(fragment=>fragment.startsWith(publicId+'"'))||'';
const transports=new Set();
let signupSequence=0;

async function withDatabase(work){
  const target=new URL(uri);assert.equal(target.hostname,'127.0.0.1');assert.match(target.pathname,/verification|test/i);
  await mongoose.connect(uri);try{await work(mongoose.connection.db);}finally{for(const transport of transports)transport.destroy();transports.clear();await mongoose.disconnect();}
}
async function signup(db,name){
  const tag=suffix(),email=`customer-recovery-${tag}@example.com`,password=`Recovery-${tag}A1!`;
  const transport=new http.Agent({localAddress:`127.0.0.${160+(++signupSequence)}`,keepAlive:false});transports.add(transport);
  const agent=request.agent(base).use(req=>req.agent(transport));
  const form=await agent.get('/signup').expect(200);
  await agent.post('/signup').type('form').send({name,email,phone:`+2567${crypto.randomInt(10000000,99999999)}`,password,confirmPassword:password,acceptTerms:'on',_csrf:token(form.text)}).expect(302);
  return {agent,user:await db.collection('users').findOne({emailNormalized:email})};
}

function ownedHistoryOrder(user, tag=suffix()) {
  const now=new Date(Date.now()-60_000);
  return {_id:new mongoose.Types.ObjectId(),publicId:`ord_source_${tag}`,sessionKey:`source_${tag}`,idempotencyKey:`source_${tag}`,
    checkoutId:`checkout_${tag}`,cartPublicId:`cart_${tag}`,userId:user._id,country:'UG',status:'paid',paymentState:'paid',fulfillmentState:'delivered',
    paymentMethod:'wallet',deliveryMethod:'standard',returnState:'none',refundState:'none',cancellationState:'none',
    contact:{fullName:user.name,email:user.email,phone:user.phone,address:'Owned history address',city:'Kampala',country:'UG'},
    totals:{subtotalMinor:1000,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:1000,currency:'UGX'},
    items:[{linePublicId:`oli_source_${tag}`,productPublicId:`prd_source_${tag}`,variantPublicId:`var_source_${tag}`,storePublicId:`str_source_${tag}`,title:'Owned source purchase',quantity:1,deliveredQuantity:1,unitPriceMinor:1000,lineTotalMinor:1000,currency:'UGX'}],
    createdAt:now,updatedAt:now};
}

test('Customer source links reach owned receipts, exact returns, refunds, exchanges and old top-ups without exposing forged sources', {skip:!base||!uri,timeout:120_000}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Source Recovery'),{agent:other,user:foreign}=await signup(db,'Foreign Source');
  const order=ownedHistoryOrder(user),foreignOrder=ownedHistoryOrder(foreign),now=new Date();
  const returned={_id:new mongoose.Types.ObjectId(),publicId:id('ret_source'),userId:user._id,orderId:order._id,orderPublicId:order.publicId,country:'UG',status:'refunded',reason:'damaged',details:'Owned damaged purchase return.',resolution:'refund',returnMethod:'dropoff',items:[],timeline:[],createdAt:now,updatedAt:now};
  const replacement={...ownedHistoryOrder(user),paymentMethod:'exchange',idempotencyKey:`exchange:${returned.publicId}`};
  returned.replacementOrderPublicId=replacement.publicId;
  const payment={_id:new mongoose.Types.ObjectId(),publicId:id('pay_source'),orderId:order._id,orderPublicId:order.publicId,country:'UG',currency:'UGX',provider:'wallet',method:'wallet',status:'partially_refunded',amountMinor:1000,createdAt:now};
  const foreignPayment={...payment,_id:new mongoose.Types.ObjectId(),publicId:id('pay_foreign'),orderId:foreignOrder._id,orderPublicId:foreignOrder.publicId};
  const refund={_id:new mongoose.Types.ObjectId(),publicId:id('ref_source'),idempotencyKey:id('refund_source'),orderId:order._id,paymentIntentId:payment._id,returnRequestId:returned._id,returnPublicId:returned.publicId,amountMinor:100,currency:'UGX',provider:'wallet',status:'completed',createdAt:now};
  returned.refundPublicId=refund.publicId;
  const forged={...returned,_id:new mongoose.Types.ObjectId(),publicId:id('ret_forged'),orderId:foreignOrder._id,orderPublicId:foreignOrder.publicId,
    refundPublicId:id('ref_foreign_cached'),replacementOrderPublicId:foreignOrder.publicId};
  const document={_id:new mongoose.Types.ObjectId(),publicId:id('fdoc_source'),documentNumber:`RCPT-${suffix()}`,eventKey:id('receipt'),type:'payment_receipt',
    orderId:order._id,orderPublicId:order.publicId,ownerUserId:user._id,paymentIntentId:payment._id,paymentIntentPublicId:payment.publicId,country:'UG',currency:'UGX',amountMinor:1000,
    snapshot:{order:{id:order.publicId,items:order.items,totals:order.totals},payment:{id:payment.publicId,provider:'wallet',method:'wallet'}},issuedAt:now,createdAt:now};
  await db.collection('orders').insertMany([order,foreignOrder,replacement]);
  await db.collection('paymentintents').insertMany([payment,foreignPayment]);
  await db.collection('returnrequests').insertMany([returned,forged]);
  await db.collection('refunds').insertOne(refund);
  await db.collection('financialdocuments').insertOne(document);
  const topUps=Array.from({length:14},(_,index)=>({_id:new mongoose.Types.ObjectId(),publicId:id('wtu_source'),userId:user._id,userPublicId:user.publicId,
    country:'UG',currency:'UGX',amountMinor:100,status:'succeeded',provider:'pesapal',providerReference:id('topup_reference'),idempotencyKey:id('topup_key'),createdAt:new Date(now.getTime()-index*1000)}));
  await db.collection('wallettopups').insertMany(topUps);
  const issuedRewards=Array.from({length:102},(_,index)=>({_id:new mongoose.Types.ObjectId(),publicId:id('rwd_source'),idempotencyKey:id('reward_source'),userId:user._id,
    country:'UG',currency:'UGX',rewardKey:'source-voucher',label:`Owned voucher ${index}`,kind:'voucher',status:'issued',pointsCost:10,valueMinor:100,maximumDiscountMinor:100,
    expiresAt:new Date(now.getTime()+86400000),createdAt:new Date(now.getTime()-index*1000)}));
  issuedRewards[0].orderPublicId=foreignOrder.publicId;
  issuedRewards[1].orderPublicId=order.publicId;
  const historicalReward={...issuedRewards[101],_id:new mongoose.Types.ObjectId(),publicId:id('rwd_historical'),idempotencyKey:id('reward_historical'),currency:'USD',label:'Historical dollar voucher'};
  const expiredReward={...issuedRewards[101],_id:new mongoose.Types.ObjectId(),publicId:id('rwd_expired'),idempotencyKey:id('reward_expired'),expiresAt:new Date(now.getTime()-86400000)};
  await db.collection('customerrewards').insertMany([...issuedRewards,historicalReward,expiredReward]);
  const walletId=new mongoose.Types.ObjectId(),clearingId=new mongoose.Types.ObjectId();
  await db.collection('ledgeraccounts').insertOne({_id:walletId,publicId:id('acc_source'),code:'customer_wallet',ownerType:'customer',ownerPublicId:user.publicId,country:'UG',currency:'UGX',type:'liability',active:true});
  const invalidRefund=id('ref_missing');
  const refs=[['payment',payment.publicId],['refund',refund.publicId],['wallet_topup',topUps[13].publicId],['payment',foreignPayment.publicId],['refund',invalidRefund]];
  await db.collection('ledgertransactions').insertMany(refs.map(([referenceType,referencePublicId],index)=>({_id:new mongoose.Types.ObjectId(),publicId:id('ltx_source'),idempotencyKey:id('source_ledger'),referenceType,referencePublicId,country:'UG',currency:'UGX',description:`Source activity ${index}`,postedAt:new Date(now.getTime()-index),createdAt:now,
    entries:[{accountId:walletId,accountPublicId:'owned_wallet',debitMinor:0,creditMinor:100},{accountId:clearingId,accountPublicId:'clearing',debitMinor:100,creditMinor:0}]})));
  await db.collection('loyaltyentries').insertMany([order.publicId,foreignOrder.publicId].map((referencePublicId,index)=>({_id:new mongoose.Types.ObjectId(),publicId:id('loe_source'),idempotencyKey:id('loyalty_source'),userId:user._id,country:'UG',type:'order_earn',referenceType:'order',referencePublicId,reason:`Verified purchase points ${index}`,pointsDelta:10,balanceAfter:10,createdAt:now})));
  await db.collection('loyaltyentries').insertOne({_id:new mongoose.Types.ObjectId(),publicId:id('loe_source'),idempotencyKey:id('loyalty_source'),userId:user._id,country:'UG',type:'reward_redeem',referenceType:'customer_reward',referencePublicId:issuedRewards[101].publicId,reason:'Redeemed owned voucher',pointsDelta:-10,balanceAfter:0,createdAt:now});
  await db.collection('loyaltyentries').insertOne({_id:new mongoose.Types.ObjectId(),publicId:id('loe_source'),idempotencyKey:id('loyalty_source'),userId:user._id,country:'UG',type:'reward_redeem',referenceType:'customer_reward',referencePublicId:historicalReward.publicId,reason:'Redeemed historical currency voucher',pointsDelta:-10,balanceAfter:0,createdAt:now});
  const wallet=await agent.get('/wallet').expect(200),receiptHref=`/orders/${order.publicId}/documents/${document.publicId}`;
  assert.ok(wallet.text.includes(`href="${receiptHref}">${payment.publicId}</a>`));
  assert.ok(wallet.text.includes(`href="/returns?refund=${refund.publicId}#refund-${refund.publicId}">${refund.publicId}</a>`));
  assert.ok(wallet.text.includes(`href="/wallet?topUp=${topUps[13].publicId}#topup-${topUps[13].publicId}">${topUps[13].publicId}</a>`));
  assert.doesNotMatch(wallet.text,new RegExp(`${foreignPayment.publicId}|${foreignOrder.publicId}|${invalidRefund}`));
  const receipt=await agent.get(receiptHref).expect(200);assert.match(receipt.headers['cache-control'],/no-store/);assert.ok(receipt.text.includes(document.documentNumber));assert.ok(receipt.text.includes(order.publicId));
  await other.get(receiptHref).expect(404);
  let returns=await agent.get(`/returns?refund=${refund.publicId}`).expect(200);
  assert.ok(returns.text.includes(`id="refund-${refund.publicId}"`));
  assert.ok(returns.text.includes(`href="/returns?return=${returned.publicId}#return-${returned.publicId}">${returned.publicId}</a>`));
  assert.ok(returns.text.includes(`href="/track-order?order=${order.publicId}">${order.publicId}</a>`));
  assert.ok(returns.text.includes(`href="/track-order?order=${replacement.publicId}">${replacement.publicId}</a>`));
  assert.doesNotMatch(returns.text,new RegExp(`${foreignOrder.publicId}|${forged.refundPublicId}`));
  await other.get(`/returns?return=${returned.publicId}`).expect(404);await other.get(`/returns?refund=${refund.publicId}`).expect(404);
  await agent.get(`/returns?return=${forged.publicId}`).expect(404);await agent.get('/returns?return[bad]=record').expect(404);
  const rewards=await agent.get('/rewards').expect(200);assert.ok(rewards.text.includes(`href="/track-order?order=${order.publicId}">Verified purchase points 0</a>`));assert.doesNotMatch(rewards.text,new RegExp(foreignOrder.publicId));
  assert.doesNotMatch(rewardCard(rewards.text,issuedRewards[1].publicId),/ · Order /);
  assert.ok(rewards.text.includes(`href="/rewards?reward=${issuedRewards[101].publicId}#reward-${issuedRewards[101].publicId}">Redeemed owned voucher</a>`));
  const oldReward=await agent.get('/rewards?reward='+issuedRewards[101].publicId).expect(200);assert.ok(oldReward.text.includes(`id="reward-${issuedRewards[101].publicId}"`));await other.get('/rewards?reward='+issuedRewards[101].publicId).expect(404);
  assert.ok(rewards.text.includes(`href="/rewards?reward=${historicalReward.publicId}#reward-${historicalReward.publicId}">Redeemed historical currency voucher</a>`));
  const historical=await agent.get('/rewards?reward='+historicalReward.publicId).expect(200),historicalCard=rewardCard(historical.text,historicalReward.publicId);
  assert.match(historicalCard,/issued · USD/);assert.doesNotMatch(historicalCard,/Use at Checkout/);
  const expired=await agent.get('/rewards?reward='+expiredReward.publicId).expect(200),expiredCard=rewardCard(expired.text,expiredReward.publicId);
  assert.match(expiredCard,/expired · Expires/);assert.doesNotMatch(expiredCard,/Use at Checkout/);
  const tracking=await agent.get('/api/v1/orders/'+order.publicId).expect(200);assert.equal(tracking.body.order.id,order.publicId);assert.ok(tracking.body.order.documents.some(row=>row.href===receiptHref));
  await other.get('/api/v1/orders/'+order.publicId).expect(401);
  const oldTopUp=await agent.get(`/wallet?topUp=${topUps[13].publicId}`).expect(200);assert.ok(oldTopUp.text.includes(`id="topup-${topUps[13].publicId}"`));await other.get(`/wallet?topUp=${topUps[13].publicId}`).expect(404);
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE){
    const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
    try{
      const context=await browser.newContext();
      const cookie=(await agent.get('/wallet')).headers['set-cookie'].find(value=>value.startsWith('cm.sid=')).split(';')[0],separator=cookie.indexOf('=');
      await context.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:base}]);
      const page=await context.newPage();await page.goto(base+'/wallet');
      await page.locator(`a[href="${receiptHref}"]`).click();await page.waitForURL('**'+receiptHref);assert.equal(await page.locator('#documentTitle').textContent(),'Payment receipt');
      await page.goto(base+'/wallet');await page.locator(`a[href="/returns?refund=${refund.publicId}#refund-${refund.publicId}"]`).click();
      await page.waitForURL(`**/returns?refund=${refund.publicId}#refund-${refund.publicId}`);assert.equal(await page.locator(`#refund-${refund.publicId}`).count(),1);
      await context.close();
    }finally{await browser.close();}
  }
}));

test('all five Customer after-sales histories traverse every owned record with account-bound signed keysets beyond 30', {skip:!base||!uri,timeout:120_000}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Case History Recovery'),{agent:other,user:foreign}=await signup(db,'Foreign Case History');
  const order=ownedHistoryOrder(user),foreignOrder=ownedHistoryOrder(foreign),now=new Date(Date.now()-60_000),tag=suffix();
  await db.collection('orders').insertMany([order,foreignOrder]);
  const payment={_id:new mongoose.Types.ObjectId(),publicId:id('pay_history'),orderId:order._id,orderPublicId:order.publicId,country:'UG',currency:'UGX',provider:'wallet',method:'wallet',status:'partially_refunded',amountMinor:1000};
  await db.collection('paymentintents').insertOne(payment);
  const groups={return:[],refund:[],dispute:[],case:[],ticket:[]};
  for(let index=0;index<67;index++){
    const common={_id:new mongoose.Types.ObjectId(),userId:user._id,country:'UG',createdAt:now,updatedAt:now},returnId=new mongoose.Types.ObjectId(),returnPublicId=`ret_history_${tag}_${index}`;
    groups.return.push({...common,_id:returnId,publicId:returnPublicId,orderId:order._id,orderPublicId:order.publicId,status:'closed',reason:'damaged',details:'Owned history return.',resolution:'refund',returnMethod:'dropoff',items:[],timeline:[]});
    groups.refund.push({...common,_id:new mongoose.Types.ObjectId(),publicId:`ref_history_${tag}_${index}`,idempotencyKey:`refund_history_${tag}_${index}`,orderId:order._id,paymentIntentId:payment._id,returnRequestId:returnId,returnPublicId,amountMinor:1,currency:'UGX',provider:'wallet',status:'completed'});
    groups.dispute.push({...common,_id:new mongoose.Types.ObjectId(),publicId:`dsp_history_${tag}_${index}`,orderId:order._id,orderPublicId:order.publicId,status:'closed',category:'damaged',subject:'Owned history dispute',description:'Owned purchase conversation.',events:[{type:'internal',visibility:'internal',message:'INTERNAL_CASE_HISTORY_SECRET',at:now}]});
    groups.case.push({...common,_id:new mongoose.Types.ObjectId(),publicId:`tcs_history_${tag}_${index}`,reporterUserId:user._id,type:'seller_conduct',status:'closed',description:'Owned trust report history.',publicMessages:[]});
    groups.ticket.push({...common,_id:new mongoose.Types.ObjectId(),publicId:`tkt_history_${tag}_${index}`,orderId:order._id,orderPublicId:order.publicId,status:'closed',category:'order',subject:'Owned support ticket history',priority:'normal',resolvedAt:now,notes:[{internal:true,message:'INTERNAL_CASE_HISTORY_SECRET',at:now}]});
  }
  const definitions=[['return','returnrequests','/returns','return requests','returnsCursor'],['refund','refunds','/returns','refunds','refundsCursor'],['dispute','disputes','/returns','disputes','disputesCursor'],['case','trustcases','/returns','reports','casesCursor'],['ticket','supporttickets','/support','tickets','ticketsCursor']];
  for(const [kind,collection]of definitions){
    const row=groups[kind][0],hidden={...row,_id:new mongoose.Types.ObjectId(),publicId:`foreign_${kind}_${tag}`,idempotencyKey:`foreign_${kind}_${tag}`,userId:foreign._id,reporterUserId:foreign._id,orderId:foreignOrder._id,orderPublicId:foreignOrder.publicId,description:'FOREIGN_CASE_HISTORY_SECRET',subject:'FOREIGN_CASE_HISTORY_SECRET',returnRequestId:undefined};
    delete hidden.returnRequestId;
    await db.collection(collection).insertMany([...groups[kind],hidden]);
  }
  let returnCursor='';
  for(const [kind,,path,label,key]of definitions){
    const seen=new Set(),expected=new Set(groups[kind].map(row=>row.publicId));let target=path,pages=0,firstCursor='';
    while(target){
      const response=await agent.get(target).expect(200);assert.match(response.headers['cache-control'],/no-store/);assert.doesNotMatch(response.text,/FOREIGN_CASE_HISTORY_SECRET|INTERNAL_CASE_HISTORY_SECRET/);
      const records=[...response.text.matchAll(new RegExp(`data-customer-history="${kind}" data-record-id="([^"]+)"`,'g'))].map(row=>row[1]);
      assert.ok(records.length>0&&records.length<=30);for(const publicId of records){assert.ok(expected.has(publicId));assert.ok(!seen.has(publicId));seen.add(publicId);}
      target=older(response.text,label);if(!firstCursor&&target)firstCursor=target;assert.ok(++pages<=3);
    }
    assert.equal(seen.size,67);assert.equal(pages,3);assert.ok(firstCursor);
    await other.get(firstCursor).expect(422);
    const tampered=new URL(firstCursor,base),value=tampered.searchParams.get(key);tampered.searchParams.set(key,value.slice(0,-1)+(value.endsWith('A')?'B':'A'));await agent.get(tampered.pathname+tampered.search).expect(422);
    if(kind==='return')returnCursor=new URL(firstCursor,base).searchParams.get(key);
    else await agent.get(`${path}?${key}=${encodeURIComponent(returnCursor)}`).expect(422);
  }
  const oldest=groups.return[0];
  const focused=await agent.get('/returns?return='+oldest.publicId).expect(200);assert.ok(focused.text.includes(`id="return-${oldest.publicId}"`));
  const oldestRefund=groups.refund[0],focusedRefund=await agent.get('/returns?refund='+oldestRefund.publicId).expect(200);assert.ok(focusedRefund.text.includes(`id="refund-${oldestRefund.publicId}"`));
}));

test('owned order histories use stable keysets and server status filters beyond the former limit', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'History Recovery'),{agent:other,user:otherUser}=await signup(db,'Other History');
  const now=new Date(Date.now()-60_000),tag=suffix(),rows=[];
  for(let index=0;index<69;index++)rows.push({_id:new mongoose.Types.ObjectId(),publicId:`ord_history_${tag}_${index}`,sessionKey:`history_${tag}_${index}`,idempotencyKey:`history_${tag}_${index}`,checkoutId:`checkout_${tag}_${index}`,cartPublicId:`cart_${tag}_${index}`,userId:user._id,country:'UG',status:'paid',paymentState:'paid',fulfillmentState:index<35?'processing':index<66?'shipped':'delivered',returnState:'none',totals:{totalMinor:1000,currency:'UGX'},items:[{title:`History purchase ${index}`}],createdAt:now,updatedAt:now});
  await db.collection('orders').insertMany([...rows,{...rows[0],_id:new mongoose.Types.ObjectId(),publicId:id('ord_foreign'),sessionKey:id('foreign_session'),idempotencyKey:id('foreign_history'),checkoutId:id('foreign_checkout'),cartPublicId:id('foreign_cart'),userId:otherUser._id,items:[{title:'FOREIGN_HISTORY_PRIVATE'}]}]);
  let page=await agent.get('/orders').expect(200),next=older(page.text,'orders');assert.ok(next);assert.doesNotMatch(page.text,/FOREIGN_HISTORY_PRIVATE/);
  const seen=new Set([...page.text.matchAll(/Order #(ord_history_[A-Za-z0-9_]+)/g)].map(row=>row[1]));
  const firstCursor=next;
  while(next){page=await agent.get(next).expect(200);for(const row of page.text.matchAll(/Order #(ord_history_[A-Za-z0-9_]+)/g)){assert.ok(!seen.has(row[1]));seen.add(row[1]);}next=older(page.text,'orders');}
  assert.equal(seen.size,69);
  await other.get(firstCursor).expect(422);
  await agent.get(firstCursor.slice(0,-1)+(firstCursor.endsWith('A')?'B':'A')).expect(422);
  page=await agent.get('/orders?status=shipped').expect(200);assert.equal([...page.text.matchAll(/data-order-group="shipped"/g)].length,30);assert.doesNotMatch(page.text,/data-order-group="processing"/);
  next=older(page.text,'orders');assert.ok(next);assert.equal([...((await agent.get(next).expect(200)).text.matchAll(/data-order-group="shipped"/g))].length,1);
  await agent.get(firstCursor+'&status=shipped').expect(422);
  await agent.get('/orders?status=invalid').expect(422);
}));

test('saved addresses edit all fields, protect versions and maintain one default under concurrent writes', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Address Recovery'),{agent:other}=await signup(db,'Other Address');
  const page=await agent.get('/addresses').expect(200),csrf=token(page.text);
  const address={fullName:'Address Recovery',label:'Home',phone:'+256700000001',address:'Recovery Test Street',city:'Kampala',country:'UG',note:'Gate opens inward',isDefault:'on',_csrf:csrf};
  await Promise.all([agent.post('/addresses').type('form').send(address).expect(302),agent.post('/addresses').type('form').send({...address,label:'Office'}).expect(302)]);
  let addresses=await db.collection('customeraddresses').find({userId:user._id,archivedAt:null}).toArray();assert.equal(addresses.length,2);assert.equal(addresses.filter(row=>row.isDefault).length,1);
  const target=addresses.find(row=>row.isDefault),edit=await agent.get('/addresses?edit='+target.publicId).expect(200);assert.match(edit.text,/Edit Delivery Address/);assert.match(edit.text,/Gate opens inward/);
  await other.get('/addresses?edit='+target.publicId).expect(404);
  const otherPage=await other.get('/addresses').expect(200);
  await other.post('/addresses/'+target.publicId).type('form').send({...address,_csrf:token(otherPage.text)}).expect(404);
  await agent.post('/addresses/'+target.publicId).type('form').send({...address,version:target.__v||0,note:'Updated private delivery note',address:'Updated Recovery Street',_csrf:token(edit.text)}).expect(302);
  await agent.post('/addresses/'+target.publicId).type('form').send({...address,version:target.__v||0,_csrf:token(edit.text)}).expect(409);
  const updated=await db.collection('customeraddresses').findOne({_id:target._id});assert.equal(updated.note,'Updated private delivery note');assert.equal(updated.address,'Updated Recovery Street');
  await agent.post('/addresses/'+target.publicId+'/archive').type('form').send({_csrf:csrf}).expect(302);
  addresses=await db.collection('customeraddresses').find({userId:user._id,archivedAt:null}).toArray();assert.equal(addresses.length,1);assert.equal(addresses[0].isDefault,true);
}));

test('move to wishlist commits only the selected owned cart variant and survives replay, stale requests and rollback', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Cart Recovery'),{agent:other,user:otherUser}=await signup(db,'Other Cart');
  let page=await agent.get('/cart').expect(200);const csrf=token(page.text);
  await other.get('/cart').expect(200);
  const productId=new mongoose.Types.ObjectId(),v1=new mongoose.Types.ObjectId(),v2=new mongoose.Types.ObjectId(),p1=id('var'),p2=id('var'),storeId=new mongoose.Types.ObjectId();
  const variantTime=new Date();
  await db.collection('productvariants').insertMany([
    {_id:v1,publicId:p1,productId,storeId,sku:`RECOVERY-${p1.toUpperCase()}`,active:true,title:'First variant',priceMinor:1000,currency:'UGX',__v:0,createdAt:variantTime,updatedAt:variantTime},
    {_id:v2,publicId:p2,productId,storeId,sku:`RECOVERY-${p2.toUpperCase()}`,active:true,title:'Second variant',priceMinor:1000,currency:'UGX',__v:0,createdAt:variantTime,updatedAt:variantTime},
  ]);
  await db.collection('carts').updateOne({userId:user._id,country:'UG'},{$set:{items:[{productId,variantId:v1,quantity:2},{productId,variantId:v2,quantity:3}],__v:7}});
  const endpoint='/api/v1/customer/cart/move-to-wishlist';
  const otherToken=token((await other.get('/cart').expect(200)).text);
  await other.post(endpoint).set('x-csrf-token',otherToken).send({variantId:p1,cartVersion:7}).expect(404);
  await agent.post(endpoint).send({variantId:p1,cartVersion:7}).expect(403);
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p1,cartVersion:7}).expect(200);
  let cart=await db.collection('carts').findOne({userId:user._id,country:'UG'});assert.equal(cart.items.length,1);assert.equal(String(cart.items[0].variantId),String(v2));assert.equal(cart.items[0].quantity,3);
  let state=await db.collection('customercataloguestates').findOne({userId:user._id});assert.ok(state.wishlistProductIds.some(value=>String(value)===String(productId)));
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p1,cartVersion:7}).expect(200);
  await db.collection('carts').updateOne({_id:cart._id},{$push:{items:{productId,variantId:v1,quantity:1}},$inc:{__v:1}});
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p1,cartVersion:7}).expect(409);
  const otherProduct=new mongoose.Types.ObjectId();await db.collection('productvariants').updateOne({_id:v2},{$set:{productId:otherProduct}});
  await db.collection('carts').updateOne({_id:cart._id,'items.variantId':v2},{$set:{'items.$.productId':otherProduct}});
  await db.collection('customercataloguestates').updateOne({_id:state._id},{$set:{wishlistProductIds:Array.from({length:500},()=>new mongoose.Types.ObjectId())}});
  cart=await db.collection('carts').findOne({_id:cart._id});
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p2,cartVersion:cart.__v}).expect(409);
  assert.equal((await db.collection('carts').findOne({_id:cart._id})).items.length,2);
  assert.equal(await db.collection('customercataloguestates').countDocuments({userId:otherUser._id}),0);
}));

test('wallet statement exports every owned ledger posting, opening and closing balances and no foreign account', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Statement Recovery'),{user:foreign}=await signup(db,'Foreign Statement');
  const accountId=new mongoose.Types.ObjectId(),otherId=new mongoose.Types.ObjectId(),foreignId=new mongoose.Types.ObjectId();
  await db.collection('ledgeraccounts').insertMany([{_id:accountId,publicId:id('acc'),code:'customer_wallet',ownerType:'customer',ownerPublicId:user.publicId,ownerId:user._id,country:'UG',currency:'UGX',type:'liability',active:true},{_id:foreignId,publicId:id('acc'),code:'customer_wallet',ownerType:'customer',ownerPublicId:foreign.publicId,country:'UG',currency:'UGX',type:'liability',active:true}]);
  const rows=[],day=new Date(Date.now()-3*86400000),from=new Date(day);from.setUTCHours(0,0,0,0);
  for(let index=0;index<63;index++){
    const before=index<3,credit=before?100:index%2?10:0,debit=before?0:index%2?0:4;
    const at=new Date(from.getTime()+(before?-3600000:index*60000));
    rows.push({_id:new mongoose.Types.ObjectId(),publicId:id('ltx'),idempotencyKey:id('statement'),referenceType:'verification',referencePublicId:`own_${index}`,country:'UG',currency:'UGX',description:index===3?'=UNTRUSTED_CSV_FORMULA':'Wallet verification',postedAt:at,createdAt:at,entries:[{accountId,accountPublicId:'owned_wallet',debitMinor:debit,creditMinor:credit},{accountId:otherId,accountPublicId:'clearing',debitMinor:credit,creditMinor:debit}]});
  }
  rows.push({...rows[0],_id:new mongoose.Types.ObjectId(),publicId:id('ltx'),idempotencyKey:id('statement'),referencePublicId:'FOREIGN_LEDGER_SECRET',entries:[{accountId:foreignId,accountPublicId:'foreign_wallet',debitMinor:0,creditMinor:100},{accountId:otherId,accountPublicId:'clearing',debitMinor:100,creditMinor:0}]});
  await db.collection('ledgertransactions').insertMany(rows);
  const statement=await agent.get('/wallet/statement.csv?from='+from.toISOString().slice(0,10)).expect(200);
  assert.match(statement.headers['cache-control'],/no-store/);assert.match(statement.text,/"opening_balance".*"300"/);assert.match(statement.text,/"closing_balance".*"480"/);assert.equal((statement.text.match(/"verification"/g)||[]).length,60);assert.match(statement.text,/"'=UNTRUSTED_CSV_FORMULA"/);assert.doesNotMatch(statement.text,/FOREIGN_LEDGER_SECRET/);
  await agent.get('/wallet/statement.csv?from=2026-02-30').expect(422);
}));

test('private avatars validate real raster data, replace and delete with durable physical cleanup records', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Avatar Recovery'),{agent:other}=await signup(db,'Other Avatar');
  let page=await agent.get('/profile').expect(200),csrf=token(page.text);
  const photo=await sharp({create:{width:400,height:400,channels:3,background:'#c04800'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'PRIVATE_METADATA_SHOULD_BE_REMOVED'}}}).toBuffer();
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',Buffer.from('<svg onload="alert(1)"></svg>'),{filename:'forged.jpg',contentType:'image/jpeg'}).expect(422);
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',photo,{filename:'portrait.jpg',contentType:'image/jpeg'}).expect(302);
  let assets=await db.collection('customeravatars').find({userId:user._id}).toArray(),current=assets.find(row=>row.current);assert.ok(current);assert.equal(current.width,320);assert.equal(current.height,320);
  const image=await agent.get('/account/avatar').expect(200).expect('Content-Type',/image\/webp/);assert.match(image.headers['cache-control'],/no-store/);const info=await sharp(image.body).metadata();assert.equal(info.width,320);assert.equal(info.height,320);assert.equal(info.exif,undefined);
  await other.get('/account/avatar?v='+current.publicId).expect(404);
  await request(base).get('/account/avatar').expect(302);
  const tooSmall=await sharp({create:{width:319,height:400,channels:3,background:'#fff'}}).png().toBuffer();
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',tooSmall,{filename:'small.png',contentType:'image/png'}).expect(422);
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',photo,{filename:'replacement.jpg',contentType:'image/jpeg'}).expect(302);
  assets=await db.collection('customeravatars').find({userId:user._id}).toArray();assert.equal(assets.filter(row=>row.current).length,1);assert.equal(assets.find(row=>String(row._id)===String(current._id)).status,'pending_delete');
  await agent.post('/account/avatar/delete').type('form').send({_csrf:csrf}).expect(302);await agent.get('/account/avatar').expect(404);
  assert.equal(await db.collection('customeravatars').countDocuments({userId:user._id,current:true}),0);assert.equal(await db.collection('customeravatars').countDocuments({userId:user._id,status:'pending_delete'}),2);
}));

test('avatar physical cleanup reclaims crashed worker leases and abandoned staging objects', {skip:!uri||process.env.MEDIA_STORAGE_DRIVER==='r2'}, async()=>withDatabase(async db=>{
  const {putMediaObject,readMediaObjectBuffer}=await import('../src/services/object-storage.js');
  const {processCustomerAvatarCleanup}=await import('../src/services/customer-avatars.js');
  const userId=new mongoose.Types.ObjectId(),keys=[`avatar-recovery-tests/${suffix()}.cmv`,`avatar-recovery-tests/${suffix()}.cmv`,`avatar-recovery-tests/${suffix()}.cmv`];
  for(const key of keys)await putMediaObject(key,Buffer.from('durable-private-test-object'));
  await db.collection('customeravatars').insertMany(keys.map((storageKey,index)=>({publicId:id('avt'),userId,storageKey,mimeType:'image/webp',sizeBytes:34,width:320,height:320,checksumSha256:'a'.repeat(64),current:false,status:['staged','deleting','deleted'][index],cleanupAfter:new Date(0),lockedUntil:index===1?new Date(0):null,leaseToken:index===1?'crashed-worker':'',attempts:0,createdAt:new Date(),updatedAt:new Date()})));
  await processCustomerAvatarCleanup({workerId:'verification-avatar-recovery',limit:100});
  const rows=await db.collection('customeravatars').find({userId}).toArray();assert.equal(rows.length,3);assert.ok(rows.every(row=>row.status==='deleted'&&!row.current));
  for(const key of keys)await assert.rejects(readMediaObjectBuffer(key),{code:'MEDIA_OBJECT_NOT_FOUND'});
}));
