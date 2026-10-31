import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

const suffix=crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV='test';process.env.SIMPLE_LOGIN='false';process.env.PRIVILEGED_MFA_REQUIRED='true';process.env.MAIL_MODE='log';process.env.SMS_MODE='log';process.env.REDIS_URL='';
process.env.UPLOAD_DIR='/tmp/classicmart-country-commerce-'+suffix;process.env.MEDIA_STORAGE_DRIVER='filesystem';
process.env.PESAPAL_BASE_URL='https://country-admin-commerce.invalid';process.env.PESAPAL_CONSUMER_KEY=crypto.randomBytes(16).toString('hex');process.env.PESAPAL_CONSUMER_SECRET=crypto.randomBytes(32).toString('hex');
for(const name of ['SESSION_SECRET','TOKEN_PEPPER','SECURITY_INTEGRITY_KEY','DATA_ENCRYPTION_KEY'])process.env[name]=crypto.randomBytes(32).toString('hex');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;if(uri)process.env.MONGO_URI=uri;
const csrf=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Country Admin commerce CSV escapes formulas and literal quotes',async()=>{
  const {countryAdminCommerceCsvCell}=await import('../src/services/country-admin-commerce-pages.js');
  assert.equal(countryAdminCommerceCsvCell(' \t=SUM(A1:A2)'),'"\' \t=SUM(A1:A2)"');
  assert.equal(countryAdminCommerceCsvCell('a"b'),'"a""b"');assert.equal(countryAdminCommerceCsvCell('ordinary'),'"ordinary"');
});

