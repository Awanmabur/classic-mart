import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV='test';
process.env.SIMPLE_LOGIN='false';
process.env.PRIVILEGED_MFA_REQUIRED='true';
process.env.MAIL_MODE='log';
process.env.SMS_MODE='log';
process.env.REDIS_URL='';
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)?.[1];

test('Business purchasing uses accepted current authority, reviewed commercial terms, real stock and private canonical pages',{skip:!uri,timeout:240_000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/verification|test/i);
  const suffix=crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri,{dbName:'classicmart_business_recovery_test_'+suffix});
  const models=await import('../src/models/index.js');
  const {User,Device,CountrySetting,PlatformGrant,BusinessOrganization,BusinessMember,BusinessBudget,ProcurementRequest,QuoteRequest,PurchaseOrder,BusinessInvoice,BusinessDocument,Product,ProductVariant,Category,Store,StoreMember,Warehouse,StockItem,Order,SellerOrder,InventoryReservation,ProcurementTemplate,ProcurementRun,LedgerTransaction,Shipment,Parcel,DeliveryProfile,DeliveryOffer,EvidenceDocument,InventoryMovement}=models;
  const operations=await import('../src/services/business-operations.js');
  const supplier=await import('../src/services/seller-business.js');
  const {businessAccess}=await import('../src/services/business-access.js');
  const {loadBusinessPage}=await import('../src/services/business-workspace-pages.js');
  const {businessDocumentAccess}=await import('../src/services/business-documents.js');
  const {recordBusinessDelivery}=await import('../src/services/business-fulfillment.js');
  const delivery=await import('../src/services/delivery-workspace.js');
  const logistics=await import('../src/services/logistics.js');
  const {decryptSensitive}=await import('../src/core/sensitive.js');
  const {deleteMediaObject}=await import('../src/services/object-storage.js');
  const {default:sharp}=await import('sharp');
  const {hashPassword,hashToken}=await import('../src/core/crypto.js');
  const {beginMfaEnrollment,confirmMfaEnrollment,totpCode}=await import('../src/services/mfa.js');
  const {createApp}=await import('../src/app.js');
  const password='Business-'+suffix+'-A1!',passwordHash=await hashPassword(password),app=createApp(null),transports=[],storageKeys=[];
  let sequence=0;
  const id=prefix=>`${prefix}_${suffix}_${++sequence}`;
  const revision=async(Model,document)=>(await Model.findById(document._id)).__v||0;
  async function actor(role='business'){
    const publicId=id('usr'),email=publicId+'@example.com',phone='+25670'+String(sequence).padStart(7,'0');
    let user=await User.create({publicId,name:'Business '+sequence,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,country:'UG',currency:'UGX',shoppingCountry:'UG',emailVerifiedAt:new Date(),phoneVerifiedAt:new Date(),onboardingCompletedAt:new Date(),consents:{terms:true,privacy:true,recordedAt:new Date()}});
    const pending=await beginMfaEnrollment(user._id,password),verified=await confirmMfaEnrollment(user._id,totpCode(pending.secret));user=verified.user;
    const sessionID=crypto.randomUUID();const device=await Device.create({publicId:id('dev'),userId:user._id,sessionHash:hashToken(sessionID),label:'Business recovery fixture',userAgent:'Business recovery fixture',ipHash:hashToken('127.0.0.1'),lastSeenAt:new Date()});
    const service={user,device,sessionID,session:{userId:String(user._id),tokenVersion:user.security.tokenVersion,mfaVerifiedAt:Date.now()},get:()=>'',ip:'127.0.0.1',query:{},country:{code:'UG',currency:'UGX'}};
    return{user,service,recovery:verified.codes[0]};
  }
  async function login(person){
    const transport=new http.Agent({localAddress:'127.0.0.'+(transports.length+90),keepAlive:false});transports.push(transport);
    const client=request.agent(app).use(req=>req.agent(transport));
    const page=await client.get('/login').expect(200),logged=await client.post('/login').type('form').send({email:person.user.email,password,_csrf:csrf(page.text)}).expect(302);
    assert.equal(logged.headers.location,'/mfa');const mfa=await client.get('/mfa').expect(200);await client.post('/mfa').type('form').send({code:person.recovery,_csrf:csrf(mfa.text)}).expect(302);return client;
  }
  let owner,approver,foreign,seller,staff,org,store,variant,budget,procurement,quote,po,invoice;
  try{
    for(const Model of [User,Device,CountrySetting,PlatformGrant,BusinessOrganization,BusinessMember,BusinessBudget,ProcurementRequest,QuoteRequest,PurchaseOrder,BusinessInvoice,BusinessDocument,Product,ProductVariant,Category,Store,StoreMember,Warehouse,StockItem,Order,SellerOrder,InventoryReservation,ProcurementTemplate,ProcurementRun,LedgerTransaction,Shipment,Parcel,DeliveryProfile,DeliveryOffer,EvidenceDocument,InventoryMovement])await Model.init();
    await CountrySetting.create({code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256',returnWindowDays:14,platformFeeBps:700,taxBps:1800,policyVersion:'reviewed-business-v1',growth:{loyaltyEnabled:false,referralEnabled:false}});
    owner=await actor();approver=await actor('customer');foreign=await actor();seller=await actor('seller');staff=await actor('country_admin');
    const created=await operations.createBusinessOrganization(owner.service,{companyName:'Real procurement '+suffix,billingEmail:owner.user.email});org=await BusinessOrganization.findOne({publicId:created.publicId});owner.service.session.activeBusinessPublicId=org.publicId;
    await operations.saveBusinessProfile(owner.service,{version:org.__v,companyName:org.companyName,billingEmail:owner.user.email,billingContactName:owner.user.name,billingPhone:owner.user.phone,billingAddress:'10 Billing Street',billingCity:'Kampala',deliveryContactName:owner.user.name,deliveryPhone:owner.user.phone,deliveryAddress:'20 Delivery Street',deliveryCity:'Kampala',taxId:'PRIVATE-TAX-ID'});
    const invited=await operations.inviteBusinessMember(owner.service,{email:approver.user.email,role:'approver',canApprove:true});
    const invitation=await BusinessMember.findOne({publicId:invited.publicId});
    await assert.rejects(businessAccess(approver.service),error=>error.code==='BUSINESS_MEMBERSHIP_REQUIRED');
    await operations.acceptBusinessInvitation(approver.service,invitation.publicId,{version:invitation.__v});approver.service.session.activeBusinessPublicId=org.publicId;
    assert.equal((await User.findById(approver.user._id)).role,'customer','accepting a company invitation never rewrites the identity role');
    await assert.rejects(operations.inviteBusinessMember(approver.service,{email:foreign.user.email,role:'admin'}),error=>error.status===403);
    const forged=await BusinessMember.create({publicId:id('bmem'),organizationId:org._id,userId:foreign.user._id,role:'admin',status:'invited',invitedByUserId:approver.user._id,inviterTokenVersion:approver.user.security.tokenVersion});
    await assert.rejects(operations.acceptBusinessInvitation(foreign.service,forged.publicId,{version:forged.__v}),error=>error.code==='BUSINESS_INVITER_UNAVAILABLE');
    store=await Store.create({publicId:id('sto'),ownerUserId:seller.user._id,name:'Procurement supplier',slug:id('supplier'),country:'UG',currency:'UGX',status:'verified',verifiedAt:new Date()});
    await StoreMember.create({publicId:id('stm'),storeId:store._id,userId:seller.user._id,role:'owner',status:'active',acceptedAt:new Date(),invitedByUserId:seller.user._id});seller.service.store=store;seller.service.session.activeStorePublicId=store.publicId;
    const category=await Category.create({publicId:id('cat'),name:'Purchasing supplies',slug:id('supplies'),countries:['UG'],active:true});
    const product=await Product.create({publicId:id('prd'),storeId:store._id,ownerUserId:seller.user._id,categoryId:category._id,title:'[ Literal procurement item',slug:id('item'),description:'Published exact SKU procurement test item.',countries:['UG'],status:'published'});
    variant=await ProductVariant.create({publicId:id('var'),productId:product._id,storeId:store._id,sku:id('SKU').toUpperCase(),title:'Exact box',priceMinor:1000,minimumPriceMinor:500,costMinor:123,currency:'UGX',active:true});
    const warehouse=await Warehouse.create({publicId:id('wh'),storeId:store._id,ownerUserId:seller.user._id,name:'Active supplier warehouse',country:'UG',city:'Kampala',address:'Warehouse Road',active:true});
    await StockItem.create({publicId:id('stock'),storeId:store._id,warehouseId:warehouse._id,variantId:variant._id,onHand:50});
    const budgetCreated=await operations.createBusinessBudget(owner.service,{name:'Real reviewed budget',limitMinor:20000,periodStart:new Date(Date.now()-86400000),periodEnd:new Date(Date.now()+30*86400000),idempotencyKey:id('budget')});budget=await BusinessBudget.findOne({publicId:budgetCreated.publicId});

    await t.test('independent budget approval and immutable market policy survive later policy edits',async()=>{
      const created=await operations.submitBusinessProcurement(owner.service,{title:'Four exact boxes',budgetId:budget.publicId,items:[{variantPublicId:variant.publicId,quantity:4}],idempotencyKey:id('purchase')});procurement=await ProcurementRequest.findOne({publicId:created.publicId});
      await assert.rejects(operations.decideBusinessProcurement(owner.service,procurement.publicId,{version:procurement.__v,decision:'approve'}),error=>error.code==='BUSINESS_INDEPENDENT_APPROVAL_REQUIRED');
      await operations.decideBusinessProcurement(approver.service,procurement.publicId,{version:procurement.__v,decision:'approve',reason:'The exact four boxes fit the company budget.'});
      assert.equal((await BusinessBudget.findById(budget._id)).committedMinor,4720);
      await CountrySetting.updateOne({code:'UG'},{$set:{returnWindowDays:60,platformFeeBps:1500,taxBps:2000,policyVersion:'later-market-policy'},$inc:{__v:1}});
      const requested=await operations.requestBusinessQuotation(owner.service,{procurementRequestId:procurement.publicId,version:await revision(ProcurementRequest,procurement),storeId:store.publicId,message:'Please quote the approved boxes.'});quote=await QuoteRequest.findOne({publicId:requested.publicId});
      await assert.rejects(supplier.respondSellerBusinessQuote(seller.service,quote.publicId,{version:quote.__v,action:'offer',message:'Invalid free quote',offeredUnitMinor:[0],validUntil:new Date(Date.now()+86400000)}),error=>error.code==='SELLER_BUSINESS_OFFER_INVALID');
      await supplier.respondSellerBusinessQuote(seller.service,quote.publicId,{version:quote.__v,action:'offer',message:'Exact discounted quotation.',offeredUnitMinor:[900],validUntil:new Date(Date.now()+86400000)});
      const issued=await operations.acceptBusinessQuotation(owner.service,quote.publicId,{version:await revision(QuoteRequest,quote),paymentTerms:'immediate'});po=await PurchaseOrder.findOne({publicId:issued.publicId});
      assert.deepEqual(po.commercialPolicy.toObject(),{returnWindowDays:14,platformFeeBps:700,taxBps:1800,policyVersion:'reviewed-business-v1'});
      await supplier.decideSellerBusinessOrder(seller.service,po.publicId,{version:po.__v,decision:'accept'});
      po=await PurchaseOrder.findById(po._id);invoice=await BusinessInvoice.findOne({publicId:po.invoicePublicId});const order=await Order.findOne({publicId:po.orderPublicId});
      assert.equal(order.policySnapshot.platformFeeBps,700);assert.equal(order.policySnapshot.returnWindowDays,14);assert.equal(order.totals.totalMinor,4248);assert.equal(order.paymentState,'pending');assert.equal(invoice.status,'awaiting_payment');
      assert.equal((await SellerOrder.findOne({orderId:order._id})).platformFeeMinor,252);
      assert.equal((await StockItem.findOne({variantId:variant._id})).reserved,4);
      assert.equal(await LedgerTransaction.countDocuments({referencePublicId:invoice.publicId}),0,'no payment or receivable is invented before provider verification or physical credit delivery');
      const session=await mongoose.startSession();try{await assert.rejects(session.withTransaction(()=>recordBusinessDelivery({orderId:order._id,actorUserId:seller.user._id,session})),error=>error.code==='BUSINESS_DELIVERY_PROOF_REQUIRED');}finally{await session.endSession();}
      assert.equal((await BusinessBudget.findById(budget._id)).spentMinor,0);
    });

    await t.test('scoped canonical pages, literal searches and private commercial documents use live records',async()=>{
      const client=await login(owner),memberClient=await login(approver),sellerClient=await login(seller);
      for(const path of ['overview','orders','quotes','invoices','templates','settings']){
        const page=await client.get('/business/'+path).expect(200);assert.match(page.text,/data-role="business"/);assert.match(page.headers['cache-control'],/no-store/);assert.match(page.headers['x-robots-tag'],/noindex/);assert.doesNotMatch(page.text,/PRIVATE-TAX-ID/);
      }
      await memberClient.get('/business/orders').expect(200);
      const legacy=await client.get('/dashboard/business-orders?search=%5B').expect(308);assert.equal(legacy.headers.location,'/business/orders?search=%5B');
      const searched=await client.get('/business/orders?catalogueSearch=%5B').set('Accept','application/json').expect(200);assert.equal(searched.body.catalogue.items.length,1);assert.equal(searched.body.catalogue.items[0].publicId,variant.publicId);
      await client.post('/business/budgets').type('form').send({name:'No CSRF',limitMinor:1}).expect(403);
      for(const path of ['business-quotes','business-orders']){const page=await sellerClient.get('/seller/'+path).expect(200);assert.match(page.text,/data-role="seller"/);assert.match(page.text,/Procurement supplier/);}
      const documents=await BusinessDocument.find({organizationId:org._id});assert.equal(documents.some(row=>row.type==='tax_invoice'),true);
      for(const document of documents){const html=await client.get('/business/documents/'+document.publicId).expect(200);assert.match(html.headers['cache-control'],/no-store/);const pdf=await client.get('/business/documents/'+document.publicId+'/pdf').expect(200);assert.match(pdf.headers['content-type'],/application\/pdf/);assert.equal(pdf.body.subarray(0,4).toString(),'%PDF');await assert.rejects(businessDocumentAccess(foreign.service,document.publicId),error=>[403,404].includes(error.status));}
      assert.equal((await User.findById(approver.user._id)).role,'customer');
      await Category.updateOne({_id:category._id},{$set:{active:false}});const filtered=await loadBusinessPage({...owner.service,query:{catalogueSearch:'['}},'orders');assert.equal(filtered.catalogue.items.length,0);await assert.rejects(operations.submitBusinessProcurement(owner.service,{title:'Inactive category',items:[{variantPublicId:variant.publicId,quantity:1}]}),error=>error.code==='BUSINESS_SKU_UNAVAILABLE');await Category.updateOne({_id:category._id},{$set:{active:true}});
    });

    await t.test('credit requires a current independently reviewed company request and a live staff grant',async()=>{
      await User.updateOne({_id:staff.user._id},{$set:{platformAccessManagedAt:new Date()}});
      await PlatformGrant.create({publicId:id('grant'),userId:staff.user._id,role:'country_admin',operationalCountries:['UG'],startsAt:new Date(Date.now()-60000),expiresAt:new Date(Date.now()+86400000),reason:'Independent Business credit reviewer fixture.',approvalPublicId:id('approval'),approvedByUserId:seller.user._id});
      await operations.requestBusinessCreditTerms(owner.service,{version:await revision(BusinessOrganization,org),limitMinor:10000,termsDays:30});
      await operations.reviewBusinessCreditTerms(staff.service,org.publicId,{version:await revision(BusinessOrganization,org),decision:'approve',limitMinor:9000,termsDays:21,reason:'Verified current company request and credit exposure.'});
      const reviewed=await BusinessOrganization.findById(org._id);assert.equal(reviewed.invoiceTermsApproved,true);assert.equal(reviewed.creditLimitMinor,9000);assert.equal(reviewed.invoiceTermsDays,21);assert.equal(String(reviewed.creditApprovedByUserId),String(staff.user._id));assert.ok(reviewed.creditApprovedAt);
      await assert.rejects(operations.reviewBusinessCreditTerms(staff.service,org.publicId,{version:reviewed.__v,decision:'approve',limitMinor:9000,termsDays:21,reason:'Repeated same credit decision.'}),error=>error.code==='BUSINESS_CREDIT_REQUEST_UNAVAILABLE');
      await PlatformGrant.updateOne({userId:staff.user._id},{$set:{status:'revoked'}});await assert.rejects(operations.reviewBusinessCreditTerms(staff.service,org.publicId,{version:reviewed.__v,decision:'revoke',reason:'No active staff authority should allow this action.'}),error=>error.status===403);
    });

    await t.test('actual independent carrier verification, Warehouse custody and recipient proof settle a delivered credit commitment once',async()=>{
      const created=await operations.submitBusinessProcurement(owner.service,{title:'One credit box for actual delivery',budgetId:budget.publicId,items:[{variantPublicId:variant.publicId,quantity:1}],idempotencyKey:id('credit_purchase')});
      const source=await ProcurementRequest.findOne({publicId:created.publicId});
      await operations.decideBusinessProcurement(approver.service,source.publicId,{version:source.__v,decision:'approve',reason:'Independent approval of the exact credit purchase.'});
      const requested=await operations.requestBusinessQuotation(owner.service,{procurementRequestId:source.publicId,version:await revision(ProcurementRequest,source),storeId:store.publicId,message:'Quote one approved credit box.'});
      const quoted=await QuoteRequest.findOne({publicId:requested.publicId});
      await supplier.respondSellerBusinessQuote(seller.service,quoted.publicId,{version:quoted.__v,action:'offer',message:'One box for actual credit delivery.',offeredUnitMinor:[900],validUntil:new Date(Date.now()+86400000)});
      const issued=await operations.acceptBusinessQuotation(owner.service,quoted.publicId,{version:await revision(QuoteRequest,quoted),paymentTerms:'credit'});
      let purchase=await PurchaseOrder.findOne({publicId:issued.publicId});await supplier.decideSellerBusinessOrder(seller.service,purchase.publicId,{version:purchase.__v,decision:'accept'});
      purchase=await PurchaseOrder.findById(purchase._id);const order=await Order.findOne({publicId:purchase.orderPublicId});
      const invoice=await BusinessInvoice.findOne({publicId:purchase.invoicePublicId});assert.equal(invoice.status,'credit_pending_delivery');assert.equal(order.paymentState,'credit_due');
      const operator=await actor('warehouse'),carrier=await actor('delivery');
      const image=await sharp({create:{width:320,height:320,channels:3,background:'#b05000'}}).jpeg().toBuffer();
      const file={buffer:image,size:image.length,mimetype:'image/jpeg',originalname:'private-proof.jpg'};
      const act=(entry,body,publicIdValue)=>({...entry.service,body,params:publicIdValue?{publicId:publicIdValue}:{}});
      await delivery.saveDeliveryProfile(act(carrier,{version:0,transport:'bicycle',serviceAreas:'Kampala',action:'save'}));
      let profile=await DeliveryProfile.findOne({userId:carrier.user._id});
      const identity=await delivery.uploadDeliveryEvidence({...act(carrier,{version:profile.__v,documentType:'identity'}),file},{profile:true});
      storageKeys.push((await EvidenceDocument.findOne({publicId:identity.publicId}).select('+storageKey')).storageKey);
      profile=await DeliveryProfile.findById(profile._id);await delivery.saveDeliveryProfile(act(carrier,{version:profile.__v,transport:'bicycle',serviceAreas:'Kampala',action:'submit'}));
      profile=await DeliveryProfile.findById(profile._id);await delivery.reviewDeliveryProfile(act(operator,{version:profile.__v,decision:'approve',reason:'Independent identity review completed.'},profile.publicId));
      profile=await DeliveryProfile.findById(profile._id);await delivery.setDeliveryAvailability(act(carrier,{version:profile.__v,available:'true'}));
      let shipment=await Shipment.findOne({orderId:order._id,kind:'outbound'});const parcel=await Parcel.findOne({shipmentId:shipment._id});
      await delivery.createDeliveryOffer(act(operator,{version:shipment.__v,carrierPublicId:profile.publicId,earningMinor:300,currency:'UGX'},shipment.publicId));
      const offer=await DeliveryOffer.findOne({shipmentId:shipment._id,deliveryUserId:carrier.user._id});await delivery.respondDeliveryOffer(act(carrier,{version:offer.__v},offer.publicId),'accept');
      const receivingWarehouse=await Warehouse.findOne({storeId:store._id});
      for(const type of ['pick','pack','dispatch']){const task=await logistics.createWarehouseTask({warehouseId:receivingWarehouse._id,storeId:store._id,orderId:order._id,shipmentId:shipment._id,parcelId:parcel._id,type,assignedUserId:operator.user._id,quantity:type==='pick'?1:0});await logistics.executeWarehouseTask({task,actorUserId:operator.user._id});}
      shipment=await Shipment.findById(shipment._id).select('+pickupCodeEncrypted +deliveryCodeEncrypted');const pickupCode=decryptSensitive(shipment.pickupCodeEncrypted),deliveryCode=decryptSensitive(shipment.deliveryCodeEncrypted);
      await delivery.advanceDelivery(act(carrier,{version:shipment.__v,proofCode:pickupCode},shipment.publicId),'picked_up');shipment=await Shipment.findById(shipment._id);
      await delivery.advanceDelivery(act(carrier,{version:shipment.__v},shipment.publicId),'in_transit');shipment=await Shipment.findById(shipment._id);
      const photo=await delivery.uploadDeliveryEvidence({...act(carrier,{version:shipment.__v,documentType:'delivery_photo'},shipment.publicId),file});storageKeys.push((await EvidenceDocument.findOne({publicId:photo.publicId}).select('+storageKey')).storageKey);
      shipment=await Shipment.findById(shipment._id);await delivery.advanceDelivery(act(carrier,{version:shipment.__v,proofCode:deliveryCode},shipment.publicId),'delivered');
      const settled=await BusinessBudget.findById(budget._id),deliveredInvoice=await BusinessInvoice.findById(invoice._id);
      assert.equal(settled.committedMinor,4720);assert.equal(settled.spentMinor,1080);assert.equal(deliveredInvoice.status,'open');assert.ok(deliveredInvoice.dueAt);assert.equal((await PurchaseOrder.findById(purchase._id)).status,'fulfilled');
      assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'business-credit-delivery:'+order.publicId}),1);assert.equal(await BusinessDocument.countDocuments({eventKey:'delivery_note:'+order.publicId}),1);
      const session=await mongoose.startSession();try{await session.withTransaction(()=>recordBusinessDelivery({orderId:order._id,actorUserId:carrier.user._id,session}));}finally{await session.endSession();}
      assert.equal((await BusinessBudget.findById(budget._id)).spentMinor,1080);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'business-credit-delivery:'+order.publicId}),1);
    });

    await t.test('recurrence creates one fresh independent request and revocation pauses only the unchanged source',async()=>{
      const created=await operations.saveBusinessTemplate(owner.service,{name:'Weekly box request',recurrence:'weekly',budgetId:budget.publicId,items:[{variantPublicId:variant.publicId,quantity:1}],idempotencyKey:id('template')});const template=await ProcurementTemplate.findOne({publicId:created.publicId});const scheduledFor=new Date(Date.now()-60000);await ProcurementTemplate.updateOne({_id:template._id},{$set:{nextDueAt:scheduledFor}});
      const now=new Date();await operations.processBusinessRecurrence(now);await operations.processBusinessRecurrence(now);
      assert.equal(await ProcurementRun.countDocuments({templateId:template._id,scheduledFor}),1);const run=await ProcurementRun.findOne({templateId:template._id,scheduledFor});const generated=await ProcurementRequest.findById(run.procurementRequestId);assert.equal(generated.status,'submitted');assert.equal(generated.approvedAt,undefined);
      await ProcurementTemplate.updateOne({_id:template._id},{$set:{nextDueAt:new Date(Date.now()-60000)},$inc:{__v:1}});await User.updateOne({_id:owner.user._id},{$inc:{'security.tokenVersion':1}});
      const result=await operations.processBusinessRecurrence(new Date());assert.equal(result.created,0);const paused=await ProcurementTemplate.findById(template._id);assert.equal(paused.active,false);assert.equal(paused.lastFailureCode,'BUSINESS_ACCOUNT_UNAVAILABLE');assert.equal(await ProcurementRun.countDocuments({templateId:template._id}),1);
      await assert.rejects(operations.submitBusinessProcurement(owner.service,{title:'Revoked token',items:[{variantPublicId:variant.publicId,quantity:1}]}),error=>error.code==='BUSINESS_ACCOUNT_UNAVAILABLE');
    });
  }finally{for(const transport of transports)transport.destroy();for(const storageKey of storageKeys)await deleteMediaObject(storageKey).catch(()=>{});await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
