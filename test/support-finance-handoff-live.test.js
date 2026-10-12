import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

const suffix=crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV='test';process.env.SIMPLE_LOGIN='false';process.env.PRIVILEGED_MFA_REQUIRED='true';
process.env.MAIL_MODE='log';process.env.SMS_MODE='log';process.env.REDIS_URL='';
process.env.UPLOAD_DIR=`/tmp/classicmart-support-finance-media-${suffix}`;process.env.MEDIA_STORAGE_DRIVER='filesystem';
for(const name of ['SESSION_SECRET','TOKEN_PEPPER','SECURITY_INTEGRITY_KEY','DATA_ENCRYPTION_KEY'])process.env[name]=crypto.randomBytes(32).toString('hex');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;if(uri)process.env.MONGO_URI=uri;
const csrf=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('An actual inspected Support return binds one Finance refund and closes only after independent accounting', {skip:!uri,timeout:180000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/verification|test/i);
  await mongoose.connect(uri,{dbName:`classicmart_support_finance_handoff_test_${suffix}`});const transports=[];
  try{
    const {createApp}=await import('../src/app.js');
    const {User,PlatformGrant,CountrySetting,Store,Category,Product,ProductVariant,Warehouse,StockItem,Order,SellerOrder,Shipment,
      ReturnRequest,WarehouseTask,Refund,Notification,AuditLog,SellerReturnCase,PaymentIntent,LedgerTransaction,FinancialDocument,Dispute}=await import('../src/models/index.js');
    const cases=await import('../src/services/support-case-pages.js');
    const {createRefund,completeManualRefund}=await import('../src/services/payments.js');
    const {requestFinanceRefund,loadFinancePaymentPage}=await import('../src/services/finance-payment-pages.js');
    const {mutateWarehouse}=await import('../src/services/warehouse-operations.js');
    const {ensureLedgerAccount,postLedgerTransaction,accountBalanceMinor}=await import('../src/services/money.js');
    const {hashPassword}=await import('../src/core/crypto.js'),{encryptSensitive}=await import('../src/core/sensitive.js'),{totpCode}=await import('../src/services/mfa.js');
    await Promise.all(Object.values(mongoose.models).map(Model=>Model.init()));
    await CountrySetting.create([{code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'},
      {code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254'}]);
    let sequence=0;const id=kind=>`${kind}_sf_${suffix}_${++sequence}`,secret='JBSWY3DPEHPK3PXP',password=`Handoff-${suffix}-A1!`,passwordHash=await hashPassword(password),app=createApp(null);
    async function actor(role,{country='UG',managedRole='',login=false}={}){
      const number=++sequence,email=`handoff-${suffix}-${number}@example.com`,phone='+25670'+String(number).padStart(7,'0');
      const user=await User.create({publicId:id('usr'),name:`Handoff actor ${number}`,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,country,currency:country==='UG'?'UGX':'KES',locale:'en-UG',operationalCountries:[country],emailVerifiedAt:new Date(),onboardingCompletedAt:new Date(),platformAccessManagedAt:managedRole?new Date():undefined,
        security:{mfaEnabled:true,mfaSecretEncrypted:encryptSensitive(secret)},consents:{terms:true,privacy:true,recordedAt:new Date()}});
      const grant=managedRole?await PlatformGrant.create({publicId:id('pgr'),userId:user._id,role:managedRole,operationalCountries:[country],status:'active',startsAt:new Date(Date.now()-60000),expiresAt:new Date(Date.now()+86400000),reason:'End-to-end inspected goods handoff',approvalPublicId:id('apr'),approvedByUserId:new mongoose.Types.ObjectId()}):null;
      let client;if(login){const transport=new http.Agent({localAddress:`127.0.0.${number%100+100}`,keepAlive:false});transports.push(transport);client=request.agent(app).use(req=>req.agent(transport));
        const page=await client.get('/login').expect(200);await client.post('/login').type('form').send({email,password,_csrf:csrf(page.text)}).expect(302).expect('location','/mfa');
        const challenge=await client.get('/mfa').expect(200);await client.post('/mfa').type('form').send({code:totpCode(secret),_csrf:csrf(challenge.text)}).expect(302);}
      return {user,grant,client};
    }
    const buyer=await actor('customer',{login:true}),seller=await actor('seller'),support=await actor('customer',{managedRole:'support',login:true}),warehouseActor=await actor('customer',{managedRole:'warehouse',login:true}),finance=await actor('customer',{managedRole:'finance',login:true}),second=await actor('finance',{login:true}),foreign=await actor('finance',{country:'KE'});
    const req=(entry=finance,query={})=>({id:id('req'),user:entry.user,session:{tokenVersion:entry.user.security.tokenVersion},query,country:{code:'KE'},ip:'127.0.0.1',get:()=> 'SupportFinanceHandoff/1.0'});
    const category=await Category.create({publicId:id('cat'),name:'Handoff goods',slug:id('category'),countries:['UG']});
    const store=await Store.create({publicId:id('sto'),ownerUserId:seller.user._id,name:'Handoff store',slug:id('store'),country:'UG',currency:'UGX',status:'verified'});
    const product=await Product.create({publicId:id('prd'),storeId:store._id,ownerUserId:seller.user._id,categoryId:category._id,title:'Received return goods',slug:id('product'),description:'End-to-end exact line fixture',countries:['UG'],status:'published'});
    const variant=await ProductVariant.create({publicId:id('var'),productId:product._id,storeId:store._id,sku:id('sku').toUpperCase(),title:'Standard',priceMinor:10000,costMinor:5000,currency:'UGX'});
    const warehouse=await Warehouse.create({publicId:id('whs'),storeId:store._id,ownerUserId:seller.user._id,name:'Goods receiving warehouse',country:'UG',city:'Kampala',address:'Actual fixture warehouse'});
    const stock=await StockItem.create({publicId:id('stk'),storeId:store._id,warehouseId:warehouse._id,variantId:variant._id,onHand:5,reserved:0,damaged:0,quarantined:0});
    await PlatformGrant.updateOne({_id:warehouseActor.grant._id},{$set:{warehouseScopes:[warehouse.publicId]}});
    const lineId=id('oli'),orderId=id('ord');
    const order=await Order.create({publicId:orderId,idempotencyKey:id('checkout'),checkoutId:id('checkout'),cartPublicId:id('crt'),sessionKey:id('session'),userId:buyer.user._id,country:'UG',status:'paid',paymentState:'paid',fulfillmentState:'delivered',deliveryMethod:'standard',paymentMethod:'cod',
      contact:{fullName:'BUYER_NAME_PRIVATE',email:buyer.user.email,phone:buyer.user.phone,address:'BUYER_ADDRESS_PRIVATE',city:'Kampala',country:'UG'},totals:{subtotalMinor:20000,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:20000,currency:'UGX'},reservationExpiresAt:new Date(Date.now()+86400000),
      items:[{linePublicId:lineId,productId:product._id,variantId:variant._id,storeId:store._id,reservationPublicId:id('rsv'),productPublicId:product.publicId,variantPublicId:variant.publicId,storePublicId:store.publicId,title:product.title,variantTitle:variant.title,sku:variant.sku,quantity:2,deliveredQuantity:2,unitPriceMinor:10000,lineTotalMinor:20000,currency:'UGX'}]});
    const shipment=await Shipment.create({publicId:id('shp'),orderId:order._id,orderPublicId:order.publicId,country:'UG',kind:'outbound',mode:'standard',status:'delivered',deliveredAt:new Date(),proof:{type:'otp',reference:'verified',recordedAt:new Date()},cod:{required:true,amountMinor:20000,currency:'UGX',collectedMinor:20000,reconciledAt:new Date()}});
    await SellerOrder.create({publicId:id('sord'),orderId:order._id,orderPublicId:order.publicId,storeId:store._id,storePublicId:store.publicId,country:'UG',status:'fulfilled',subtotalMinor:20000,platformFeeMinor:1000,currency:'UGX',items:[{orderLineId:lineId,productPublicId:product.publicId,variantPublicId:variant.publicId,title:product.title,variantTitle:variant.title,sku:variant.sku,quantity:2,unitPriceMinor:10000,lineTotalMinor:20000,currency:'UGX',grossMinor:20000,customerPaidMinor:20000,platformFeeMinor:1000,sellerReceivableMinor:19000}]});
    const payment=await PaymentIntent.create({publicId:id('pay'),orderId:order._id,orderPublicId:order.publicId,country:'UG',currency:'UGX',idempotencyKey:id('payment'),provider:'cod',method:'cod',status:'succeeded',amountMinor:20000,paidAt:new Date()});
    const clearing=await ensureLedgerAccount({code:'cod_clearing',type:'asset',ownerType:'platform',ownerPublicId:'classic-mart',country:'UG',currency:'UGX'}),payable=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerPublicId:store.publicId,country:'UG',currency:'UGX'}),revenue=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country:'UG',currency:'UGX'});
    await postLedgerTransaction({idempotencyKey:'cod:'+shipment.publicId,referenceType:'cod_reconciliation',referencePublicId:shipment.publicId,country:'UG',currency:'UGX',description:'Verified captured COD fixture',entries:[{account:clearing,debitMinor:20000,creditMinor:0},{account:payable,debitMinor:0,creditMinor:19000},{account:revenue,debitMinor:0,creditMinor:1000}]});
    let returned,recorded,body,inspectionTask;
    const returnVersion=async()=>Number((await ReturnRequest.findById(returned._id)).__v||0);
    async function supportAction(action,input){const page=await support.client.get('/support/returns?record='+returned.publicId).expect(200);return support.client.post('/support/returns/'+returned.publicId+'/'+action).set('x-csrf-token',csrf(page.text)).set('accept','application/json').send(input).expect(200);}
    await t.test('buyer opens its own delivered line and Finance cannot reserve before actual receipt and inspection',async()=>{
      const page=await buyer.client.get('/returns').expect(200);
      const result=await buyer.client.post('/api/v1/returns').set('x-csrf-token',csrf(page.text)).send({orderId:order.publicId,items:[{orderLineId:lineId,quantity:1}],reason:'damaged',details:'One delivered unit needs an evidenced goods return.',resolution:'refund',returnMethod:'dropoff'}).expect(201);returned=await ReturnRequest.findOne({publicId:result.body.returnRequest.publicId});assert.ok(returned);
      await assert.rejects(createRefund(req(),{orderId:order.publicId,reason:'Return refund review',idempotencyKey:'return-refund:'+returned.publicId,returnPublicId:returned.publicId,returnVersion:returned.__v}),error=>error.code==='RETURN_FINANCE_SNAPSHOT_INVALID');
      assert.equal(await Refund.countDocuments(),0);assert.equal((await Order.findById(order._id)).items[0].returnReservedQuantity,1);
    });
    await t.test('approved goods get a sanitized per-line receipt and completed Warehouse inspection',async()=>{
      await supportAction('decision',{version:await returnVersion(),decision:'approve',note:'Exact delivered damaged goods approved for physical return receipt.'});
      const page=await warehouseActor.client.get('/warehouse/returns').expect(200),image=await sharp({create:{width:360,height:360,channels:3,background:'#ffffff'}}).png().toBuffer();
      const evidence=await warehouseActor.client.post('/api/v1/warehouse/returns/'+returned.publicId+'/intake-evidence').set('x-csrf-token',csrf(page.text)).field('version',String(await returnVersion())).field('orderLineId',lineId).field('warehousePublicId',warehouse.publicId).attach('document',image,'return-receipt.png').expect(201);
      const intake=await warehouseActor.client.post('/api/v1/warehouse/returns/'+returned.publicId+'/intake').set('x-csrf-token',csrf(page.text)).send({version:evidence.body.version,orderLineId:lineId,warehousePublicId:warehouse.publicId,evidencePublicId:evidence.body.evidencePublicId}).expect(200);
      assert.equal(intake.body.status,'received');assert.equal((await StockItem.findById(stock._id)).onHand,5);inspectionTask=await WarehouseTask.findOne({returnRequestId:returned._id});assert.ok(inspectionTask);
      await mutateWarehouse({...req(warehouseActor),params:{publicId:inspectionTask.publicId},body:{version:inspectionTask.__v}},'claim');const claimed=await WarehouseTask.findById(inspectionTask._id);
      await mutateWarehouse({...req(warehouseActor),params:{publicId:inspectionTask.publicId},body:{version:claimed.__v,disposition:'damaged'}},'execute');assert.equal((await StockItem.findById(stock._id)).onHand,6);assert.equal((await StockItem.findById(stock._id)).damaged,1);
      await supportAction('inspect',{version:await returnVersion(),condition:'damaged',notes:'Exact physically received unit matches the completed damaged Warehouse inspection.'});
      await supportAction('refer-finance',{version:await returnVersion(),note:'PRIVATE_FINANCE_REFERRAL_NOTE: Completed receipt and exact inspection ready for an independent financial refund.'});assert.equal((await ReturnRequest.findById(returned._id)).status,'refund_pending');assert.equal(await Refund.countDocuments(),0);
      const buyerView=await buyer.client.get('/returns').expect(200);assert.ok(buyerView.text.includes(returned.publicId));assert.doesNotMatch(buyerView.text,/PRIVATE_FINANCE_REFERRAL_NOTE/);
      const {loadCustomerDashboardPage}=await import('../src/dashboard/customer-data.js');const buyerData=await loadCustomerDashboardPage(req(buyer),'returns');
      assert.ok(JSON.stringify(buyerData).includes(returned.publicId));assert.doesNotMatch(JSON.stringify(buyerData),/PRIVATE_FINANCE_REFERRAL_NOTE|requestedByUserId|warehouseInspectedByUserId|intakeReceivedByUserId/);
    });
    await t.test('Finance sees immutable inspected amount and line allocation without private case or buyer fields',async()=>{
      const page=await finance.client.get('/finance/refunds?return='+returned.publicId).expect(200);assert.match(page.text,/Inspected return referral/);assert.match(page.text,/name="returnPublicId"/);assert.match(page.text,/name="returnVersion"/);assert.match(page.text,/name="amountMinor" value="10000"/);assert.ok(!page.text.includes('name="amountMinor" type="number"'));
      const flow=await loadFinancePaymentPage(req(finance,{return:returned.publicId}),'finance-refunds');assert.equal(flow.refundOrder.returnAmountMinor,10000);assert.equal(flow.refundOrder.items.length,1);assert.equal(flow.refundOrder.items[0].orderLineId,lineId);assert.equal(flow.idempotencyKey,'return-refund:'+returned.publicId);
      for(const secretValue of [buyer.user.email,'BUYER_NAME_PRIVATE','BUYER_ADDRESS_PRIVATE','Completed receipt and exact inspection ready'])assert.ok(!JSON.stringify(flow).includes(secretValue),secretValue);
      await assert.rejects(loadFinancePaymentPage(req(foreign,{return:returned.publicId}),'finance-refunds'),error=>error.status===404);
      body={orderId:order.publicId,reason:'Independently reviewed inspected goods refund',idempotencyKey:flow.idempotencyKey,version:flow.refundOrder.payment.version,returnPublicId:returned.publicId,returnVersion:flow.refundOrder.returnVersion,amountMinor:10000,['line:'+lineId]:'10000'};
      await finance.client.post('/finance/refunds').send(body).expect(403);
    });
    await t.test('exact amount, original lines, current versions, referral and active Finance permission fence reservations',async()=>{
      await assert.rejects(requestFinanceRefund(req(),{...body,amountMinor:9999}),error=>error.code==='RETURN_REFUND_ALLOCATION_MISMATCH');
      await assert.rejects(requestFinanceRefund(req(),{...body,['line:'+lineId]:'9999'}),error=>error.code==='RETURN_REFUND_ALLOCATION_MISMATCH');
      await assert.rejects(requestFinanceRefund(req(),{...body,returnVersion:999}),error=>error.code==='RETURN_REFUND_VERSION_CONFLICT');
      await assert.rejects(requestFinanceRefund(req(),{...body,version:999}),error=>error.code==='REFUND_VERSION_CONFLICT');
      await assert.rejects(createRefund(req(support),{...body,allocations:[]}),error=>error.status===403);
      await assert.rejects(createRefund(req(foreign),{...body,allocations:[]}),error=>error.status===403);
      await assert.rejects(createRefund(req(),{...body,returnPublicId:undefined,returnVersion:undefined,allocations:[]}),error=>error.code==='RETURN_REFUND_KEY_INVALID');
      assert.equal(await Refund.countDocuments(),0);assert.equal((await PaymentIntent.findById(payment._id)).refundReservedMinor,0);
    });
    await t.test('transaction audit failure rolls back the immutable binding, status, record, counters and notices',async()=>{
      const before=await ReturnRequest.findById(returned._id).lean(),notices=await Notification.countDocuments();const mock=t.mock.method(AuditLog,'create',async()=>{throw new Error('Handoff audit unavailable');});
      try{await assert.rejects(requestFinanceRefund(req(),body),/Handoff audit unavailable/);}finally{mock.mock.restore();}
      assert.equal(await Refund.countDocuments(),0);assert.equal((await PaymentIntent.findById(payment._id)).refundReservedMinor,0);const current=await ReturnRequest.findById(returned._id);assert.equal(current.status,'refund_pending');assert.equal(current.refundPublicId,undefined);assert.equal(current.__v,before.__v);assert.equal(await Notification.countDocuments(),notices);
    });
    await t.test('concurrent idempotent requests reserve one refund and leave the return awaiting real disbursement',async()=>{
      const responses=await Promise.all([requestFinanceRefund(req(),body),requestFinanceRefund(req(),body)]);recorded=responses[0];assert.equal(responses[1].publicId,recorded.publicId);
      const refund=await Refund.findOne({publicId:recorded.publicId}),current=await ReturnRequest.findById(returned._id);assert.equal(String(refund.returnRequestId),String(returned._id));assert.equal(refund.returnPublicId,returned.publicId);assert.equal(refund.amountMinor,10000);assert.equal(refund.allocations[0].grossMinor,10000);assert.equal(refund.allocations[0].platformFeeMinor,500);assert.equal(refund.allocations[0].sellerReceivableMinor,9500);assert.equal(current.refundPublicId,recorded.publicId);assert.equal(current.status,'refund_processing');
      assert.equal(await Refund.countDocuments({returnRequestId:returned._id}),1);assert.equal((await PaymentIntent.findById(payment._id)).refundReservedMinor,10000);assert.equal(await LedgerTransaction.countDocuments({referencePublicId:recorded.publicId}),0);assert.equal((await Order.findById(order._id)).items[0].refundedQuantity,0);
      const page=await finance.client.get('/finance/refunds?return='+returned.publicId).expect(200);assert.match(page.text,/Refund details/);assert.ok(!page.text.includes('name="returnVersion"'));assert.match(page.text,/different finance operator/);
      await assert.rejects(requestFinanceRefund(req(second),body),error=>error.code==='REFUND_IDEMPOTENCY_CONFLICT');
    });
    await t.test('tampered physical inspection and accounting audit failures cannot consume funds or close a return',async()=>{
      await WarehouseTask.updateOne({_id:inspectionTask._id},{$set:{'result.disposition':'good'}});await assert.rejects(completeManualRefund(req(second),recorded.publicId,{reference:'actual-independent-disbursement'}),error=>error.code==='RETURN_FINANCE_SNAPSHOT_INVALID');await WarehouseTask.updateOne({_id:inspectionTask._id},{$set:{'result.disposition':'damaged'}});
      const mock=t.mock.method(AuditLog,'create',async()=>{throw new Error('Accounting audit unavailable');});try{await assert.rejects(completeManualRefund(req(second),recorded.publicId,{reference:'actual-independent-disbursement'}),/Accounting audit unavailable/);}finally{mock.mock.restore();}
      assert.equal((await ReturnRequest.findById(returned._id)).status,'refund_processing');assert.equal((await Refund.findOne({publicId:recorded.publicId})).status,'processing');assert.equal((await PaymentIntent.findById(payment._id)).refundReservedMinor,10000);assert.equal((await PaymentIntent.findById(payment._id)).refundedMinor,0);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+recorded.publicId}),0);assert.equal((await Order.findById(order._id)).items[0].refundedQuantity,0);
    });
    await t.test('a different operator confirms disbursement, posts exact settlement and updates buyer and seller cases atomically',async()=>{
      await assert.rejects(completeManualRefund(req(),recorded.publicId,{reference:'actual-independent-disbursement'}),error=>error.code==='FOUR_EYES_REQUIRED');
      const page=await second.client.get('/finance/refunds?record='+recorded.publicId).expect(200),token=csrf(page.text);await second.client.post('/finance/refunds/'+recorded.publicId+'/complete').set('x-csrf-token',token).send({version:999,reference:'actual-independent-disbursement'}).expect(409);
      const refund=await Refund.findOne({publicId:recorded.publicId});await second.client.post('/finance/refunds/'+recorded.publicId+'/complete').set('x-csrf-token',token).set('accept','application/json').send({version:refund.__v,reference:'actual-independent-disbursement'}).expect(200);
      const current=await ReturnRequest.findById(returned._id),paid=await PaymentIntent.findById(payment._id);assert.equal(current.status,'refunded');assert.equal(paid.refundReservedMinor,0);assert.equal(paid.refundedMinor,10000);assert.equal(paid.status,'partially_refunded');assert.equal((await Order.findById(order._id)).items[0].refundedQuantity,1);assert.equal((await SellerReturnCase.findOne({returnRequestId:returned._id})).status,'resolved');assert.equal(await accountBalanceMinor(payable._id,null,'liability'),9500);assert.equal(await accountBalanceMinor(revenue._id,null,'revenue'),500);
      assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+recorded.publicId}),1);assert.equal(await FinancialDocument.countDocuments({refundPublicId:recorded.publicId,type:'refund_credit_note'}),1);assert.equal(await AuditLog.countDocuments({action:'finance.return_refund_completed',targetPublicId:returned.publicId}),1);assert.equal(await Notification.countDocuments({userId:buyer.user._id,type:'return_update',title:'Return refund completed'}),1);
      const buyerPage=await buyer.client.get('/returns').expect(200);assert.ok(buyerPage.text.includes(returned.publicId));assert.match(buyerPage.text,/refunded/i);
    });
    await t.test('completed retries cannot double settle returned quantity, commissions, documents or ledger entries',async()=>{
      await completeManualRefund(req(second),recorded.publicId,{reference:'actual-independent-disbursement'});const retry=await requestFinanceRefund(req(),body);assert.equal(retry.publicId,recorded.publicId);assert.equal(retry.status,'completed');assert.equal(await Refund.countDocuments({returnRequestId:returned._id}),1);assert.equal((await Order.findById(order._id)).items[0].refundedQuantity,1);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+recorded.publicId}),1);assert.equal(await FinancialDocument.countDocuments({refundPublicId:recorded.publicId,type:'refund_credit_note'}),1);
      await assert.rejects(requestFinanceRefund(req(),{...body,reason:'Changed binding reason'}),error=>error.code==='REFUND_IDEMPOTENCY_CONFLICT');
      await assert.rejects(completeManualRefund(req(second),recorded.publicId,{reference:'changed-disbursement-reference'}),error=>error.code==='REFUND_COMPLETION_CONFLICT');
      const page=await loadFinancePaymentPage(req(finance,{return:returned.publicId}),'finance-refunds');assert.equal(page.returnContext.status,'refunded');assert.equal(page.refundOrder,null);assert.equal(page.selected.publicId,recorded.publicId);
    });
    await t.test('Finance payment context contains public referred order facts and excludes internal Support notes',async()=>{
      const dispute=await Dispute.create({publicId:id('dsp'),userId:buyer.user._id,orderId:order._id,orderPublicId:order.publicId,country:'UG',category:'refund',subject:'Actual order refund follow-up',description:'Customer asks about the confirmed partial goods refund.',status:'investigating',review:{notes:'SUPPORT_REVIEW_PRIVATE'},escalation:{department:'finance',reason:'SUPPORT_ESCALATION_PRIVATE',escalatedAt:new Date(),referralTicketPublicId:id('tkt')},events:[{type:'dispute.reviewed',message:'SUPPORT_INTERNAL_NOTE_PRIVATE',visibility:'internal'},{type:'dispute.customer_update',message:'Finance is reviewing the recorded refund.',visibility:'customer'}]});
      const flow=await loadFinancePaymentPage(req(finance,{record:payment.publicId}),'finance-payments');assert.equal(flow.referredDisputes.length,1);assert.equal(flow.referredDisputes[0].publicId,dispute.publicId);assert.equal(flow.referredDisputes[0].updates.length,1);for(const secretValue of ['SUPPORT_REVIEW_PRIVATE','SUPPORT_ESCALATION_PRIVATE','SUPPORT_INTERNAL_NOTE_PRIVATE',buyer.user.email])assert.ok(!JSON.stringify(flow).includes(secretValue));
      const page=await finance.client.get('/finance/payments?record='+payment.publicId).expect(200);assert.match(page.text,/Referred order case/);assert.ok(page.text.includes(dispute.publicId));assert.ok(!page.text.includes('/support/escalations'));
      await PlatformGrant.updateOne({_id:finance.grant._id},{$set:{status:'revoked'}});await assert.rejects(requestFinanceRefund(req(),body),error=>error.code==='FINANCE_GRANT_UNAVAILABLE');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+recorded.publicId}),1);
    });
    await t.test('read-only rollout preflight reports legacy pending bindings and imported duplicate case refunds without rewriting history',async()=>{
      const {returnRefundBindingConflicts}=await import('../src/services/return-refund-preflight.js');
      const clean=await returnRefundBindingConflicts();assert.equal(clean.pendingUnboundReturns,0);assert.equal(clean.bindingCollisionGroups,0);
      const saved=await Refund.findOne({publicId:recorded.publicId}).lean(),current=await ReturnRequest.findById(returned._id).lean(),legacyReturnId=new mongoose.Types.ObjectId(),legacyRefundId=new mongoose.Types.ObjectId(),collisionId=new mongoose.Types.ObjectId();
      const legacyRefund={...saved,_id:legacyRefundId,publicId:id('rfd'),idempotencyKey:id('legacy_refund'),status:'processing'};delete legacyRefund.returnRequestId;delete legacyRefund.returnPublicId;
      const legacyReturn={...current,_id:legacyReturnId,publicId:id('ret'),status:'refund_processing',refundPublicId:legacyRefund.publicId};
      try{
        await ReturnRequest.collection.insertOne(legacyReturn);await Refund.collection.insertOne(legacyRefund);
        const legacy=await returnRefundBindingConflicts();assert.equal(legacy.pendingUnboundReturns,1);assert.equal(legacy.pendingExamples[0].returnPublicId,legacyReturn.publicId);assert.equal(legacy.pendingExamples[0].refundPublicId,legacyRefund.publicId);
        // Only this guarded disposable database loses the index, to represent corruption
        // imported before the new uniqueness constraint can be installed.
        await Refund.collection.dropIndex('returnRequestId_1');const duplicate={...saved,_id:collisionId,publicId:id('rfd'),idempotencyKey:id('collision_refund')};await Refund.collection.insertOne(duplicate);
        const conflicts=await returnRefundBindingConflicts();assert.equal(conflicts.bindingCollisionGroups,1);assert.equal(conflicts.collidingRefunds,2);assert.ok(conflicts.collisionExamples[0].refundPublicIds.includes(recorded.publicId));assert.ok(conflicts.collisionExamples[0].refundPublicIds.includes(duplicate.publicId));
        for(const secretValue of [buyer.user.email,'BUYER_NAME_PRIVATE','BUYER_ADDRESS_PRIVATE','actual-independent-disbursement'])assert.ok(!JSON.stringify(conflicts).includes(secretValue));
        assert.equal((await ReturnRequest.findById(legacyReturnId)).status,'refund_processing');assert.equal((await Refund.findById(legacyRefundId)).returnRequestId,undefined);assert.equal((await Refund.findById(collisionId)).amountMinor,saved.amountMinor);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+recorded.publicId}),1);
      }finally{await Refund.collection.deleteMany({_id:{$in:[legacyRefundId,collisionId]}});await ReturnRequest.collection.deleteOne({_id:legacyReturnId});await Refund.createIndexes();}
    });
  }finally{for(const transport of transports)transport.destroy();await mongoose.connection.dropDatabase();await mongoose.disconnect();await fs.rm(process.env.UPLOAD_DIR,{recursive:true,force:true});}
});
