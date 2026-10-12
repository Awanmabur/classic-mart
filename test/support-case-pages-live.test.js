import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

const suffix=crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV='test';process.env.SIMPLE_LOGIN='false';process.env.PRIVILEGED_MFA_REQUIRED='true';process.env.MAIL_MODE='log';process.env.SMS_MODE='log';process.env.REDIS_URL='';
process.env.UPLOAD_DIR=`/tmp/classicmart-support-case-media-${suffix}`;process.env.MEDIA_STORAGE_DRIVER='filesystem';
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Support return receipts, inspections, Finance referrals and escalation decisions use scoped authoritative records', {skip:!uri,timeout:180_000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/verification|test/i);
  await mongoose.connect(uri,{dbName:`classicmart_support_cases_test_${suffix}`});const transports=[];
  try{
    const {createApp}=await import('../src/app.js');
    const {User,PlatformGrant,CountrySetting,Store,Category,Product,ProductVariant,Warehouse,StockItem,Order,SellerOrder,Shipment,
      ReturnRequest,WarehouseTask,EvidenceDocument,Dispute,Refund,Notification,AuditLog,SupportTicket,InventoryMovement,InventoryReservation}=await import('../src/models/index.js');
    const trust=await import('../src/services/trust.js'),cases=await import('../src/services/support-case-pages.js');
    const {mutateWarehouse}=await import('../src/services/warehouse-operations.js');
    const {hashPassword}=await import('../src/core/crypto.js'),{encryptSensitive}=await import('../src/core/sensitive.js'),{totpCode}=await import('../src/services/mfa.js');
    await Promise.all(Object.values(mongoose.models).map(Model=>Model.init()));
    await CountrySetting.create([{code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'},
      {code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254'},
      {code:'TZ',name:'Private market',currency:'TZS',locale:'en-TZ',timeZone:'Africa/Dar_es_Salaam',phonePrefix:'+255'}]);
    const password=`Cases-${suffix}-A1!`,passwordHash=await hashPassword(password),secret='JBSWY3DPEHPK3PXP';let sequence=0;
    const id=kind=>`${kind}_sc_${suffix}_${++sequence}`;
    async function actor(role,{managed=false,countries=['UG','KE'],login=false}={}){
      const number=++sequence,email=`cases-${suffix}-${number}@example.com`,phone='+25670'+String(number).padStart(7,'0');
      const user=await User.create({publicId:id('usr'),name:`Case operator ${number}`,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,
        country:countries[0],currency:countries[0]==='KE'?'KES':'UGX',operationalCountries:countries,emailVerifiedAt:new Date(),onboardingCompletedAt:new Date(),platformAccessManagedAt:managed?new Date():undefined,
        security:{mfaEnabled:true,mfaSecretEncrypted:encryptSensitive(secret)},consents:{terms:true,privacy:true,recordedAt:new Date()}});
      const grant=managed?await PlatformGrant.create({publicId:id('pgr'),userId:user._id,role:managed==='warehouse'?'warehouse':'support',operationalCountries:countries,status:'active',startsAt:new Date(Date.now()-60_000),expiresAt:new Date(Date.now()+86400_000),reason:'Scoped complete case fixture',approvalPublicId:id('apr'),approvedByUserId:new mongoose.Types.ObjectId()}):null;
      let client;if(login){const transport=new http.Agent({localAddress:`127.0.0.${number%100+100}`,keepAlive:false});transports.push(transport);client=request.agent(createApp(null)).use(req=>req.agent(transport));
        const page=await client.get('/login').expect(200);await client.post('/login').type('form').send({email,password,_csrf:csrf(page.text)}).expect(302).expect('location','/mfa');
        const challenge=await client.get('/mfa').expect(200);await client.post('/mfa').type('form').send({code:totpCode(secret),_csrf:csrf(challenge.text)}).expect(302);}
      return {user,grant,client};
    }
    const support=await actor('customer',{managed:true,login:true}),second=await actor('support'),buyer=await actor('customer'),warehouseActor=await actor('customer',{managed:'warehouse',login:true}),seller=await actor('seller');
    const req=(entry=support,query={})=>({id:id('req'),user:entry.user,session:{tokenVersion:entry.user.security.tokenVersion},query,country:{code:'TZ'},ip:'127.0.0.1',get:()=> 'SupportCaseTest/1.0'});
    const category=await Category.create({publicId:id('cat'),name:'Case goods',slug:id('category'),countries:['UG','KE','TZ']});
    const store=await Store.create({publicId:id('sto'),ownerUserId:seller.user._id,name:'Case store',slug:id('store'),country:'UG',currency:'UGX',status:'verified'});
    const product=await Product.create({publicId:id('prd'),storeId:store._id,ownerUserId:seller.user._id,categoryId:category._id,title:'Verified goods',slug:id('product'),description:'Complete return fixture product',countries:['UG'],status:'published'});
    const variant=await ProductVariant.create({publicId:id('var'),productId:product._id,storeId:store._id,sku:id('sku').toUpperCase(),title:'Standard',priceMinor:10000,costMinor:5000,currency:'UGX'});
    const warehouse=await Warehouse.create({publicId:id('whs'),storeId:store._id,ownerUserId:seller.user._id,name:'Receiving warehouse',country:'UG',city:'Kampala',address:'Actual fixture warehouse'});
    const stock=await StockItem.create({publicId:id('stk'),storeId:store._id,warehouseId:warehouse._id,variantId:variant._id,onHand:12,reserved:0,damaged:0,quarantined:0});
    await PlatformGrant.updateOne({_id:warehouseActor.grant._id},{$set:{warehouseScopes:[warehouse.publicId]}});
    async function orderFixture({country='UG',resolution='refund',method='dropoff',openReturn=true}={}){
      const currency=country==='KE'?'KES':country==='TZ'?'TZS':'UGX',lineId=id('oli'),orderId=id('ord');
      const item={linePublicId:lineId,productId:product._id,variantId:variant._id,storeId:store._id,reservationPublicId:id('rsv'),productPublicId:product.publicId,variantPublicId:variant.publicId,storePublicId:store.publicId,title:product.title,variantTitle:variant.title,sku:variant.sku,quantity:2,deliveredQuantity:2,unitPriceMinor:10000,lineTotalMinor:20000,currency};
      const order=await Order.create({publicId:orderId,idempotencyKey:id('checkout'),checkoutId:id('checkout'),cartPublicId:id('crt'),sessionKey:id('session'),userId:buyer.user._id,country,status:'paid',paymentState:'paid',fulfillmentState:'delivered',deliveryMethod:'standard',paymentMethod:'card',
        contact:{fullName:buyer.user.name,email:buyer.user.email,phone:buyer.user.phone,address:'Private fixture address',city:'Kampala',country},totals:{subtotalMinor:20000,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:20000,currency},items:[item],reservationExpiresAt:new Date(Date.now()+86400_000)});
      await Shipment.create({publicId:id('shp'),orderId:order._id,orderPublicId:order.publicId,country,kind:'outbound',mode:'standard',status:'delivered',deliveredAt:new Date(),proof:{type:'otp',reference:'verified',recordedAt:new Date()}});
      await SellerOrder.create({publicId:id('sord'),orderId:order._id,orderPublicId:order.publicId,storeId:store._id,storePublicId:store.publicId,country,status:'fulfilled',subtotalMinor:20000,platformFeeMinor:1000,currency,
        items:[{orderLineId:lineId,productPublicId:product.publicId,variantPublicId:variant.publicId,title:product.title,variantTitle:variant.title,sku:variant.sku,quantity:2,unitPriceMinor:10000,lineTotalMinor:20000,currency,grossMinor:20000,customerPaidMinor:20000,platformFeeMinor:1000,sellerReceivableMinor:19000}]});
      const returned=openReturn?(await trust.createReturnRequest(req(buyer),{orderId:order.publicId,items:[{orderLineId:lineId,quantity:1}],reason:'damaged',details:'Delivered goods require an evidenced return review.',resolution,returnMethod:method})).returnRequest:null;
      return {order,returned,lineId};
    }
    const primary=await orderFixture(),foreign=await orderFixture({country:'TZ'});
    const currentVersion=async row=>(await ReturnRequest.findById(row._id)).__v;
    const image=await sharp({create:{width:360,height:360,channels:3,background:'#ffffff'}}).png().toBuffer();
    await t.test('scoped real queues separate currency, full counts and private operational data',async()=>{
      for(let i=0;i<28;i++)await orderFixture({country:i%2?'KE':'UG'});
      const page=await cases.loadSupportCasePage(req(), 'support-returns');assert.equal(page.page.total,29);assert.equal(page.items.length,25);assert.equal(page.metrics[0].value,'29');assert.equal(page.page.hasMore,true);
      const next=await cases.loadSupportCasePage(req(support,{after:page.page.next}),'support-returns');assert.equal(next.items.length,4);assert.ok(!next.items.some(row=>page.items.some(first=>first.publicId===row.publicId)));
      const ke=await cases.loadSupportCasePage(req(support,{country:'KE'}),'support-returns');assert.equal(ke.page.total,14);assert.ok(ke.items.every(row=>row.country==='KE'&&row.currency==='KES'));
      assert.ok(!JSON.stringify(page).includes(foreign.returned.publicId));assert.ok(!JSON.stringify(page).includes(buyer.user.email));assert.ok(!JSON.stringify(page).includes('pickupCodeHash'));
      await assert.rejects(cases.loadSupportCasePage(req(support,{country:'TZ'}),'support-returns'),error=>error.status===403);
      await assert.rejects(cases.loadSupportCasePage(req(support,{after:'broken-cursor'}),'support-returns'),error=>error.code==='SUPPORT_CURSOR_INVALID');
    });
    await t.test('approval requires CSRF/version and creates an actual buyer update without inventory or money changes',async()=>{
      const page=await support.client.get('/support/returns?record='+primary.returned.publicId).expect(200);
      const input={version:await currentVersion(primary.returned),decision:'approve',note:'Delivered damaged goods approved for evidenced return intake.'};
      await support.client.post('/support/returns/'+primary.returned.publicId+'/decision').send(input).set('Accept','application/json').expect(403);
      await support.client.post('/support/returns/'+primary.returned.publicId+'/decision').set('x-csrf-token',csrf(page.text)).send(input).set('Accept','application/json').expect(200);
      assert.equal((await ReturnRequest.findById(primary.returned._id)).status,'awaiting_return');assert.equal((await StockItem.findById(stock._id)).onHand,12);assert.equal(await Refund.countDocuments(),0);
      assert.equal(await Notification.countDocuments({userId:buyer.user._id,type:'return_update'}),1);
      await assert.rejects(cases.decideSupportReturn(req(),primary.returned.publicId,input),error=>error.code==='SUPPORT_CASE_VERSION_CONFLICT');
      await assert.rejects(cases.receiveSupportReturn(req(),primary.returned.publicId,{version:await currentVersion(primary.returned)}),error=>error.code==='RETURN_INTAKE_REQUIRED');
    });
    await t.test('physical receipt rejects Support, missing/foreign proof, reused line proof and stale warehouse scopes',async()=>{
      const body={version:await currentVersion(primary.returned),orderLineId:primary.lineId,warehousePublicId:warehouse.publicId};
      await assert.rejects(cases.recordWarehouseReturnIntake(req(),primary.returned.publicId,body),error=>error.code==='WAREHOUSE_PERMISSION_DENIED');
      await assert.rejects(cases.recordWarehouseReturnIntake(req(warehouseActor),primary.returned.publicId,body),error=>error.code==='RETURN_INTAKE_EVIDENCE_REQUIRED');
      await PlatformGrant.updateOne({_id:warehouseActor.grant._id},{$set:{warehouseScopes:[id('whs')]}});
      await assert.rejects(cases.uploadWarehouseReturnIntakeEvidence(req(warehouseActor),primary.returned.publicId,body,{buffer:image,mimetype:'image/png'}),error=>error.status===403);
      await PlatformGrant.updateOne({_id:warehouseActor.grant._id},{$set:{warehouseScopes:[warehouse.publicId]}});
      const wrong=await EvidenceDocument.create({publicId:id('evd'),ownerUserId:warehouseActor.user._id,country:'UG',contextType:'return',contextPublicId:primary.returned.publicId,contextLinePublicId:id('oli'),documentType:'return_receipt',storageKey:'private/wrong.webp',mimeType:'image/webp',size:500,status:'ready'});
      await ReturnRequest.updateOne({_id:primary.returned._id},{$push:{evidenceDocumentIds:wrong._id}});
      await assert.rejects(cases.recordWarehouseReturnIntake(req(warehouseActor),primary.returned.publicId,{...body,evidencePublicId:wrong.publicId}),error=>error.code==='RETURN_INTAKE_EVIDENCE_REQUIRED');
    });
    await t.test('real sanitized warehouse receipt creates exact inspection task and never adds stock before inspection',async()=>{
      const body={version:await currentVersion(primary.returned),orderLineId:primary.lineId,warehousePublicId:warehouse.publicId};
      const evidence=await cases.uploadWarehouseReturnIntakeEvidence(req(warehouseActor),primary.returned.publicId,body,{buffer:image,mimetype:'image/png'});
      const queue=await cases.loadWarehouseReturnIntakes(req(warehouseActor));const queued=queue.items.find(row=>row.publicId===primary.returned.publicId);assert.ok(queued.lines[0].receipts.some(row=>row.publicId===evidence.evidencePublicId));
      const received=await cases.recordWarehouseReturnIntake(req(warehouseActor),primary.returned.publicId,{...body,version:evidence.version,evidencePublicId:evidence.evidencePublicId});assert.equal(received.status,'received');assert.ok(received.warehouseTaskPublicId);
      assert.equal((await StockItem.findById(stock._id)).onHand,12);assert.equal((await Order.findById(primary.order._id)).items[0].returnedQuantity,1);
      await assert.rejects(cases.inspectSupportReturn(req(),primary.returned.publicId,{version:received.version,condition:'damaged',notes:'Inspected physical returned goods.'}),error=>error.code==='RETURN_WAREHOUSE_INSPECTION_REQUIRED');
      const task=await WarehouseTask.findOne({publicId:received.warehouseTaskPublicId});await mutateWarehouse({...req(warehouseActor),params:{publicId:task.publicId},body:{version:task.__v}},'claim');
      const claimed=await WarehouseTask.findById(task._id);await mutateWarehouse({...req(warehouseActor),params:{publicId:task.publicId},body:{version:claimed.__v,disposition:'damaged'}},'execute');
      assert.equal((await StockItem.findById(stock._id)).onHand,13);assert.equal((await StockItem.findById(stock._id)).damaged,1);assert.equal(await InventoryMovement.countDocuments({reference:primary.returned.publicId,type:'return'}),1);
    });
    await t.test('inspection and idempotent Finance referral keep Support away from refund disbursement',async()=>{
      const before=await currentVersion(primary.returned);await assert.rejects(cases.inspectSupportReturn(req(),primary.returned.publicId,{version:before,condition:'good',notes:'The physical warehouse disposition was damaged.'}),error=>error.code==='RETURN_INSPECTION_CONFLICT');
      const inspected=await cases.inspectSupportReturn(req(),primary.returned.publicId,{version:before,condition:'damaged',notes:'Confirmed damaged condition from completed warehouse inspection.'});assert.equal(inspected.status,'refund_pending');
      const referral=await cases.referSupportReturnToFinance(req(),primary.returned.publicId,{version:inspected.version,note:'Completed exact goods inspection ready for independent refund review.'});assert.equal(referral.status,'refund_pending');
      const duplicate=await cases.referSupportReturnToFinance(req(),primary.returned.publicId,{version:inspected.version,note:'Retry the same genuine Finance referral.'});assert.equal(duplicate.alreadyReferred,true);assert.equal(await Refund.countDocuments(),0);
      const returned=await ReturnRequest.findById(primary.returned._id),order=await Order.findById(primary.order._id);const snapshot=await cases.returnFinancialAllocations({returnRequest:returned,order});assert.equal(snapshot.amountMinor,10000);assert.equal(snapshot.allocations[0].orderLineId,primary.lineId);
      const task=await WarehouseTask.findOne({returnRequestId:returned._id});await WarehouseTask.updateOne({_id:task._id},{$set:{'result.disposition':'good'}});
      await assert.rejects(cases.returnFinancialAllocations({returnRequest:returned,order}),error=>error.code==='RETURN_FINANCE_SNAPSHOT_INVALID');await WarehouseTask.updateOne({_id:task._id},{$set:{'result.disposition':'damaged'}});
    });
    await t.test('audit failure rolls decisions, account fences, buyer notices and goods reservations back',async()=>{
      const fixture=await orderFixture(),version=await currentVersion(fixture.returned),before=await User.findById(support.user._id).lean(),notices=await Notification.countDocuments();
      t.mock.method(AuditLog,'create',async()=>{throw new Error('Authoritative case audit unavailable');});
      await assert.rejects(cases.decideSupportReturn(req(),fixture.returned.publicId,{version,decision:'reject',note:'Rejecting an ineligible request after complete review.'}),/Authoritative case audit unavailable/);t.mock.restoreAll();
      assert.equal((await ReturnRequest.findById(fixture.returned._id)).status,'requested');assert.equal((await Order.findById(fixture.order._id)).items[0].returnReservedQuantity,1);assert.equal((await User.findById(support.user._id)).__v,before.__v);assert.equal(await Notification.countDocuments(),notices);
    });
    let disputed;
    await t.test('case claims and reviews are scoped, versioned, private and have a real customer reply counterpart',async()=>{
      disputed=await trust.createDispute(req(buyer),{orderId:primary.order.publicId,category:'refund',subject:'Return refund review',description:'Please review the actual inspected returned goods refund.'});
      const attempts=await Promise.allSettled([support,second].map(entry=>cases.assignSupportDispute(req(entry),disputed.publicId,{version:0})));assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);
      const row=await Dispute.findById(disputed._id),winner=same(row.assignedUserId,support.user._id)?support:second,loser=winner===support?second:support;
      await assert.rejects(cases.reviewSupportDispute(req(loser),row.publicId,{version:row.__v,notes:'Private internal evidence review details.',message:'We are reviewing your inspected return.'}),error=>error.code==='DISPUTE_ASSIGNMENT_REQUIRED');
      const reviewed=await cases.reviewSupportDispute(req(winner),row.publicId,{version:row.__v,notes:'PRIVATE_INTERNAL_CASE_NOTES: verified receipt and exact warehouse stock disposition.',message:'Please confirm which returned item needs further review.',status:'awaiting_customer'});
      const replied=await cases.replyToOwnedDispute(req(buyer),row.publicId,{version:reviewed.version,message:'The exact damaged returned line needs a payment review.'});assert.equal(replied.status,'investigating');assert.ok(!JSON.stringify(replied).includes('PRIVATE_INTERNAL_CASE_NOTES'));
      await assert.rejects(cases.replyToOwnedDispute(req(seller),row.publicId,{version:replied.version,message:'Attempt to reply to another customer case.'}),error=>error.code==='DISPUTE_NOT_FOUND');
      // Keep the rest of the case steps under the same current owning operator.
      disputed=await Dispute.findById(disputed._id);disputed.testWinner=winner;
    });
    await t.test('real departmental referrals never stand in for completed money or exchange',async()=>{
      const winner=disputed.testWinner,row=await Dispute.findById(disputed._id);
      const referral=await cases.escalateSupportDispute(req(winner),row.publicId,{version:row.__v,department:'finance',reason:'Exact inspected returned goods require an independent payment review.',message:'Finance will review the inspected return before confirming any refund.'});
      const current=await Dispute.findById(row._id),ticket=await SupportTicket.findOne({publicId:current.escalation.referralTicketPublicId});assert.ok(ticket);assert.equal(ticket.status,'escalated');assert.equal(ticket.source,'staff');assert.equal(referral.status,'investigating');
      await assert.rejects(cases.resolveSupportDispute(req(winner),row.publicId,{version:current.__v,decision:'refund_confirmed',summary:'Claim the refund has been completed without a payment record.'}),error=>error.code==='DISPUTE_REFUND_UNCONFIRMED');
      await assert.rejects(cases.resolveSupportDispute(req(winner),row.publicId,{version:current.__v,decision:'exchange_confirmed',summary:'Claim a replacement exists without any reserved stock.'}),error=>error.code==='DISPUTE_EXCHANGE_UNCONFIRMED');
      const resolved=await cases.resolveSupportDispute(req(winner),row.publicId,{version:current.__v,decision:'customer_service',summary:'The return process and outstanding Finance review were explained; the service question is resolved.'});assert.equal(resolved.status,'resolved');
      await assert.rejects(cases.reviewSupportDispute(req(winner),row.publicId,{version:resolved.version,notes:'Try to change an already completed case decision.',message:'Attempt to overwrite completed case.'}),error=>error.code==='DISPUTE_STATE');
    });
    await t.test('current grant, MFA, email, onboarding and session state protect direct service writes',async()=>{
      const denied=await actor('customer',{managed:true}),fixture=await orderFixture();
      for(const patch of [{status:'suspended'},{'security.mfaEnabled':false},{'security.tokenVersion':1},{emailVerifiedAt:null},{onboardingCompletedAt:null}]){
        await User.updateOne({_id:denied.user._id},{$set:patch});await assert.rejects(cases.decideSupportReturn(req(denied),fixture.returned.publicId,{version:fixture.returned.__v,decision:'approve',note:'Valid request cannot override revoked operator access.'}),error=>error.status===403);
        await User.updateOne({_id:denied.user._id},{$set:{status:'active','security.mfaEnabled':true,'security.tokenVersion':0,emailVerifiedAt:new Date(),onboardingCompletedAt:new Date()}});
      }
      await PlatformGrant.updateOne({_id:denied.grant._id},{$set:{status:'revoked'}});await assert.rejects(cases.loadSupportCasePage(req(denied),'support-returns'),error=>error.status===403);
      for(const role of ['customer','seller','promoter','finance','warehouse','country_admin','super_admin']){const outsider=await actor(role);await assert.rejects(cases.loadSupportCasePage(req(outsider),'support-returns'),error=>error.status===403);}
    });
    await t.test('private evidence requires current scoped case linkage and exports contain no buyer or internal-note data',async()=>{
      const selected=await cases.loadSupportCasePage(req(support,{record:primary.returned.publicId}),'support-returns');assert.ok(selected.selected.evidence.length);
      const evidence=await cases.supportEvidenceRecord(req(),selected.selected.evidence[0].publicId);assert.ok(evidence.storageKey);
      await EvidenceDocument.updateOne({_id:evidence._id},{$set:{status:'rejected'}});await assert.rejects(cases.supportEvidenceRecord(req(),evidence.publicId),error=>error.status===404);await EvidenceDocument.updateOne({_id:evidence._id},{$set:{status:'ready'}});
      const exported=await support.client.get('/support/escalations/export.csv?country=UG').expect(200);assert.match(exported.headers['cache-control'],/no-store/);assert.ok(exported.text.includes(disputed.publicId));assert.ok(!exported.text.includes(buyer.user.email));assert.ok(!exported.text.includes('PRIVATE_INTERNAL_CASE_NOTES'));
    });
  }finally{t.mock.restoreAll();for(const transport of transports)transport.destroy();await Promise.all(Object.values(mongoose.models).map(Model=>Model.init()));try{await mongoose.connection.dropDatabase();}finally{await mongoose.disconnect();await fs.rm(process.env.UPLOAD_DIR,{recursive:true,force:true});}}
});
function same(a,b){return String(a||'')===String(b||'');}
