import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';
process.env.NODE_ENV='test';process.env.SIMPLE_LOGIN='false';process.env.PRIVILEGED_MFA_REQUIRED='true';process.env.MAIL_MODE='log';process.env.SMS_MODE='log';process.env.REDIS_URL='';
process.env.PESAPAL_BASE_URL='https://finance-payment-test.invalid';process.env.PESAPAL_CONSUMER_KEY=crypto.randomBytes(16).toString('hex');process.env.PESAPAL_CONSUMER_SECRET=crypto.randomBytes(32).toString('hex');
for(const name of ['SESSION_SECRET','TOKEN_PEPPER','SECURITY_INTEGRITY_KEY','DATA_ENCRYPTION_KEY'])process.env[name]=crypto.randomBytes(32).toString('hex');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;if(uri)process.env.MONGO_URI=uri;
const csrf=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];
test('Finance CSV neutralizes formulas after whitespace and quotes fields',async()=>{const {financeCsvCell}=await import('../src/services/finance-payment-pages.js');assert.equal(financeCsvCell(' \t=1+1'),'"\' \t=1+1"');assert.equal(financeCsvCell('a"b'),'"a""b"');assert.equal(financeCsvCell('ordinary'),'"ordinary"');});
test('Finance payments and refunds enforce scoped evidence, reservations and independent completion',{skip:!uri,timeout:120000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/verification|test/i);
  const suffix=crypto.randomBytes(8).toString('hex');await mongoose.connect(uri,{dbName:'classicmart_finance_payments_test_'+suffix});
  const {User,CountrySetting,PaymentIntent,Refund,Order,SellerOrder,Shipment,LedgerTransaction,LedgerAccount,AuditLog,FinancialDocument,PlatformGrant,Notification,Chargeback}=await import('../src/models/index.js');
  const {createApp}=await import('../src/app.js'),{hashPassword}=await import('../src/core/crypto.js'),{beginMfaEnrollment,confirmMfaEnrollment,totpCode}=await import('../src/services/mfa.js');
  const {ensureLedgerAccount,postLedgerTransaction,accountBalanceMinor}=await import('../src/services/money.js');
  const {createRefund,completeManualRefund,verifyAndApplyPayment}=await import('../src/services/payments.js');
  const {requestFinanceRefund,completeFinanceRefund,loadFinancePaymentPage,streamFinancePaymentCsv}=await import('../src/services/finance-payment-pages.js');
  const app=createApp(null),password='Finance-'+suffix+'-A1!',passwordHash=await hashPassword(password),transports=[];let sequence=0;
  const context=entry=>({user:entry.user,session:{tokenVersion:entry.user.security.tokenVersion},query:{},id:'req_finance_'+suffix+'_'+(++sequence),ip:'127.0.0.1',get:()=>''});
  async function actor(role='finance',countries=['UG'],mfa=true){
    const index=++sequence,email='finance-payments-'+suffix+'-'+index+'@example.com',phone='+25670'+String(index).padStart(7,'0');
    let user=await User.create({publicId:'usr_fp_'+suffix+'_'+index,name:'Finance '+index,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,country:countries[0],currency:'UGX',locale:'en-UG',operationalCountries:countries,emailVerifiedAt:new Date(),onboardingCompletedAt:new Date(),consents:{terms:true,privacy:true,recordedAt:new Date()}});
    let codes=[];if(mfa){const pending=await beginMfaEnrollment(user._id,password),confirmed=await confirmMfaEnrollment(user._id,totpCode(pending.secret));user=confirmed.user;codes=confirmed.codes;}
    const transport=new http.Agent({localAddress:'127.0.0.'+(index+5),keepAlive:false});transports.push(transport);const client=request.agent(app).use(req=>req.agent(transport));
    const login=await client.get('/login').expect(200);await client.post('/login').type('form').send({email,password,_csrf:csrf(login.text)}).expect(302);
    if(mfa){const challenge=await client.get('/mfa').expect(200);await client.post('/mfa').type('form').send({code:codes[0],_csrf:csrf(challenge.text)}).expect(302);}
    return{user,client};
  }
  async function fixture({country='UG',currency='UGX',provider='cod',amount=10000,status='succeeded',owner=null,settlement=false,lines=false}={}){
    const index=++sequence,orderId='ord_fp_'+suffix+'_'+index,paymentId='pay_fp_'+suffix+'_'+index,lineId='lin_fp_'+index,storeId='sto_fp_'+index;
    const order=await Order.create({publicId:orderId,idempotencyKey:'order_key_'+orderId,checkoutId:'checkout_'+orderId,cartPublicId:'crt_'+orderId,sessionKey:'session_'+orderId,userId:owner?._id,country,deliveryMethod:'standard',reservationExpiresAt:new Date(Date.now()+86400000),paymentMethod:provider==='cod'?'cod':provider==='wallet'?'wallet':'card',status:status==='succeeded'?'paid':'pending_payment',paymentState:status==='succeeded'?'paid':'unpaid',contact:{fullName:'BUYER_FULL_NAME_PRIVATE',email:'private-buyer@example.com',phone:'+256700111222',address:'BUYER_ADDRESS_PRIVATE',city:'Kampala',country},totals:{subtotalMinor:amount,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:amount,currency},items:[{linePublicId:lineId,productId:new mongoose.Types.ObjectId(),variantId:new mongoose.Types.ObjectId(),storeId:new mongoose.Types.ObjectId(),reservationPublicId:'irs_fp_'+index,productPublicId:'prd_fp_'+index,variantPublicId:'var_fp_'+index,storePublicId:storeId,title:'Purchased item',variantTitle:'Standard',sku:'SKU_FP_'+index,quantity:1,unitPriceMinor:amount,lineTotalMinor:amount,currency}],timeline:[]});
    const intent=await PaymentIntent.create({publicId:paymentId,orderId:order._id,orderPublicId:orderId,country,currency,idempotencyKey:'payment_key_'+paymentId,provider,method:provider==='cod'?'cod':provider==='wallet'?'wallet':'card',status,amountMinor:amount,paidAt:status==='succeeded'?new Date():undefined,providerTrackingId:provider==='pesapal'?'tracking_'+paymentId:undefined,providerReference:paymentId,providerConfirmationCode:provider==='pesapal'?'CONFIRMATION_PRIVATE_'+index:undefined,lastVerifiedAt:provider==='pesapal'?new Date():undefined,providerStatus:provider==='pesapal'?'COMPLETED':'',checkoutUrl:'https://checkout.example.com/CHECKOUT_SECRET_PRIVATE',failureMessage:'PROVIDER_RAW_PRIVATE'});
    let payable=null,revenue=null;
    if(settlement){
      const clearing=await ensureLedgerAccount({code:provider==='cod'?'cod_clearing':'provider_clearing',type:'asset',ownerType:provider==='cod'?'platform':'provider',ownerPublicId:provider==='cod'?'classic-mart':'pesapal',country,currency});
      revenue=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country,currency});
      let key='payment:'+paymentId,type='payment';if(provider==='cod'){const shipment=await Shipment.create({publicId:'shp_fp_'+index,orderId:order._id,orderPublicId:orderId,country,mode:'standard',status:'delivered',deliveredAt:new Date(),cod:{required:true,amountMinor:amount,currency,collectedMinor:amount,reconciledAt:new Date()}});key='cod:'+shipment.publicId;type='cod_reconciliation';}
      const entries=[{account:clearing,debitMinor:amount,creditMinor:0}];
      if(lines){payable=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerPublicId:storeId,country,currency});entries.push({account:revenue,debitMinor:0,creditMinor:1000},{account:payable,debitMinor:0,creditMinor:amount-1000});await SellerOrder.collection.insertOne({_id:new mongoose.Types.ObjectId(),publicId:'sord_fp_'+index,orderId:order._id,storePublicId:storeId,status:'fulfilled',items:[{orderLineId:lineId,variantPublicId:'var_fp_'+index,customerPaidMinor:amount,platformFeeMinor:1000,sellerReceivableMinor:amount-1000}],createdAt:new Date(),updatedAt:new Date()});}
      else entries.push({account:revenue,debitMinor:0,creditMinor:amount});
      await postLedgerTransaction({idempotencyKey:key,referenceType:type,referencePublicId:provider==='cod'?orderId:paymentId,country,currency,description:'Captured fixture settlement',entries});
    }
    return{order,intent,lineId,storeId,payable,revenue};
  }
  try{
    for(const Model of Object.values(mongoose.connection.models))await Model.init();
    await CountrySetting.create([{code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'},{code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254'}]);
    const first=await actor(),second=await actor(),multi=await actor('finance',['UG','KE']),customer=await actor('customer',['UG'],false),noMfa=await actor('finance',['UG'],false);
    const paid=await fixture({settlement:true}),foreign=await fixture({country:'KE',currency:'KES',amount:500000}),partial=await fixture({settlement:true,lines:true}),pending=await fixture({provider:'pesapal',status:'pending'});
    const wrong=await fixture();await PaymentIntent.updateOne({_id:wrong.intent._id},{$set:{orderPublicId:'WRONG_ORDER_PRIVATE'}});
    await t.test('records, filters, country selectors and CSV contain safe DTOs and distinct currency totals',async()=>{
      const page=await first.client.get('/finance/payments').set('accept','application/json').expect(200);
      assert.equal(page.body.country,'UG');assert.equal(page.body.page.total,3);assert.equal(page.body.rows.length,3);const json=JSON.stringify(page.body);
      for(const secret of ['BUYER_FULL_NAME_PRIVATE','private-buyer@example.com','BUYER_ADDRESS_PRIVATE','CONFIRMATION_PRIVATE','CHECKOUT_SECRET_PRIVATE','PROVIDER_RAW_PRIVATE','providerTrackingId',foreign.intent.publicId,'WRONG_ORDER_PRIVATE'])assert.ok(!json.includes(secret),secret);
      const all=await multi.client.get('/finance/payments?country=').set('accept','application/json').expect(200);assert.equal(all.body.currency,null);assert.ok(all.body.metrics[0].value.includes('UGX'));assert.ok(all.body.metrics[0].value.includes('KES'));
      const html=await first.client.get('/finance/payments?record='+paid.intent.publicId).expect(200);assert.match(html.text,/Payment details/);assert.match(html.text,/Record refund/);assert.match(html.headers['cache-control'],/no-store/);assert.match(html.headers['x-robots-tag'],/noindex/);
      const csv=await first.client.get('/finance/payments/export.csv').expect(200);assert.ok(csv.text.includes(paid.intent.publicId));assert.ok(!csv.text.includes(foreign.intent.publicId));assert.ok(!csv.text.includes('private-buyer'));
      await first.client.get('/finance/payments?country=KE').set('accept','application/json').expect(403);
      await first.client.get('/finance/payments?record='+foreign.intent.publicId).set('accept','application/json').expect(404);
      await first.client.get('/finance/payments?status[]=succeeded').set('accept','application/json').expect(422);await first.client.get('/finance/payments?after=not-a-cursor').set('accept','application/json').expect(422);
      await first.client.get('/finance/payments?country=UG&country=KE').set('accept','application/json').expect(422);
    });
    await t.test('customer role and unenrolled operators cannot use Finance pages or core mutations',async()=>{
      await customer.client.get('/finance/payments').set('accept','application/json').expect(403);await noMfa.client.get('/finance/refunds').set('accept','application/json').expect(403);
      await assert.rejects(createRefund(context(noMfa),{orderId:paid.order.publicId,reason:'Test refund',idempotencyKey:'mfa_required_'+suffix}),error=>error.code==='MFA_ENROLLMENT_REQUIRED');
      await assert.rejects(createRefund(context(customer),{orderId:paid.order.publicId,reason:'Unsafe direct refund',idempotencyKey:'customer_refund_'+suffix}),error=>['ORDER_SCOPE','REFUND_CANCELLATION_REQUIRED'].includes(error.code));
    });
    let recorded;
    await t.test('CSRF, exact amounts and current payment versions protect refund reservation',async()=>{
      const page=await first.client.get('/finance/refunds?order='+paid.order.publicId).expect(200),token=csrf(page.text),body={orderId:paid.order.publicId,reason:'Approved refund',idempotencyKey:'refund_fp_'+suffix,version:paid.intent.__v};
      assert.match(page.text,/Remaining refundable balance/);assert.match(page.text,/class="primary-button"/);await first.client.post('/finance/refunds').type('form').send(body).expect(403);
      await first.client.post('/finance/refunds').type('form').send({...body,_csrf:token,amountMinor:10001}).expect(409);
      await first.client.post('/finance/refunds').type('form').send({...body,_csrf:token,version:999}).expect(409);
      const response=await first.client.post('/finance/refunds').set('accept','application/json').type('form').send({...body,_csrf:token}).expect(201);recorded=response.body.refund;assert.equal(recorded.status,'processing');assert.equal(recorded.amountMinor,10000);
      assert.equal((await PaymentIntent.findById(paid.intent._id)).refundReservedMinor,10000);assert.equal(await LedgerTransaction.countDocuments({referencePublicId:recorded.publicId}),0);
      assert.equal(await AuditLog.countDocuments({action:'finance.refund_reserved',targetPublicId:recorded.publicId}),1);assert.ok(await Notification.exists({type:'finance_work',href:'/finance/refunds?record='+recorded.publicId}));
      await first.client.post('/finance/refunds').set('accept','application/json').type('form').send({...body,_csrf:token}).expect(201);assert.equal(await Refund.countDocuments({idempotencyKey:body.idempotencyKey}),1);
      await first.client.post('/finance/refunds').type('form').send({...body,_csrf:token,reason:'Changed refund reason'}).expect(409);
      await assert.rejects(createRefund(context(first),{orderId:partial.order.publicId,reason:body.reason,idempotencyKey:body.idempotencyKey}),error=>error.code==='REFUND_IDEMPOTENCY_CONFLICT');
    });
    await t.test('manual completion uses a different current operator and posts one exact reversal atomically',async()=>{
      const page=await first.client.get('/finance/refunds?record='+recorded.publicId).expect(200);assert.match(page.text,/different finance operator/);
      await assert.rejects(completeManualRefund(context(first),recorded.publicId,{reference:'merchant-proof-1'}),error=>error.code==='FOUR_EYES_REQUIRED');
      const view=await second.client.get('/finance/refunds?record='+recorded.publicId).expect(200),token=csrf(view.text);assert.match(view.text,/Confirm refund completion/);
      await second.client.post('/finance/refunds/'+recorded.publicId+'/complete').type('form').send({_csrf:token,version:9,reference:'merchant-proof-1'}).expect(409);
      await second.client.post('/finance/refunds/'+recorded.publicId+'/complete').set('accept','application/json').type('form').send({_csrf:token,version:recorded.version,reference:'merchant-proof-1'}).expect(200);
      const latest=await PaymentIntent.findById(paid.intent._id);assert.equal(latest.refundReservedMinor,0);assert.equal(latest.refundedMinor,10000);assert.equal(latest.status,'refunded');
      assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+recorded.publicId}),1);assert.equal(await FinancialDocument.countDocuments({refundPublicId:recorded.publicId,type:'refund_credit_note'}),1);
      assert.equal(await AuditLog.countDocuments({action:'finance.refund_completed',targetPublicId:recorded.publicId}),1);
      const ledger=await LedgerTransaction.findOne({idempotencyKey:'refund:'+recorded.publicId}).lean();assert.equal(ledger.entries.reduce((sum,row)=>sum+row.debitMinor,0),10000);assert.equal(ledger.entries.reduce((sum,row)=>sum+row.creditMinor,0),10000);
      await completeManualRefund(context(second),recorded.publicId,{reference:'merchant-proof-1'});assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+recorded.publicId}),1);
      await assert.rejects(completeManualRefund(context(second),recorded.publicId,{reference:'changed-reference'}),error=>error.code==='REFUND_COMPLETION_CONFLICT');
    });
    await t.test('partial refunds consume immutable line settlement shares and reject fractional or missing allocations',async()=>{
      const body={orderId:partial.order.publicId,amountMinor:2500,reason:'Partial line refund',idempotencyKey:'partial_fp_'+suffix,version:partial.intent.__v};
      await assert.rejects(requestFinanceRefund(context(first),body),error=>error.code==='PARTIAL_REFUND_ALLOCATION_REQUIRED');
      await assert.rejects(createRefund(context(first),{...body,allocations:[{storePublicId:partial.storeId,orderLineId:partial.lineId,grossMinor:2500.2}]}),error=>error.code==='REFUND_ALLOCATION_INVALID');
      const refund=await requestFinanceRefund(context(first),{...body,['line:'+partial.lineId]:'2500'});await completeFinanceRefund(context(second),refund.publicId,{version:refund.version,reference:'partial-proof-1'});
      const saved=await Refund.findOne({publicId:refund.publicId});assert.equal(saved.allocations[0].platformFeeMinor,250);assert.equal(saved.allocations[0].sellerReceivableMinor,2250);
      assert.equal(await accountBalanceMinor(partial.payable._id,null,'liability'),6750);
      const intent=await PaymentIntent.findById(partial.intent._id);assert.equal(intent.refundedMinor,2500);assert.equal(intent.status,'partially_refunded');
    });
    await t.test('revoked grants and disabled MFA invalidate stale direct core callers',async()=>{
      const managed=await actor(),other=await fixture({settlement:true});await User.updateOne({_id:managed.user._id},{$set:{platformAccessManagedAt:new Date()}});
      const grant=await PlatformGrant.create({publicId:'pgr_fp_'+suffix,userId:managed.user._id,role:'finance',operationalCountries:['UG'],status:'active',startsAt:new Date(Date.now()-1000),expiresAt:new Date(Date.now()+86400000),reason:'Test Finance grant',approvalPublicId:'apr_fp_'+suffix,approvedByUserId:second.user._id});
      const refund=await requestFinanceRefund(context(first),{orderId:other.order.publicId,reason:'Grant test refund',idempotencyKey:'grant_refund_'+suffix,version:other.intent.__v});
      await PlatformGrant.updateOne({_id:grant._id},{$set:{status:'revoked'}});await assert.rejects(completeManualRefund(context(managed),refund.publicId,{reference:'revoked-proof'}),error=>error.code==='FINANCE_GRANT_UNAVAILABLE');
      await User.updateOne({_id:managed.user._id},{$set:{platformAccessManagedAt:null,'security.mfaEnabled':false}});await assert.rejects(completeManualRefund(context(managed),refund.publicId,{reference:'disabled-mfa-proof'}),error=>error.code==='MFA_ENROLLMENT_REQUIRED');
      assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+refund.publicId}),0);assert.equal((await Refund.findOne({publicId:refund.publicId})).status,'processing');
    });
    await t.test('transactional audit failure rolls back refund record and reservation',async()=>{
      const order=await fixture({settlement:true}),bad=context(first);bad.id=undefined;
      await assert.rejects(requestFinanceRefund(bad,{orderId:order.order.publicId,reason:'Audit failure rollback',idempotencyKey:'audit_failure_'+suffix,version:order.intent.__v}));
      assert.equal(await Refund.countDocuments({idempotencyKey:'audit_failure_'+suffix}),0);assert.equal((await PaymentIntent.findById(order.intent._id)).refundReservedMinor,0);
    });
    await t.test('provider verification uses actual evidence and rechecks authorization after the response',async()=>{
      let revoke=false,calls=0;const stub=t.mock.method(globalThis,'fetch',async url=>{assert.equal(new URL(url).hostname,'finance-payment-test.invalid');calls++;if(new URL(url).pathname.includes('RequestToken'))return new Response(JSON.stringify({token:'test-provider-token',expiryDate:new Date(Date.now()+600000).toISOString()}),{status:200});if(revoke)await User.updateOne({_id:first.user._id},{$set:{'security.mfaEnabled':false}});return new Response(JSON.stringify({payment_status_description:'PENDING',amount:10000,currency:'UGX',merchant_reference:pending.intent.publicId}),{status:200});});
      try{
        const page=await first.client.get('/finance/payments?record='+pending.intent.publicId).expect(200),token=csrf(page.text);assert.match(page.text,/Verify with Pesapal/);
        const before=await PaymentIntent.findById(pending.intent._id);await first.client.post('/finance/payments/'+pending.intent.publicId+'/verify').type('form').send({_csrf:token,version:before.__v}).expect(302);
        const verified=await PaymentIntent.findById(pending.intent._id);assert.equal(verified.status,'pending');assert.ok(verified.lastVerifiedAt);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'payment:'+pending.intent.publicId}),0);
        revoke=true;const oldAt=verified.lastVerifiedAt.toISOString();await assert.rejects(verifyAndApplyPayment(pending.intent.publicId,undefined,{request:context(first),country:'UG'}),error=>error.code==='MFA_ENROLLMENT_REQUIRED');assert.equal((await PaymentIntent.findById(pending.intent._id)).lastVerifiedAt.toISOString(),oldAt);assert.ok(calls>=3);
      }finally{stub.mock.restore();await User.updateOne({_id:first.user._id},{$set:{'security.mfaEnabled':true}});}
    });
    await t.test('authorized Customer cancellation refunds remain automatic and isolated to their own frozen order',async()=>{
      const owned=await fixture({provider:'wallet',owner:customer.user,settlement:true});await Order.updateOne({_id:owned.order._id},{$set:{fulfillmentState:'cancelled',cancellationState:'processing','cancellation.requestedAt':new Date()}});
      const refund=await createRefund(context(customer),{orderId:owned.order.publicId,reason:'Pre-fulfilment cancellation',idempotencyKey:'cancel:'+owned.order.publicId});assert.equal(refund.status,'completed');assert.equal((await PaymentIntent.findById(owned.intent._id)).refundedMinor,10000);
      const wallet=await LedgerAccount.findOne({code:'customer_wallet',ownerId:customer.user._id,country:'UG',currency:'UGX'});assert.equal(await accountBalanceMinor(wallet._id,null,'liability'),10000);
      const unfrozen=await fixture({provider:'wallet',owner:customer.user});await assert.rejects(createRefund(context(customer),{orderId:unfrozen.order.publicId,reason:'Invalid direct self refund',idempotencyKey:'cancel:'+unfrozen.order.publicId}),error=>error.code==='REFUND_CANCELLATION_REQUIRED');
    });
    await t.test('provider mismatches cannot alter captured funds and reversal evidence commits atomically',async()=>{
      const target=await fixture({provider:'pesapal',settlement:true});const initialIntent=await PaymentIntent.findById(target.intent._id).lean(),initialOrder=await Order.findById(target.order._id).lean(),initialCount=await LedgerTransaction.countDocuments();let status='REVERSED',merchant='OTHER_PAYMENT',amount=10000,currency='UGX';
      const stub=t.mock.method(globalThis,'fetch',async url=>{assert.equal(new URL(url).hostname,'finance-payment-test.invalid');if(new URL(url).pathname.includes('RequestToken'))return new Response(JSON.stringify({token:'test-provider-token',expiryDate:new Date(Date.now()+600000).toISOString()}));return new Response(JSON.stringify({payment_status_description:status,amount,currency,merchant_reference:merchant}));});
      try{
        for(const mismatch of [{merchant:'OTHER_PAYMENT',amount:10000,currency:'UGX'},{merchant:target.intent.providerReference,amount:999,currency:'UGX'},{merchant:target.intent.providerReference,amount:10000,currency:'KES'}]){({merchant,amount,currency}=mismatch);await assert.rejects(verifyAndApplyPayment(target.intent.publicId),error=>error.code==='PESAPAL_REVERSAL_MISMATCH');}
        status='FAILED';merchant='OTHER_PAYMENT';amount=10000;currency='UGX';await assert.rejects(verifyAndApplyPayment(target.intent.publicId),error=>error.code==='PESAPAL_VERIFICATION_MISMATCH');
        status='INVALID';merchant=target.intent.providerReference;await assert.rejects(verifyAndApplyPayment(target.intent.publicId),error=>error.code==='PESAPAL_TERMINAL_STATUS_CONFLICT');
        status='COMPLETED';merchant='OTHER_PAYMENT';await assert.rejects(verifyAndApplyPayment(target.intent.publicId),error=>error.code==='PESAPAL_VERIFICATION_MISMATCH');
        assert.deepEqual(await PaymentIntent.findById(target.intent._id).lean(),initialIntent);assert.deepEqual(await Order.findById(target.order._id).lean(),initialOrder);assert.equal(await Chargeback.countDocuments({paymentIntentId:target.intent._id}),0);assert.equal(await LedgerTransaction.countDocuments(),initialCount);
        status='REVERSED';merchant=target.intent.providerReference;
        const originalAudit=AuditLog.create;
        AuditLog.create=function(documents,...args){if(documents?.[0]?.action==='finance.payment_provider_verified')throw new Error('Injected reversal audit failure');return originalAudit.call(this,documents,...args);};
        try{await assert.rejects(verifyAndApplyPayment(target.intent.publicId,undefined,{request:context(first),country:'UG'}),/Injected reversal audit failure/);}finally{AuditLog.create=originalAudit;}
        assert.deepEqual(await PaymentIntent.findById(target.intent._id).lean(),initialIntent);assert.deepEqual(await Order.findById(target.order._id).lean(),initialOrder);assert.equal(await Chargeback.countDocuments({paymentIntentId:target.intent._id}),0);assert.equal(await LedgerTransaction.countDocuments(),initialCount);
        const reversed=await verifyAndApplyPayment(target.intent.publicId,undefined,{request:context(first),country:'UG'});
        assert.equal(reversed.status,'reversed');assert.equal((await Order.findById(target.order._id)).paymentState,'failed');assert.equal(await Chargeback.countDocuments({paymentIntentId:target.intent._id}),1);assert.equal(await LedgerTransaction.countDocuments(),initialCount+1);
        await verifyAndApplyPayment(target.intent.publicId,undefined,{request:context(first),country:'UG'});assert.equal(await LedgerTransaction.countDocuments(),initialCount+1);
      }finally{stub.mock.restore();}
    });
    await t.test('cursor pagination keeps full counts and export includes every matching scoped record',async()=>{
      for(let index=0;index<30;index++)await fixture({amount:101+index});
      const firstPage=await loadFinancePaymentPage(context(first),'finance-payments');assert.equal(firstPage.items.length,25);assert.ok(firstPage.page.total>25);assert.equal(firstPage.page.hasMore,true);
      const nextContext=context(first);nextContext.query={after:firstPage.page.next};const secondPage=await loadFinancePaymentPage(nextContext,'finance-payments');assert.equal(secondPage.page.total,firstPage.page.total);assert.ok(secondPage.items.every(row=>!firstPage.items.some(previous=>previous.publicId===row.publicId)));
      const csv=await first.client.get('/finance/payments/export.csv').expect(200);assert.equal(csv.text.trim().split('\r\n').length-1,firstPage.page.total);
      const refundPage=await first.client.get('/finance/refunds').set('accept','application/json').expect(200);assert.ok(refundPage.body.items.length>=3);assert.equal(refundPage.body.currency,'UGX');
      const foreignRefund=await Refund.create({publicId:'rfd_foreign_fp_'+suffix,idempotencyKey:'refund_foreign_'+suffix,orderId:foreign.order._id,paymentIntentId:foreign.intent._id,amountMinor:100,currency:'KES',reason:'FOREIGN_REFUND_PRIVATE',provider:'cod_manual',requestedByUserId:multi.user._id,status:'processing'});
      await first.client.get('/finance/refunds?record='+foreignRefund.publicId).set('accept','application/json').expect(404);assert.ok(!(await first.client.get('/finance/refunds/export.csv').expect(200)).text.includes(foreignRefund.publicId));
    });
    await t.test('a country scope narrowed during CSV backpressure stops all subsequent records',async()=>{
      const source=context(multi);source.query={country:''};const response=new EventEmitter();response.destroyed=false;response.lines=[];response.type=()=>response;response.set=()=>response;response.end=()=>{response.ended=true;};
      response.write=text=>{response.lines.push(text);if(response.lines.length===2){User.updateOne({_id:multi.user._id},{$set:{operationalCountries:['UG']}}).then(()=>response.emit('drain'),error=>response.emit('error',error));return false;}return true;};
      try{await assert.rejects(streamFinancePaymentCsv(source,response,'finance-payments'),error=>error.code==='FINANCE_SCOPE_CHANGED');assert.equal(response.lines.length,2);assert.notEqual(response.ended,true);}finally{await User.updateOne({_id:multi.user._id},{$set:{operationalCountries:['UG','KE']}});}
    });
  }finally{
    for(const transport of transports)transport.destroy();t.mock.restoreAll();for(const Model of Object.values(mongoose.connection.models))await Model.init();await mongoose.connection.db.dropDatabase();await mongoose.disconnect();
  }
});
