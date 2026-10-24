import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV='test';process.env.SIMPLE_LOGIN='false';process.env.PRIVILEGED_MFA_REQUIRED='true';process.env.MAIL_MODE='log';process.env.SMS_MODE='log';process.env.REDIS_URL='';
process.env.PESAPAL_BASE_URL='https://finance-reconciliation-test.invalid';process.env.PESAPAL_CONSUMER_KEY=crypto.randomBytes(16).toString('hex');process.env.PESAPAL_CONSUMER_SECRET=crypto.randomBytes(32).toString('hex');
for(const name of ['SESSION_SECRET','TOKEN_PEPPER','SECURITY_INTEGRITY_KEY','DATA_ENCRYPTION_KEY'])process.env[name]=crypto.randomBytes(32).toString('hex');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;if(uri)process.env.MONGO_URI=uri;
const csrf=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Finance reconciliation and disputes preserve scope, independent evidence and atomic ledger controls',{skip:!uri,timeout:180_000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/verification|test/i);
  const suffix=crypto.randomBytes(8).toString('hex');await mongoose.connect(uri,{dbName:'classicmart_finance_reconciliation_test_'+suffix});
  const models=await import('../src/models/index.js');const {User,CountrySetting,Order,PaymentIntent,Chargeback,ProviderEvent,ReconciliationRun,CommissionEntry,LedgerAccount,LedgerTransaction,AuditLog,Shipment,EvidenceDocument,Refund,Device,PlatformGrant,Store,Warehouse,StockItem,InventoryReservation}=models;
  const {createApp}=await import('../src/app.js');const {hashPassword}=await import('../src/core/crypto.js');const {beginMfaEnrollment,confirmMfaEnrollment,totpCode}=await import('../src/services/mfa.js');
  const {ensureLedgerAccount,postLedgerTransaction}=await import('../src/services/money.js');
  const {requeueProviderEvent}=await import('../src/services/payments.js');const {recordProviderChargeback,reviewChargeback,resolveChargeback}=await import('../src/services/chargebacks.js');const {reconcileCod}=await import('../src/services/logistics.js');
  const {streamFinanceReconciliationCsv}=await import('../src/services/finance-reconciliation-pages.js');
  const app=createApp(null),password='Finance-'+suffix+'-SecureA1!',passwordHash=await hashPassword(password),transports=[];let sequence=0;
  async function actor(country='UG',role='finance',enrolled=true){
    const index=++sequence,email=`finance-controls-${suffix}-${index}@example.com`,phone='+25670'+String(index).padStart(7,'0');
    let user=await User.create({publicId:`usr_fc_${suffix}_${index}`,name:'Finance '+index,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,country,currency:country==='UG'?'UGX':'KES',locale:'en-UG',operationalCountries:[country],emailVerifiedAt:new Date(),onboardingCompletedAt:new Date(),consents:{terms:true,privacy:true,recordedAt:new Date()}});
    let recovery;if(enrolled){const enrollment=await beginMfaEnrollment(user._id,password);const confirmed=await confirmMfaEnrollment(user._id,totpCode(enrollment.secret));user=confirmed.user;recovery=confirmed.codes[0];}
    const transport=new http.Agent({localAddress:'127.0.0.'+(index+3),keepAlive:false});transports.push(transport);const client=request.agent(app).use(req=>req.agent(transport));
    const login=await client.get('/login').expect(200);await client.post('/login').type('form').send({email,password,_csrf:csrf(login.text)}).expect(302);
    if(recovery){const mfa=await client.get('/mfa').expect(200);await client.post('/mfa').type('form').send({code:recovery,_csrf:csrf(mfa.text)}).expect(302);}return {user,client};
  }
  const context=entry=>({user:entry.user,session:{tokenVersion:entry.user.security.tokenVersion},query:{},id:'req_fc_'+suffix+'_'+(++sequence),ip:'127.0.0.1',get:()=>''});
  async function order(country='UG',method='card'){
    const id='ord_fc_'+suffix+'_'+(++sequence),currency=country==='UG'?'UGX':'KES',refs={productId:new mongoose.Types.ObjectId(),variantId:new mongoose.Types.ObjectId(),storeId:new mongoose.Types.ObjectId()};
    return Order.create({publicId:id,idempotencyKey:id,checkoutId:'chk_'+id,cartPublicId:'crt_'+id,sessionKey:'private_session_'+id,country,status:'paid',paymentState:'paid',deliveryMethod:'standard',paymentMethod:method,contact:{fullName:'PRIVATE_BUYER',email:'PRIVATE_BUYER_EMAIL@example.com',phone:'+256700000001',address:'PRIVATE_BUYER_ADDRESS',city:'Kampala',country},totals:{subtotalMinor:0,shippingMinor:1000,discountMinor:0,taxMinor:0,totalMinor:1000,currency},items:[{...refs,linePublicId:'line_'+id,reservationPublicId:'rsv_'+id,productPublicId:'prd_'+id,variantPublicId:'var_'+id,storePublicId:'sto_'+id,title:'Fixture product',variantTitle:'Default',sku:'SKU-'+sequence,quantity:1,unitPriceMinor:0,lineTotalMinor:0,currency}],reservationExpiresAt:new Date(Date.now()+86400000)});
  }
  async function payment(source,status='reversed',provider='pesapal'){
    const id='pay_fc_'+suffix+'_'+(++sequence),tracking='track_'+id;
    return PaymentIntent.create({publicId:id,orderId:source._id,orderPublicId:source.publicId,country:source.country,idempotencyKey:id,provider,method:provider==='cod'?'cod':'card',status,amountMinor:1000,currency:source.totals.currency,providerReference:id,...(provider==='pesapal'?{providerTrackingId:tracking}:{}),reversedAt:status==='reversed'?new Date():undefined});
  }
  async function paymentLedger(source,intent){
    const cash=await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:'pesapal',country:source.country,currency:source.totals.currency});
    const revenue=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country:source.country,currency:source.totals.currency});
    return postLedgerTransaction({country:source.country,currency:source.totals.currency,idempotencyKey:'payment:'+intent.publicId,referenceType:'payment',referencePublicId:intent.publicId,description:'Verified fixture payment',entries:[{account:cash,debitMinor:1000,creditMinor:0},{account:revenue,debitMinor:0,creditMinor:1000}]});
  }
  const originalFetch=globalThis.fetch,proofs=new Map();let providerHook=null;
  globalThis.fetch=async url=>{
    assert.ok(String(url).startsWith('https://finance-reconciliation-test.invalid/'));
    if(String(url).includes('RequestToken'))return new Response(JSON.stringify({token:'test-provider-token',expiryDate:new Date(Date.now()+3600000).toISOString()}),{status:200});
    assert.ok(String(url).includes('GetTransactionStatus'));const tracking=new URL(url).searchParams.get('orderTrackingId'),proof=proofs.get(tracking);assert.ok(proof,'Unexpected provider request '+tracking);
    if(providerHook){const hook=providerHook;providerHook=null;await hook();}return new Response(JSON.stringify(proof),{status:200});
  };
  try{
    for(const Model of Object.values(mongoose.connection.models))await Model.init();
    await CountrySetting.create([{code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'},{code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254'}]);
    const owner=await actor(),second=await actor(),foreign=await actor('KE'),customer=await actor('UG','customer',false),unenrolled=await actor('UG','finance',false);
    const now=new Date();await ReconciliationRun.insertMany(Array.from({length:57},(_,index)=>({publicId:'rec_fc_'+suffix+'_'+index,country:'UG',provider:index===0?'=SUM(1,1)':'pesapal',status:index%2?'completed':'failed',startedByUserId:owner.user._id,checked:index+1,matched:index,updated:index,failed:index%2?0:1,createdAt:new Date(now.getTime()-index)})));
    const foreignRun=await ReconciliationRun.create({publicId:'rec_foreign_'+suffix,country:'KE',provider:'PRIVATE_FOREIGN_RUN',status:'completed',startedByUserId:foreign.user._id});
    await t.test('real HTTP reports use full scoped counts, cursor pagination and private headers',async()=>{
      const first=await owner.client.get('/finance/reconciliation').set('accept','application/json').expect(200);assert.equal(first.body.page.total,57);assert.equal(first.body.items.length,25);assert.equal(first.body.metrics[0].value,57);assert.ok(first.body.page.hasMore);assert.ok(!JSON.stringify(first.body).includes(foreignRun.publicId));assert.match(first.headers['cache-control'],/no-store/);assert.match(first.headers['x-robots-tag'],/noindex/);
      const next=await owner.client.get(first.body.pagination.nextHref).set('accept','application/json').expect(200);assert.equal(next.body.page.total,57);assert.ok(next.body.items.every(row=>!first.body.items.some(prior=>prior.publicId===row.publicId)));
      await owner.client.get('/finance/reconciliation?country=KE').set('accept','application/json').expect(403);await owner.client.get('/finance/reconciliation?after=broken').set('accept','application/json').expect(422);await owner.client.get('/finance/reconciliation?view=events&status=won').expect(422);await owner.client.get('/finance/reconciliation?country=UG&country=KE').expect(422);
      await customer.client.get('/finance/reconciliation').expect(403);await unenrolled.client.get('/finance/disputes').set('accept','application/json').expect(403);await unenrolled.client.get('/finance/disputes').expect(302);
      const html=await owner.client.get('/finance/reconciliation').expect(200);assert.match(html.text,/Reconciliation Centre/);assert.match(html.text,/Run Payment Reconciliation/);assert.ok(!html.text.includes('Customer Club'));const csv=await owner.client.get('/finance/reconciliation/export.csv').expect(200);assert.match(csv.text,/"'=SUM\(1,1\)"/);assert.ok(!csv.text.includes('PRIVATE_FOREIGN_RUN'));
    });
    const source=await order(),intent=await payment(source,'pending');
    const event=await ProviderEvent.create({publicId:'pev_fc_'+suffix,provider:'pesapal',eventId:'evt_'+suffix,eventType:'payment',merchantReference:intent.providerReference,providerTrackingId:intent.providerTrackingId,paymentIntentPublicId:intent.publicId,orderPublicId:source.publicId,country:'UG',rawHash:'PRIVATE_PROVIDER_HASH',rawEncrypted:'PRIVATE_PROVIDER_PAYLOAD',verifiedAt:new Date(),status:'failed',attempts:3,error:'PRIVATE_PROVIDER_ERROR'});
    await t.test('event replay claims once and exposes no provider payload or browser identity',async()=>{
      const page=await owner.client.get('/finance/reconciliation?view=events&selected='+event.publicId).set('accept','application/json').expect(200);const text=JSON.stringify(page.body);for(const value of ['PRIVATE_PROVIDER_HASH','PRIVATE_PROVIDER_PAYLOAD','PRIVATE_PROVIDER_ERROR',intent.providerTrackingId,'PRIVATE_BUYER'])assert.ok(!text.includes(value));
      const html=await owner.client.get('/finance/reconciliation?view=events&selected='+event.publicId).expect(200);const token=csrf(html.text);
      await owner.client.post('/finance/reconciliation/events/'+event.publicId+'/replay').set('accept','application/json').send({reason:'Retry failed notification'}).expect(403);
      const results=await Promise.all([owner.client.post('/finance/reconciliation/events/'+event.publicId+'/replay').set('accept','application/json').set('x-csrf-token',token).send({reason:'Retry matched payment notification'}),owner.client.post('/finance/reconciliation/events/'+event.publicId+'/replay').set('accept','application/json').set('x-csrf-token',token).send({reason:'Second racing notification retry'})]);assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
      const saved=await ProviderEvent.findById(event._id);assert.equal(saved.status,'received');assert.equal(saved.manualReplayCount,1);assert.equal(await AuditLog.countDocuments({action:'finance.provider_event_requeued',targetPublicId:event.publicId}),1);assert.equal((await PaymentIntent.findById(intent._id)).status,'pending');
      await assert.rejects(requeueProviderEvent(context(foreign),event.publicId,{reason:'Foreign market replay'}),error=>error.status===403);
      const unmatched=await ProviderEvent.create({publicId:'pev_unmatched_'+suffix,provider:'pesapal',eventId:'evt_unmatched_'+suffix,eventType:'payment',country:'UG',rawHash:'private_hash',rawEncrypted:'private_payload',verifiedAt:new Date(),status:'failed'});await assert.rejects(requeueProviderEvent(context(owner),unmatched.publicId,{reason:'Unmatched event replay'}),error=>error.code==='PROVIDER_EVENT_SCOPE_UNKNOWN');
      const foreignOrder=await order('KE'),foreignIntent=await payment(foreignOrder,'pending');
      const inconsistent=await ProviderEvent.create({publicId:'pev_inconsistent_'+suffix,provider:'pesapal',eventId:'evt_inconsistent_'+suffix,eventType:'payment',country:'UG',merchantReference:foreignIntent.providerReference,providerTrackingId:foreignIntent.providerTrackingId,paymentIntentPublicId:foreignIntent.publicId,orderPublicId:foreignOrder.publicId,rawHash:'private_foreign_hash',rawEncrypted:'private_foreign_payload',verifiedAt:new Date(),status:'failed'});
      const linked=await owner.client.get('/finance/reconciliation?view=events').set('accept','application/json').expect(200);
      assert.equal(linked.body.page.total,1);assert.equal(linked.body.items[0].publicId,event.publicId);
      assert.equal(linked.body.metrics[2].value,0);
      for(const id of [unmatched.publicId,inconsistent.publicId,foreignOrder.publicId,foreignIntent.publicId])assert.ok(!JSON.stringify(linked.body).includes(id));
      const linkedCsv=await owner.client.get('/finance/reconciliation/export.csv?view=events').expect(200);
      assert.ok(linkedCsv.text.includes(event.publicId));assert.ok(!linkedCsv.text.includes(inconsistent.publicId));
      await owner.client.get('/finance/reconciliation?view=events&selected='+inconsistent.publicId).set('accept','application/json').expect(404);
    });
    const chargedOrder=await order(),chargedIntent=await payment(chargedOrder);await paymentLedger(chargedOrder,chargedIntent);
    const estimated=await CommissionEntry.create({publicId:'com_est_'+suffix,orderId:chargedOrder._id,orderPublicId:chargedOrder.publicId,campaignId:new mongoose.Types.ObjectId(),promoterUserId:new mongoose.Types.ObjectId(),touchId:new mongoose.Types.ObjectId(),storePublicId:'sto_estimated',productPublicId:'prd_estimated',currency:'UGX',amountMinor:100,reversedAmountMinor:10,status:'partially_reversed',commissionBps:100,policyVersion:'test'});
    const dispute=await recordProviderChargeback({order:chargedOrder,intent:chargedIntent,providerPayload:{private:'PRIVATE_PROVIDER_PROOF'}});
    await t.test('provider reversal freezes actual exposure without posting unpaid commission estimates',async()=>{
      assert.equal(dispute.amountMinor,1000);assert.equal((await CommissionEntry.findById(estimated._id)).status,'reversed');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'chargeback-commission:'+dispute.publicId+':'+estimated.publicId}),0);assert.equal(dispute.commissionReversals[0].posted,false);
      const page=await owner.client.get('/finance/disputes?selected='+dispute.publicId).set('accept','application/json').expect(200);assert.equal(page.body.selected.amountMinor,1000);assert.equal(page.body.metrics[0].value,1);const text=JSON.stringify(page.body);for(const secret of ['PRIVATE_PROVIDER_PROOF','providerPayloadHash','providerTrackingId','PRIVATE_BUYER','commissionReversals'])assert.ok(!text.includes(secret));
    });
    await t.test('review audit failure rolls the state back, then concurrent reviews claim only once',async()=>{
      const create=AuditLog.create;AuditLog.create=function(...args){if(args[0]?.[0]?.action==='finance.chargeback_reviewed')throw new Error('audit fixture failure');return create.apply(this,args);};try{await assert.rejects(reviewChargeback(context(owner),dispute.publicId,'Inspect original payment and provider reversal'),/audit fixture failure/);}finally{AuditLog.create=create;}
      assert.equal((await Chargeback.findById(dispute._id)).status,'open');const results=await Promise.allSettled([reviewChargeback(context(owner),dispute.publicId,'Independent review of original provider evidence'),reviewChargeback(context(owner),dispute.publicId,'Concurrent review of provider evidence')]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(await AuditLog.countDocuments({action:'finance.chargeback_reviewed',targetPublicId:dispute.publicId}),1);
    });
    proofs.set(chargedIntent.providerTrackingId,{payment_status_description:'REVERSED',amount:1000,currency:'UGX',merchant_reference:chargedIntent.providerReference});
    await t.test('four-eyes and independent proof prevent arbitrary recovery of funds',async()=>{
      await assert.rejects(resolveChargeback(context(owner),dispute.publicId,{outcome:'won',note:'Confirm disputed payment recovery'}),error=>error.code==='FOUR_EYES_REQUIRED');
      await assert.rejects(resolveChargeback(context(foreign),dispute.publicId,{outcome:'won',note:'Confirm foreign payment recovery'}),error=>error.status===403);
      await assert.rejects(resolveChargeback(context(second),dispute.publicId,{outcome:'won',note:'Attempt recovery while provider still reversed'}),error=>error.code==='CHARGEBACK_PROVIDER_UNCONFIRMED');assert.equal((await Chargeback.findById(dispute._id)).status,'reviewing');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'chargeback-win:'+dispute.publicId}),0);
      proofs.set(chargedIntent.providerTrackingId,{payment_status_description:'COMPLETED',amount:1000,currency:'UGX',merchant_reference:'WRONG_REFERENCE'});await assert.rejects(resolveChargeback(context(second),dispute.publicId,{outcome:'won',note:'Provider reference must match the original intent'}),error=>error.code==='CHARGEBACK_PROVIDER_UNCONFIRMED');
    });
    await t.test('HTTP resolution restores only verified exposure exactly once and restores unposted estimates',async()=>{
      proofs.set(chargedIntent.providerTrackingId,{payment_status_description:'COMPLETED',amount:1000,currency:'UGX',merchant_reference:chargedIntent.providerReference});const html=await second.client.get('/finance/disputes?selected='+dispute.publicId).expect(200);assert.match(html.text,/Verify &amp; Resolve/);
      const resolved=await second.client.post('/finance/disputes/'+dispute.publicId+'/resolve').set('accept','application/json').set('x-csrf-token',csrf(html.text)).send({outcome:'won',note:'Pesapal independently confirms restored payment'}).expect(200);assert.equal(resolved.body.record.status,'won');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'chargeback-win:'+dispute.publicId}),1);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'chargeback-win-commission:'+dispute.publicId+':'+estimated.publicId}),0);assert.equal((await CommissionEntry.findById(estimated._id)).status,'partially_reversed');assert.equal((await CommissionEntry.findById(estimated._id)).reversedAmountMinor,10);assert.equal((await Order.findById(chargedOrder._id)).paymentState,'paid');
      await assert.rejects(resolveChargeback(context(second),dispute.publicId,{outcome:'won',note:'Duplicate provider-confirmed recovery'}),error=>error.code==='CHARGEBACK_NOT_FOUND');assert.equal(await AuditLog.countDocuments({action:'finance.chargeback_resolved',targetPublicId:dispute.publicId}),1);
    });
    await t.test('revoking operator authorization during provider verification prevents ledger mutation',async()=>{
      const nextOrder=await order(),nextIntent=await payment(nextOrder);await paymentLedger(nextOrder,nextIntent);const nextDispute=await recordProviderChargeback({order:nextOrder,intent:nextIntent});await reviewChargeback(context(owner),nextDispute.publicId,'Inspect recorded reversal before recovery');const revoked=await actor();proofs.set(nextIntent.providerTrackingId,{payment_status_description:'COMPLETED',amount:1000,currency:'UGX',merchant_reference:nextIntent.providerReference});providerHook=()=>User.updateOne({_id:revoked.user._id},{$inc:{'security.tokenVersion':1,__v:1}});
      await assert.rejects(resolveChargeback(context(revoked),nextDispute.publicId,{outcome:'won',note:'Verify recovered payment before applying funds'}),error=>error.code==='ACCOUNT_UNAVAILABLE');assert.equal((await Chargeback.findById(nextDispute._id)).status,'reviewing');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'chargeback-win:'+nextDispute.publicId}),0);
    });
    await t.test('partial refunds reduce actual reversed exposure and a verified loss keeps it protected',async()=>{
      const partialOrder=await order(),partialIntent=await payment(partialOrder);await paymentLedger(partialOrder,partialIntent);
      const refund=await Refund.create({publicId:'rfd_partial_'+suffix,idempotencyKey:'partial_refund_'+suffix,orderId:partialOrder._id,paymentIntentId:partialIntent._id,amountMinor:250,currency:'UGX',reason:'Previously completed partial refund',status:'completed',completedAt:new Date()});
      await assert.rejects(recordProviderChargeback({order:partialOrder,intent:partialIntent}),error=>error.code==='CHARGEBACK_REFUND_LEDGER_MISSING');assert.equal(await Chargeback.countDocuments({paymentIntentId:partialIntent._id}),0);
      const cash=await LedgerAccount.findOne({code:'provider_clearing',country:'UG',currency:'UGX'}),revenue=await LedgerAccount.findOne({code:'platform_revenue',country:'UG',currency:'UGX'});
      await postLedgerTransaction({country:'UG',currency:'UGX',idempotencyKey:'refund:'+refund.publicId,referenceType:'refund',referencePublicId:refund.publicId,description:'Posted partial refund fixture',entries:[{account:revenue,debitMinor:250,creditMinor:0},{account:cash,debitMinor:0,creditMinor:250}]});
      const partial=await recordProviderChargeback({order:partialOrder,intent:partialIntent});assert.equal(partial.amountMinor,750);const reversal=await LedgerTransaction.findOne({idempotencyKey:'chargeback:'+partialIntent.publicId});assert.equal(reversal.entries.reduce((sum,row)=>sum+row.debitMinor,0),750);
      await reviewChargeback(context(owner),partial.publicId,'Review remaining exposure after the completed refund');proofs.set(partialIntent.providerTrackingId,{payment_status_description:'REVERSED',amount:1000,currency:'UGX',merchant_reference:partialIntent.providerReference});const lost=await resolveChargeback(context(second),partial.publicId,{outcome:'lost',note:'Pesapal independently confirms the payment remains reversed'});assert.equal(lost.status,'lost');assert.equal((await Order.findById(partialOrder._id)).paymentState,'failed');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'chargeback-win:'+partial.publicId}),0);
    });
    await t.test('COD checks ready evidence, country, amount and independent handover before atomic posting',async()=>{
      const codOrder=await order('UG','cod'),seller=await actor('UG','seller'),receiver=await actor('UG','warehouse');
      const store=await Store.create({publicId:'sto_fc_cod_'+suffix,ownerUserId:seller.user._id,name:'Actual COD supplier',slug:'cod-supplier-'+suffix,country:'UG',currency:'UGX',status:'verified'});
      const warehouse=await Warehouse.create({publicId:'wh_fc_cod_'+suffix,storeId:store._id,ownerUserId:seller.user._id,name:'COD receiving warehouse',country:'UG',city:'Kampala',address:'Actual supplier receiving location'});
      const item=codOrder.items[0];item.storeId=store._id;item.storePublicId=store.publicId;
      const stock=await StockItem.create({publicId:'stk_fc_cod_'+suffix,storeId:store._id,warehouseId:warehouse._id,variantId:item.variantId,onHand:5});
      await InventoryReservation.create({publicId:item.reservationPublicId,idempotencyKey:'cod_allocation_'+suffix,storeId:store._id,stockItemId:stock._id,variantId:item.variantId,quantity:item.quantity,status:'committed',committedAt:new Date(),expiresAt:new Date(Date.now()+86400000),actorUserId:customer.user._id});
      codOrder.status='confirmed';codOrder.paymentState='pending';await codOrder.save();const codIntent=await payment(codOrder,'pending_collection','cod');
      const grant=await PlatformGrant.create({publicId:'pgr_fc_cod_'+suffix,userId:receiver.user._id,role:'warehouse',operationalCountries:['UG'],warehouseScopes:[warehouse.publicId],startsAt:new Date(Date.now()-60000),expiresAt:new Date(Date.now()+3600000),status:'active',reason:'Independently approved scoped cash receipt review',approvalPublicId:'apr_fc_cod_'+suffix,approvedByUserId:owner.user._id});
      await User.updateOne({_id:receiver.user._id},{$set:{platformAccessManagedAt:new Date(),phoneVerifiedAt:new Date()}});
      const driver=new mongoose.Types.ObjectId();const shipment=await Shipment.create({publicId:'shp_fc_'+suffix,orderId:codOrder._id,orderPublicId:codOrder.publicId,country:'UG',mode:'standard',status:'delivered',deliveredAt:new Date(Date.now()-1000),deliveryUserId:driver,cod:{required:true,amountMinor:1000,currency:'UGX',collectedMinor:1000,handoverDeclaredMinor:1000,handoverAt:new Date(),handoverByUserId:driver}});
      await assert.rejects(reconcileCod({shipment,actorUserId:owner.user._id}),error=>error.code==='FINANCE_SESSION_REQUIRED');await assert.rejects(reconcileCod({shipment,request:context(foreign)}),error=>error.status===403);await assert.rejects(reconcileCod({shipment,request:context(owner)}),error=>error.code==='COD_HANDOVER_REQUIRED');
      const receipt=await EvidenceDocument.create({publicId:'evd_fc_'+suffix,ownerUserId:driver,country:'UG',contextType:'delivery_job',contextPublicId:shipment.publicId,documentType:'cod_handover',storageKey:'PRIVATE_RECEIPT_STORAGE',mimeType:'image/webp',size:50,status:'ready'});shipment.cod.handoverEvidenceDocumentId=receipt._id;await shipment.save();
      await Shipment.updateOne({_id:shipment._id},{$set:{'cod.handoverByUserId':owner.user._id}});await assert.rejects(reconcileCod({shipment,request:context(owner)}),error=>error.code==='FOUR_EYES_REQUIRED');await Shipment.updateOne({_id:shipment._id},{$set:{'cod.handoverByUserId':driver}});
      const page=await owner.client.get('/finance/reconciliation?view=cod&selected='+shipment.publicId).expect(200);assert.doesNotMatch(page.text,/Verify &amp; Reconcile Cash/);assert.ok(!page.text.includes('PRIVATE_RECEIPT_STORAGE'));
      const reconcilePath='/finance/reconciliation/cod/'+shipment.publicId+'/reconcile',financeToken=csrf(page.text);
      const unreviewed=await owner.client.post(reconcilePath).set('accept','application/json').set('x-csrf-token',financeToken).send({}).expect(409);assert.equal(unreviewed.body.error.code,'COD_WAREHOUSE_REVIEW_REQUIRED');
      assert.equal((await PaymentIntent.findById(codIntent._id)).status,'pending_collection');assert.equal((await Order.findById(codOrder._id)).paymentState,'pending');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'cod:'+shipment.publicId}),0);
      const receivingPage=await receiver.client.get('/warehouse/deliveries?record='+shipment.publicId).expect(200),receiptToken=csrf(receivingPage.text),reviewPath='/warehouse/deliveries/'+shipment.publicId+'/review-cod';
      const reviewVersion=(await Shipment.findById(shipment._id)).__v,reviewBody={version:reviewVersion,reason:'Independently received the physical cash and checked the exact private handover receipt.'};
      await PlatformGrant.updateOne({_id:grant._id},{$set:{status:'suspended'}});await receiver.client.post(reviewPath).set('accept','application/json').set('x-csrf-token',receiptToken).send(reviewBody).expect(403);await PlatformGrant.updateOne({_id:grant._id},{$set:{status:'active'}});
      const stale=await receiver.client.post(reviewPath).set('accept','application/json').set('x-csrf-token',receiptToken).send({...reviewBody,version:reviewVersion+1}).expect(409);assert.equal(stale.body.error.code,'DELIVERY_VERSION_CONFLICT');
      const device=await Device.findOne({userId:receiver.user._id,revokedAt:null});assert.ok(device);
      await receiver.client.post(reviewPath).set('accept','application/json').set('x-csrf-token',receiptToken).send(reviewBody).expect(200);
      const reviewed=await Shipment.findById(shipment._id);assert.equal(String(reviewed.cod.reviewedByUserId),String(receiver.user._id));assert.ok(reviewed.cod.reviewedAt);assert.equal(reviewed.__v,reviewVersion+1);
      assert.equal((await PlatformGrant.findById(grant._id)).__v,grant.__v+1);assert.equal((await Device.findById(device._id)).__v,device.__v+1);assert.equal(await AuditLog.countDocuments({action:'warehouse.cod_receipt_reviewed',targetPublicId:shipment.publicId}),1);
      const readyPage=await owner.client.get('/finance/reconciliation?view=cod&selected='+shipment.publicId).expect(200);assert.match(readyPage.text,/Verify &amp; Reconcile Cash/);
      await owner.client.post('/finance/reconciliation/cod/'+shipment.publicId+'/reconcile').set('accept','application/json').set('x-csrf-token',csrf(readyPage.text)).send({}).expect(200);assert.equal((await PaymentIntent.findById(codIntent._id)).status,'succeeded');assert.equal((await Order.findById(codOrder._id)).paymentState,'paid');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'cod:'+shipment.publicId}),1);await reconcileCod({shipment,request:context(owner)});assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'cod:'+shipment.publicId}),1);assert.equal(await AuditLog.countDocuments({action:'finance.cod_reconciled',targetPublicId:shipment.publicId}),1);
    });
    await t.test('reconciliation requires one configured market and stores actual provider outcomes',async()=>{
      const pendingOrder=await order(),pendingIntent=await payment(pendingOrder,'pending');proofs.set(pendingIntent.providerTrackingId,{payment_status_description:'PENDING',amount:1000,currency:'UGX',merchant_reference:pendingIntent.providerReference});proofs.set(intent.providerTrackingId,{payment_status_description:'PENDING',amount:1000,currency:'UGX',merchant_reference:intent.providerReference});
      const page=await owner.client.get('/finance/reconciliation').expect(200);const result=await owner.client.post('/finance/reconciliation/runs').set('accept','application/json').set('x-csrf-token',csrf(page.text)).send({country:'UG',hours:24}).expect(200);assert.equal(result.body.record.country,'UG');assert.ok(result.body.record.checked>=2);assert.ok(result.body.record.matched>=2);assert.equal(await AuditLog.countDocuments({action:'finance.reconciliation_started',targetPublicId:result.body.record.publicId}),1);
      await owner.client.post('/finance/reconciliation/runs').set('accept','application/json').set('x-csrf-token',csrf(page.text)).send({country:'KE',hours:24}).expect(403);assert.equal((await PaymentIntent.findById(pendingIntent._id)).status,'pending');
    });
    await t.test('CSV export aborts after authorization revocation while the response is streaming',async()=>{
      const exporter=await actor(),response=new EventEmitter(),chunks=[];let ended=false;
      response.type=()=>response;response.set=()=>response;response.destroyed=false;response.end=()=>{ended=true;};
      response.write=chunk=>{chunks.push(chunk);if(chunks.length===2){User.updateOne({_id:exporter.user._id},{$inc:{'security.tokenVersion':1,__v:1}}).then(()=>response.emit('drain'));return false;}return true;};
      await assert.rejects(streamFinanceReconciliationCsv(context(exporter),response,'finance-reconciliation'),error=>error.code==='ACCOUNT_UNAVAILABLE');assert.equal(chunks.length,2);assert.equal(ended,false);assert.equal(await AuditLog.countDocuments({action:'finance.reconciliation_exported',actorId:exporter.user._id}),1);
    });
  }finally{globalThis.fetch=originalFetch;for(const transport of transports)transport.destroy();for(const Model of Object.values(mongoose.connection.models))await Model.init();await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