test('Country Admin commerce keeps actual scoped order, inspected return and independent refund outcomes',{skip:!uri,timeout:180000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/verification|test/i);
  await mongoose.connect(uri,{dbName:'classicmart_country_commerce_test_'+suffix});const transports=[];
  try{
    const {createApp}=await import('../src/app.js');
    const {User,PlatformGrant,CountrySetting,Store,Category,Product,ProductVariant,Warehouse,StockItem,Order,SellerOrder,Shipment,ReturnRequest,
      WarehouseTask,PaymentIntent,Refund,EvidenceDocument,LedgerTransaction,FinancialDocument,AuditLog,Device,ProviderEvent}=await import('../src/models/index.js');
    const commerce=await import('../src/services/country-admin-commerce-pages.js');
    const {uploadWarehouseReturnIntakeEvidence,recordWarehouseReturnIntake}=await import('../src/services/support-case-pages.js');
    const {mutateWarehouse}=await import('../src/services/warehouse-operations.js');
    const {ensureLedgerAccount,postLedgerTransaction}=await import('../src/services/money.js');
    const {hashPassword,hashToken}=await import('../src/core/crypto.js');const {encryptSensitive}=await import('../src/core/sensitive.js');const {totpCode}=await import('../src/services/mfa.js');
    const {completeManualRefund}=await import('../src/services/payments.js');
    await Promise.all(Object.values(mongoose.models).map(Model=>Model.init()));
    await CountrySetting.create([{code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'},
      {code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254'}]);
    let sequence=0;const id=kind=>`${kind}_ca_${suffix}_${++sequence}`,secret='JBSWY3DPEHPK3PXP',password='Commerce-'+suffix+'-A1!',passwordHash=await hashPassword(password),app=createApp(null);
    async function actor(role='country_admin',{countries=['UG'],mfa=true,managed=true,login=true}={}){
      const index=++sequence,email='commerce-'+suffix+'-'+index+'@example.com',phone='+25670'+String(index).padStart(7,'0');
      const user=await User.create({publicId:id('usr'),name:'Commerce operator '+index,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,
        role:managed?'customer':role,country:countries[0],currency:countries[0]==='KE'?'KES':'UGX',locale:'en-UG',operationalCountries:countries,
        emailVerifiedAt:new Date(),phoneVerifiedAt:new Date(),onboardingCompletedAt:new Date(),platformAccessManagedAt:managed?new Date():undefined,security:{mfaEnabled:mfa,mfaSecretEncrypted:mfa?encryptSensitive(secret):undefined},consents:{terms:true,privacy:true,recordedAt:new Date()}});
      const grant=managed?await PlatformGrant.create({publicId:id('pgr'),userId:user._id,role,operationalCountries:countries,status:'active',startsAt:new Date(Date.now()-60000),expiresAt:new Date(Date.now()+86400000),reason:'Commerce fixture scoped operations',approvalPublicId:id('apr'),approvedByUserId:new mongoose.Types.ObjectId()}):null;
      let client;if(login){const transport=new http.Agent({localAddress:'127.0.0.'+(index%100+100),keepAlive:false});transports.push(transport);client=request.agent(app).use(req=>req.agent(transport));
        const page=await client.get('/login').expect(200);await client.post('/login').type('form').send({email,password,_csrf:csrf(page.text)}).expect(302);
        if(mfa){const challenge=await client.get('/mfa').expect(200);await client.post('/mfa').type('form').send({code:totpCode(secret),_csrf:csrf(challenge.text)}).expect(302);}}
      return {user,grant,client};
    }
    const inspector=await actor(),reviewer=await actor(),completer=await actor(),multi=await actor('country_admin',{countries:['UG','KE']}),
      receiving=await actor('warehouse',{login:false}),buyer=await actor('customer',{managed:false,mfa:false}),seller=await actor('seller',{managed:false,login:false}),
      financeOnly=await actor('finance'),noMfa=await actor('country_admin',{mfa:false,login:false});
    const req=(entry,query={})=>({id:id('req'),user:entry.user,session:{tokenVersion:entry.user.security.tokenVersion},query,ip:'127.0.0.1',get:()=> 'CountryCommerceFixture/1.0'});
    const category=await Category.create({publicId:id('cat'),name:'Commerce goods',slug:id('category'),countries:['UG']});
    const store=await Store.create({publicId:id('sto'),ownerUserId:seller.user._id,name:'Commerce seller',slug:id('store'),country:'UG',currency:'UGX',status:'verified'});
    const product=await Product.create({publicId:id('prd'),storeId:store._id,ownerUserId:seller.user._id,categoryId:category._id,title:'Delivered commerce goods',slug:id('product'),description:'Immutable received line fixture',countries:['UG'],status:'published'});
    const variant=await ProductVariant.create({publicId:id('var'),productId:product._id,storeId:store._id,sku:id('sku').toUpperCase(),title:'Standard',priceMinor:10000,costMinor:5000,currency:'UGX'});
    const warehouse=await Warehouse.create({publicId:id('whs'),storeId:store._id,ownerUserId:seller.user._id,name:'Receiving warehouse',country:'UG',city:'Kampala',address:'Fixture receiving location'});
    const stock=await StockItem.create({publicId:id('stk'),storeId:store._id,warehouseId:warehouse._id,variantId:variant._id,onHand:5,reserved:0,damaged:0,quarantined:0});
    await PlatformGrant.updateOne({_id:receiving.grant._id},{$set:{warehouseScopes:[warehouse.publicId]}});
    async function orderFixture({country='UG',currency='UGX',amount=20000,provider='cod',status='succeeded',settle=false}={}){
      const line=id('oli'),orderId=id('ord');
      const order=await Order.create({publicId:orderId,idempotencyKey:id('checkout'),checkoutId:id('checkout'),cartPublicId:id('crt'),sessionKey:id('session'),userId:buyer.user._id,country,
        status:status==='succeeded'?'paid':'pending_payment',paymentState:status==='succeeded'?'paid':'pending',fulfillmentState:settle?'delivered':'unfulfilled',deliveryMethod:'standard',paymentMethod:provider==='cod'?'cod':'card',
        contact:{fullName:'BUYER_NAME_PRIVATE',email:'BUYER_EMAIL_PRIVATE@example.com',phone:'+256700123456',address:'BUYER_ADDRESS_PRIVATE',city:'Kampala',country},
        totals:{subtotalMinor:amount,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:amount,currency},reservationExpiresAt:new Date(Date.now()+86400000),
        items:[{linePublicId:line,productId:product._id,variantId:variant._id,storeId:store._id,reservationPublicId:id('rsv'),productPublicId:product.publicId,variantPublicId:variant.publicId,storePublicId:store.publicId,title:product.title,variantTitle:variant.title,sku:variant.sku,quantity:2,deliveredQuantity:settle?2:0,unitPriceMinor:amount/2,lineTotalMinor:amount,currency}]});
      const intent=await PaymentIntent.create({publicId:id('pay'),orderId:order._id,orderPublicId:order.publicId,country,currency,idempotencyKey:id('payment'),provider,method:provider==='cod'?'cod':'card',status,amountMinor:amount,paidAt:status==='succeeded'?new Date():undefined,
        providerReference:id('provider'),providerTrackingId:provider==='pesapal'?id('tracking'):undefined,providerConfirmationCode:provider==='pesapal'?'CONFIRMATION_PRIVATE':undefined,checkoutUrl:'https://checkout.invalid/PROVIDER_SECRET_PRIVATE'});
      let shipment;if(settle){
        shipment=await Shipment.create({publicId:id('shp'),orderId:order._id,orderPublicId:order.publicId,country,mode:'standard',kind:'outbound',status:'delivered',deliveredAt:new Date(),proof:{type:'otp',reference:'verified',recordedAt:new Date()},cod:{required:true,amountMinor:amount,currency,collectedMinor:amount,reconciledAt:new Date()}});
        await SellerOrder.create({publicId:id('sord'),orderId:order._id,orderPublicId:order.publicId,storeId:store._id,storePublicId:store.publicId,country,status:'fulfilled',subtotalMinor:amount,platformFeeMinor:1000,currency,
          items:[{orderLineId:line,productPublicId:product.publicId,variantPublicId:variant.publicId,title:product.title,quantity:2,unitPriceMinor:amount/2,lineTotalMinor:amount,currency,grossMinor:amount,customerPaidMinor:amount,platformFeeMinor:1000,sellerReceivableMinor:amount-1000}]});
        const clearing=await ensureLedgerAccount({code:'cod_clearing',type:'asset',ownerType:'platform',ownerPublicId:'classic-mart',country,currency}),payable=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerPublicId:store.publicId,country,currency}),revenue=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country,currency});
        await postLedgerTransaction({idempotencyKey:'cod:'+shipment.publicId,referenceType:'cod_reconciliation',referencePublicId:shipment.publicId,country,currency,description:'Actual captured COD fixture',entries:[{account:clearing,debitMinor:amount,creditMinor:0},{account:payable,debitMinor:0,creditMinor:amount-1000},{account:revenue,debitMinor:0,creditMinor:1000}]});
      }
      return {order,intent,line,shipment};
    }
    const paid=await orderFixture({settle:true}),foreign=await orderFixture({country:'KE',currency:'KES'}),wrong=await orderFixture();
    // Deliberate out-of-band corruption: ordinary model updates correctly reject immutable country changes.
    await PaymentIntent.collection.updateOne({_id:wrong.intent._id},{$set:{country:'KE'}});
    let returned,refund,evidence;
    const returnVersion=async()=>Number((await ReturnRequest.findById(returned._id)).__v||0);
    async function adminAction(entry,path,body,status=200){const page=await entry.client.get('/admin/returns').expect(200);return entry.client.post(path).set('x-csrf-token',csrf(page.text)).set('accept','application/json').send(body).expect(status);}
    await t.test('Admin pages retain their shell and expose safe scoped source records without mutating read versions',async()=>{
      const before=await Order.findById(paid.order._id).lean();
      const flow=await inspector.client.get('/admin/orders?record='+paid.order.publicId).set('accept','application/json').expect(200);
      assert.equal(flow.body.kind,'commerce');assert.equal(flow.body.selected.sellerOrders.length,1);assert.equal(flow.body.selected.shipments[0].verifiedDelivery,true);assert.equal(flow.body.selected.payments[0].publicId,paid.intent.publicId);
      for(const value of ['BUYER_NAME_PRIVATE','BUYER_EMAIL_PRIVATE','BUYER_ADDRESS_PRIVATE','PROVIDER_SECRET_PRIVATE','requestedByUserId',foreign.order.publicId])assert.ok(!JSON.stringify(flow.body).includes(value),value);
      assert.equal((await Order.findById(paid.order._id)).__v,before.__v);
      const html=await inspector.client.get('/admin/orders?record='+paid.order.publicId).expect(200);assert.match(html.text,/Order details/);assert.match(html.headers['cache-control'],/no-store/);assert.match(html.headers['x-robots-tag'],/noindex/);
      await inspector.client.get('/admin/orders?record='+foreign.order.publicId).set('accept','application/json').expect(404);
      await inspector.client.get('/admin/payments?record='+wrong.intent.publicId).set('accept','application/json').expect(404);
      await inspector.client.get('/admin/orders?country=KE').set('accept','application/json').expect(403);
      await inspector.client.get('/admin/orders?country=UG&country=KE').set('accept','application/json').expect(422);
      await inspector.client.get('/admin/payments?status[]=succeeded').set('accept','application/json').expect(422);
      await inspector.client.get('/admin/orders?after=invalid').set('accept','application/json').expect(422);
      await financeOnly.client.get('/admin/orders').set('accept','application/json').expect(403);
      const emptyRefunds=await inspector.client.get('/admin/payments?view=refunds').set('accept','application/json').expect(200);
      assert.equal(emptyRefunds.body.commerceKind,'refunds');assert.equal(emptyRefunds.body.page.total,0);assert.deepEqual(emptyRefunds.body.items,[]);
      await assert.rejects(commerce.loadCountryAdminCommercePage(req(noMfa),'admin-orders'),error=>error.code==='MFA_ENROLLMENT_REQUIRED');
      const all=await multi.client.get('/admin/payments?country=').set('accept','application/json').expect(200);assert.equal(all.body.currency,null);assert.match(all.body.metrics[0].value,/UGX/);assert.match(all.body.metrics[0].value,/KES/);
    });
    await t.test('actual buyer return cannot advance without receipt and exact warehouse inspection',async()=>{
      const page=await buyer.client.get('/returns').expect(200),result=await buyer.client.post('/api/v1/returns').set('x-csrf-token',csrf(page.text)).send({orderId:paid.order.publicId,items:[{orderLineId:paid.line,quantity:1}],reason:'damaged',details:'One actual delivered unit needs physical receipt and inspection.',resolution:'refund',returnMethod:'dropoff'}).expect(201);
      returned=await ReturnRequest.findOne({publicId:result.body.returnRequest.publicId});
      await inspector.client.post('/admin/returns/'+returned.publicId+'/decision').send({version:returned.__v,decision:'approve',note:'Return matches the delivered immutable order goods.'}).expect(403);
      await adminAction(inspector,'/admin/returns/'+returned.publicId+'/decision',{version:999,decision:'approve',note:'Return matches the delivered immutable order goods.'},409);
      await adminAction(inspector,'/admin/returns/'+returned.publicId+'/decision',{version:await returnVersion(),decision:'approve',note:'Return matches the delivered immutable order goods.'});
      await adminAction(inspector,'/admin/returns/'+returned.publicId+'/receive',{version:await returnVersion(),note:'Cannot invent physical goods receipt.'},409);
      await adminAction(inspector,'/admin/returns/'+returned.publicId+'/inspect',{version:await returnVersion(),condition:'damaged',notes:'Cannot invent warehouse inspection outcome.'},409);
      const image=await sharp({create:{width:360,height:360,channels:3,background:'#ffffff'}}).png().toBuffer();
      const receipt=await uploadWarehouseReturnIntakeEvidence(req(receiving),returned.publicId,{version:await returnVersion(),orderLineId:paid.line,warehousePublicId:warehouse.publicId},{buffer:image,mimetype:'image/png',originalname:'return.png'});
      await recordWarehouseReturnIntake(req(receiving),returned.publicId,{version:receipt.version,orderLineId:paid.line,warehousePublicId:warehouse.publicId,evidencePublicId:receipt.evidencePublicId});
      const task=await WarehouseTask.findOne({returnRequestId:returned._id});await mutateWarehouse({...req(receiving),params:{publicId:task.publicId},body:{version:task.__v}},'claim');
      const claimed=await WarehouseTask.findById(task._id);await mutateWarehouse({...req(receiving),params:{publicId:task.publicId},body:{version:claimed.__v,disposition:'damaged'}},'execute');
      assert.equal((await StockItem.findById(stock._id)).damaged,1);
      await adminAction(inspector,'/admin/returns/'+returned.publicId+'/inspect',{version:await returnVersion(),condition:'damaged',notes:'Completed actual warehouse inspection matches the exact returned unit.'});
      await adminAction(inspector,'/admin/returns/'+returned.publicId+'/refer-finance',{version:await returnVersion(),note:'Exact receipt and inspection ready for independent payment review.'});
      assert.equal((await ReturnRequest.findById(returned._id)).status,'refund_pending');assert.equal(await Refund.countDocuments(),0);
    });
    let refundBody;
    await t.test('independent review reserves only immutable inspected quantities and rolls back audit failures',async()=>{
      await inspector.client.get('/admin/payments?view=refunds&return='+returned.publicId).set('accept','application/json').expect(403);
      const flow=await reviewer.client.get('/admin/payments?view=refunds&return='+returned.publicId).set('accept','application/json').expect(200);assert.equal(flow.body.refundOrder.amountMinor,10000);assert.equal(flow.body.refundOrder.items[0].quantity,1);
      refundBody={orderId:paid.order.publicId,returnPublicId:returned.publicId,returnVersion:flow.body.refundOrder.returnVersion,version:flow.body.refundOrder.payment.version,idempotencyKey:flow.body.idempotencyKey,amountMinor:10000,reason:'Independent review of actual inspected return goods'};
      await adminAction(reviewer,'/admin/payments/refunds',{...refundBody,amountMinor:9999},409);
      const before=await ReturnRequest.findById(returned._id).lean(),mock=t.mock.method(AuditLog,'create',async()=>{throw new Error('Commerce audit unavailable');});
      try{await assert.rejects(commerce.requestCountryAdminRefund(req(reviewer),refundBody),/Commerce audit unavailable/);}finally{mock.mock.restore();}
      assert.equal(await Refund.countDocuments(),0);assert.equal((await ReturnRequest.findById(returned._id)).__v,before.__v);assert.equal((await PaymentIntent.findById(paid.intent._id)).refundReservedMinor,0);
      const result=await adminAction(reviewer,'/admin/payments/refunds',refundBody,201);refund=result.body.refund;assert.equal(refund.status,'processing');assert.equal(refund.amountMinor,10000);assert.equal((await ReturnRequest.findById(returned._id)).status,'refund_processing');
      assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'refund:'+refund.publicId}),0);
    });
    await t.test('actual private evidence and a third independent operator complete one balanced refund',async()=>{
      await assert.rejects(commerce.completeCountryAdminRefund(req(reviewer),refund.publicId,{version:refund.version,reference:'verified-reference',evidencePublicId:id('evd')}),error=>error.code==='FOUR_EYES_REQUIRED');
      await assert.rejects(commerce.completeCountryAdminRefund(req(inspector),refund.publicId,{version:refund.version,reference:'verified-reference',evidencePublicId:id('evd')}),error=>error.code==='FOUR_EYES_REQUIRED');
      await assert.rejects(commerce.completeCountryAdminRefund(req(completer),refund.publicId,{version:refund.version,reference:'verified-reference',evidencePublicId:id('evd')}),error=>error.code==='REFUND_EVIDENCE_REQUIRED');
      const page=await completer.client.get('/admin/payments?view=refunds&record='+refund.publicId).expect(200),image=await sharp({create:{width:360,height:360,channels:3,background:'#d7eeee'}}).png().toBuffer();
      const result=await completer.client.post('/admin/payments/refunds/'+refund.publicId+'/evidence').set('x-csrf-token',csrf(page.text)).set('accept','application/json').field('version',String(refund.version)).field('description','Actual cash refund disbursement receipt verified by independent operator').attach('document',image,'cash-refund.png').expect(201);evidence=result.body.evidencePublicId;
      const document=await EvidenceDocument.findOne({publicId:evidence});assert.equal(document.refundPublicId,refund.publicId);assert.equal(document.contextLinePublicId,'');assert.equal(document.documentType,'refund_disbursement');
      const sourceSnapshot=async()=>({
        evidence:await EvidenceDocument.findById(document._id).select('+moderationEvidenceReadRevision').lean(),
        returned:await ReturnRequest.findById(returned._id).select('+countryAdminEvidenceReadRevision').lean(),
        order:await Order.findById(paid.order._id).select('+moderationEvidenceReadRevision').lean(),
      });
      const beforeEvidenceAccess=await sourceSnapshot();
      const evidenceAudit=t.mock.method(AuditLog,'create',async()=>{throw new Error('Private evidence audit unavailable');});
      try{await assert.rejects(commerce.countryAdminCommerceEvidenceRecord(req(completer),evidence),/Private evidence audit unavailable/);}finally{evidenceAudit.mock.restore();}
      assert.deepEqual(await sourceSnapshot(),beforeEvidenceAccess,'Required evidence audit failure rolls back every source read fence.');
      await completer.client.get('/admin/commerce/evidence/'+evidence+'?country=UG').expect(200).expect('Content-Type',/image\/webp/);
      const afterEvidenceAccess=await sourceSnapshot();
      for(const source of ['evidence','returned','order']){
        assert.equal(afterEvidenceAccess[source].__v,beforeEvidenceAccess[source].__v,'Private evidence reads preserve current form versions.');
        assert.equal(afterEvidenceAccess[source].updatedAt.getTime(),beforeEvidenceAccess[source].updatedAt.getTime(),'Private evidence reads preserve workflow update dates.');
      }
      assert.equal(afterEvidenceAccess.returned.countryAdminEvidenceReadRevision,1);
      await EvidenceDocument.updateOne({_id:document._id},{$set:{status:'quarantined'}});
      await assert.rejects(completeManualRefund({...req(completer),requiredOperationalWorkspace:'admin',requiredRefundEvidencePublicId:evidence},refund.publicId,{version:refund.version,reference:'actual-cash-reference'}),error=>error.code==='REFUND_EVIDENCE_REQUIRED');
      await EvidenceDocument.updateOne({_id:document._id},{$set:{status:'ready'}});
      const mock=t.mock.method(AuditLog,'create',async()=>{throw new Error('Refund audit unavailable');});try{await assert.rejects(commerce.completeCountryAdminRefund(req(completer),refund.publicId,{version:refund.version,reference:'actual-cash-reference',evidencePublicId:evidence}),/Refund audit unavailable/);}finally{mock.mock.restore();}
      assert.equal((await Refund.findOne({publicId:refund.publicId})).status,'processing');assert.equal((await PaymentIntent.findById(paid.intent._id)).refundReservedMinor,10000);
      await adminAction(completer,'/admin/payments/refunds/'+refund.publicId+'/complete',{version:refund.version,reference:'actual-cash-reference',evidencePublicId:evidence});
      assert.equal((await ReturnRequest.findById(returned._id)).status,'refunded');assert.equal((await Refund.findOne({publicId:refund.publicId})).status,'completed');
      const ledger=await LedgerTransaction.findOne({idempotencyKey:'refund:'+refund.publicId});assert.ok(ledger);assert.equal(ledger.entries.reduce((sum,line)=>sum+line.debitMinor,0),10000);assert.equal(ledger.entries.reduce((sum,line)=>sum+line.creditMinor,0),10000);
      assert.equal(await FinancialDocument.countDocuments({refundPublicId:refund.publicId,type:'refund_credit_note'}),1);assert.equal((await PaymentIntent.findById(paid.intent._id)).refundReservedMinor,0);
    });
    await t.test('provider replay checks exact sources and current versions without inventing provider success',async()=>{
      const pending=await orderFixture({provider:'pesapal',status:'pending'}),event=await ProviderEvent.create({publicId:id('pev'),provider:'pesapal',eventId:id('event'),eventType:'CHANGE',merchantReference:pending.intent.providerReference,providerTrackingId:pending.intent.providerTrackingId,country:'UG',rawHash:id('hash'),rawEncrypted:encryptSensitive('provider event fixture'),verifiedAt:new Date(),status:'failed'});
      await adminAction(reviewer,'/admin/payments/events/'+event.publicId+'/replay',{version:999,reason:'Independent retry of verified matched event'},409);
      const result=await adminAction(reviewer,'/admin/payments/events/'+event.publicId+'/replay',{version:0,reason:'Independent retry of verified matched event'});assert.equal(result.body.event.status,'received');assert.equal((await PaymentIntent.findById(pending.intent._id)).status,'pending');assert.equal((await Order.findById(pending.order._id)).paymentState,'pending');
      await ProviderEvent.updateOne({_id:event._id},{$set:{providerTrackingId:'WRONG_PROVIDER_TRACKING_PRIVATE'}});await reviewer.client.get('/admin/payments?view=events&record='+event.publicId).set('accept','application/json').expect(404);
      const stale=await actor('country_admin',{login:false});const sessionID=id('session'),device=await Device.create({publicId:id('dev'),userId:stale.user._id,sessionHash:hashToken(sessionID),label:'Fixture browser',userAgent:'Fixture',ipHash:id('ip'),lastSeenAt:new Date()});
      const context={...req(stale),sessionID,device,session:{userId:stale.user._id,tokenVersion:stale.user.security.tokenVersion}};
      const fetchMock=t.mock.method(globalThis,'fetch',async url=>{if(String(url).endsWith('/Auth/RequestToken'))return {ok:true,status:200,text:async()=>JSON.stringify({token:'fixture-provider-token',expiryDate:new Date(Date.now()+3600000).toISOString()})};
        await Device.updateOne({_id:device._id},{$set:{revokedAt:new Date()}});return {ok:true,status:200,text:async()=>JSON.stringify({payment_status_description:'PENDING',merchant_reference:pending.intent.providerReference,amount:20000,currency:'UGX'})};});
      try{await assert.rejects(commerce.verifyCountryAdminPayment(context,pending.intent.publicId,{version:pending.intent.__v}),error=>error.code==='ACCOUNT_UNAVAILABLE');}finally{fetchMock.mock.restore();}
      assert.equal((await PaymentIntent.findById(pending.intent._id)).status,'pending');assert.equal((await PaymentIntent.findById(pending.intent._id)).lastVerifiedAt,undefined);
    });
    await t.test('bounded keysets retain full metrics and CSV stops immediately when current grant narrows',async()=>{
      for(let index=0;index<28;index++)await orderFixture({amount:100+index*2});
      const first=await commerce.loadCountryAdminCommercePage(req(inspector),'admin-orders');assert.equal(first.items.length,25);assert.ok(first.page.total>25);assert.equal(first.page.hasMore,true);
      const second=await commerce.loadCountryAdminCommercePage(req(inspector,{after:first.page.next}),'admin-orders');assert.equal(second.page.total,first.page.total);assert.ok(second.items.every(item=>!first.items.some(previous=>previous.publicId===item.publicId)));
      const csv=await inspector.client.get('/admin/orders/export.csv').expect(200);assert.equal(csv.text.trim().split('\r\n').length-1,first.page.total);assert.ok(!csv.text.includes('BUYER_EMAIL_PRIVATE'));
      const response=new EventEmitter();response.destroyed=false;response.lines=[];response.set=()=>response;response.end=()=>{response.ended=true;};response.write=line=>{response.lines.push(line);if(response.lines.length===2){PlatformGrant.updateOne({_id:multi.grant._id},{$set:{operationalCountries:['UG']}}).then(()=>response.emit('drain'),error=>response.emit('error',error));return false;}return true;};
      try{await assert.rejects(commerce.streamCountryAdminCommerceCsv(req(multi,{country:''}),response,'admin-orders'),error=>error.code==='COUNTRY_ADMIN_SCOPE_CHANGED');assert.equal(response.lines.length,2);assert.notEqual(response.ended,true);}finally{await PlatformGrant.updateOne({_id:multi.grant._id},{$set:{operationalCountries:['UG','KE']}});}
    });
  }finally{for(const transport of transports)transport.destroy();t.mock.restoreAll();for(const Model of Object.values(mongoose.connection.models))await Model.init();await mongoose.connection.db.dropDatabase();await mongoose.disconnect();await fs.rm(process.env.UPLOAD_DIR,{recursive:true,force:true});}
});
