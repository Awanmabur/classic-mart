import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const name of ['SESSION_SECRET','TOKEN_PEPPER','DATA_ENCRYPTION_KEY','SECURITY_INTEGRITY_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/u)[1];

test('approved inventory performs scoped, versioned warehouse, stock, condition and lot operations', {skip:!uri,timeout:180_000}, async t => {
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/verification|test/iu);
  const database = `classicmart_seller_inventory_pages_test_${suffix}`;
  await mongoose.connect(uri,{dbName:database});
  const models = await import('../src/models/index.js');
  const {User,Store,StoreMember,CountrySetting,Category,Product,ProductVariant,Warehouse,StockItem,InventoryMovement,InventoryLot,WarehouseTask,AuditLog,OutboxEvent,Device,StoreTeamInvitation} = models;
  const {createApp} = await import('../src/app.js');
  const {hashPassword,hashToken,hashValue,normalizeEmail} = await import('../src/core/crypto.js');
  const {beginMfaEnrollment,confirmMfaEnrollment,totpCode} = await import('../src/services/mfa.js');
  const {encryptSensitive} = await import('../src/core/sensitive.js');
  const services = await import('../src/services/seller-inventory-pages.js');
  const password = `Inventory-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
  const transports = [];
  let sequence = 0;
  const nextId = prefix => `${prefix}_inv_${suffix}_${++sequence}`;
  async function actor(role='seller',mfa=true) {
    const number = ++sequence,email = `inventory-${suffix}-${number}@example.com`,phone=`+25670${String(number).padStart(7,'0')}`;
    let user = await User.create({publicId:nextId('usr'),name:`Inventory Actor ${number}`,email,emailNormalized:email,phone,phoneNormalized:phone,
      passwordHash,role,country:'UG',currency:'UGX',emailVerifiedAt:new Date(),phoneVerifiedAt:new Date(),onboardingCompletedAt:new Date(),consents:{terms:true,privacy:true,recordedAt:new Date()}});
    let codes=[];
    if(mfa) {
      const enrollment = await beginMfaEnrollment(user._id,password);
      const confirmed = await confirmMfaEnrollment(user._id,totpCode(enrollment.secret));
      user=confirmed.user;codes=confirmed.codes;
    }
    const transport = new http.Agent({localAddress:`127.0.0.${transports.length+2}`,keepAlive:false});
    transports.push(transport);
    const client=request.agent(app).use(req=>req.agent(transport));
    const login=await client.get('/login').expect(200);
    await client.post('/login').type('form').send({email,password,_csrf:csrf(login.text)}).expect(302);
    if(mfa) {
      const challenge=await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({code:codes[0],_csrf:csrf(challenge.text)}).expect(302);
    }
    user=await User.findById(user._id);
    const serviceSessionID=crypto.randomUUID();
    const serviceDevice=await Device.create({publicId:nextId('dev'),userId:user._id,sessionHash:hashToken(serviceSessionID),label:'Current inventory fixture device',userAgent:'Inventory regression',ipHash:hashToken('127.0.0.1'),lastSeenAt:new Date()});
    return {user,client,serviceSessionID,serviceDevice};
  }
  async function storeFor(actor,name) {
    const store=await Store.create({publicId:nextId('str'),ownerUserId:actor.user._id,name,slug:`inventory-${suffix}-${sequence}`,country:'UG',currency:'UGX',status:'verified'});
    await StoreMember.create({publicId:nextId('stm'),storeId:store._id,userId:actor.user._id,role:'owner',status:'active',invitedByUserId:actor.user._id,acceptedAt:new Date()});
    return store;
  }
  const serviceRequest = (actor,store) => ({user:actor.user,store,device:actor.serviceDevice,sessionID:actor.serviceSessionID,originalUrl:'/seller/inventory',id:`inv-${suffix}`,ip:'127.0.0.1',get:()=>'',country:{code:store.country,currency:store.currency},session:{userId:String(actor.user._id),tokenVersion:actor.user.security.tokenVersion,activeStorePublicId:store.publicId,...(actor.user.security.mfaEnabled?{mfaVerifiedAt:Date.now()}:{})}});
  async function selectStore(identity, selectedStore) {
    const security = await identity.client.get('/account/security').expect(200);
    await identity.client.post('/seller/workspace').set('accept', 'application/json').type('form')
      .send({ storePublicId: selectedStore.publicId, _csrf: csrf(security.text) }).expect(200);
  }
  async function post(actor,path,body,status=302,json=false) {
    const page=await actor.client.get('/seller/inventory').expect(200);
    const operation=actor.client.post(path).type('form').send({_csrf:csrf(page.text),...body});
    if(json) operation.set('accept','application/json');
    return operation.expect(status);
  }
  async function stockBody(stock,extra={}) {
    const current=await StockItem.findById(stock._id);
    return {stockPublicId:current.publicId,expectedVersion:String(current.__v),...extra};
  }
  try {
    await Promise.all(Object.values(models).filter(model=>typeof model?.init==='function').map(model=>model.init()));
    await CountrySetting.create({code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'});
    const owner=await actor(),foreignOwner=await actor(),buyer=await actor('customer',false);
    const store=await storeFor(owner,'Inventory Test Store'),foreignStore=await storeFor(foreignOwner,'Foreign Inventory Store');
    const scoped=serviceRequest(owner,store);
    let warehouse,variant,stock,lot;

    await t.test('empty approved inventory uses real zeroes, aliases, private headers and CSRF',async()=>{
      const page=await owner.client.get('/seller/inventory').expect(200);
      assert.match(page.headers['cache-control'],/no-store/u);
      assert.match(page.headers['x-robots-tag'],/noindex/u);
      for(const className of ['role-metric-grid','role-table-panel','role-insights','role-progress-card','role-activity-panel','role-form-grid','panel role-form-section']) assert.ok(page.text.includes(className),className);
      assert.match(page.text,/Inventory Management/u);
      assert.doesNotMatch(page.text,/6,842|CW-HDP-01|Amina Stores|Recently Viewed/u);
      const flow=(await owner.client.get('/seller/inventory').set('accept','application/json').expect(200)).body;
      assert.equal(flow.kind,'inventory');assert.equal(flow.metrics[0].value,'0');assert.equal(flow.health.value,null);assert.deepEqual(flow.rows,[]);
      await owner.client.get('/dashboard/seller-inventory?status=low').expect(308).expect('location','/seller/inventory?status=low');
      await buyer.client.get('/seller/inventory').expect(403);
      await owner.client.post('/seller/warehouses').type('form').send({name:'Unauthorized',country:'UG',city:'Kampala',address:'Unknown address'}).expect(403);
      assert.equal(await Warehouse.countDocuments({storeId:store._id}),0);
      for(const query of ['status=wrong','status=low&status=out','status%5B%5D=low','after=bad']) await owner.client.get('/seller/inventory?'+query).set('accept','application/json').expect(422);
    });

    await t.test('warehouse creation validates and retains input without accepting another country',async()=>{
      const invalid=await post(owner,'/seller/warehouses',{name:'Saved warehouse name',country:'UG',city:'Kampala',address:'x'},422);
      assert.match(invalid.text,/value="Saved warehouse name"/u);assert.match(invalid.text,/role="alert"/u);
      await post(owner,'/seller/warehouses',{name:'Wrong country warehouse',country:'KE',city:'Nairobi',address:'Some street address'},422,true);
      assert.equal(await Warehouse.countDocuments({storeId:store._id}),0);
      await post(owner,'/seller/warehouses',{name:'Real Warehouse',country:'UG',city:'Kampala',address:'Plot 12 Kampala Road'});
      warehouse=await Warehouse.findOne({storeId:store._id,name:'Real Warehouse'});
      assert.ok(warehouse);assert.equal(await AuditLog.countDocuments({action:'inventory.warehouse_created',targetPublicId:warehouse.publicId}),1);
      await post(owner,'/seller/warehouses',{name:'Real Warehouse',country:'UG',city:'Kampala',address:'A duplicate location'},409);
      const category=await Category.create({publicId:nextId('cat'),name:'Inventory Category',slug:`inventory-${suffix}`});
      const product=await Product.create({publicId:nextId('prd'),storeId:store._id,ownerUserId:owner.user._id,categoryId:category._id,
        title:'Real Inventory Product',slug:`real-inventory-${suffix}`,description:'Real inventory regression product.',countries:['UG'],status:'published'});
      variant=await ProductVariant.create({publicId:nextId('var'),storeId:store._id,productId:product._id,sku:'INV-REAL',title:'Default',priceMinor:20000,currency:'UGX'});
      const foreignWarehouse=await Warehouse.create({publicId:nextId('whs'),storeId:foreignStore._id,ownerUserId:foreignOwner.user._id,name:'Foreign Warehouse Secret',country:'UG',city:'Kampala',address:'Foreign address'});
      const otherCountryWarehouse=await Warehouse.create({publicId:nextId('whs'),storeId:store._id,ownerUserId:owner.user._id,name:'Kenyan Warehouse Secret',country:'KE',city:'Nairobi',address:'Other country address'});
      await StockItem.create([{publicId:nextId('stk'),storeId:foreignStore._id,warehouseId:foreignWarehouse._id,variantId:variant._id,onHand:99000},
        {publicId:nextId('stk'),storeId:store._id,warehouseId:otherCountryWarehouse._id,variantId:variant._id,onHand:88000}]);
      await post(owner,'/seller/inventory/adjust',{variantPublicId:variant.publicId,warehousePublicId:foreignWarehouse.publicId,quantity:1,reason:'Wrong store',reorderPoint:5,expectedVersion:'new'},422,true);
      await post(owner,'/seller/inventory/adjust',{variantPublicId:variant.publicId,warehousePublicId:otherCountryWarehouse.publicId,quantity:1,reason:'Wrong country',reorderPoint:5,expectedVersion:'new'},422,true);
      await post(owner,`/seller/warehouses/${foreignWarehouse.publicId}/archive`,{expectedVersion:0},404,true);
    });

    await t.test('stock receipts and reductions record movement, versions and audit atomically',async()=>{
      const body={variantPublicId:variant.publicId,warehousePublicId:warehouse.publicId,quantity:40,reason:'Counted initial receipt',reorderPoint:8,expectedVersion:'new'};
      await post(owner,'/seller/inventory/adjust',{...body,quantity:-1},409,true);
      assert.equal(await StockItem.countDocuments({storeId:store._id,warehouseId:warehouse._id}),0,'failed initial receipt creates no stock artifact');
      await post(owner,'/seller/inventory/adjust',{...body,quantity:1.5},422,true);
      await post(owner,'/seller/inventory/adjust',body);
      stock=await StockItem.findOne({storeId:store._id,warehouseId:warehouse._id,variantId:variant._id});
      assert.equal(stock.onHand,40);assert.equal(stock.reorderPoint,8);
      assert.equal(await InventoryMovement.countDocuments({stockItemId:stock._id,type:'receipt'}),1);
      assert.equal(await AuditLog.countDocuments({action:'inventory.stock_adjusted',targetPublicId:stock.publicId}),1);
      await post(owner,'/seller/inventory/adjust',body,409,true);
      const fresh=await stockBody(stock,{...body,expectedVersion:String(stock.__v),quantity:-2});
      await post(owner,'/seller/inventory/adjust',fresh);
      await post(owner,'/seller/inventory/adjust',fresh,409,true);
      assert.equal((await StockItem.findById(stock._id)).onHand,38);
      const current=await stockBody(stock,{...body,quantity:2});
      // stockBody uses the freshest version unless explicitly overridden.
      current.expectedVersion=String((await StockItem.findById(stock._id)).__v);
      await post(owner,'/seller/inventory/adjust',current);
      const reserved=await StockItem.findById(stock._id);reserved.reserved=5;await reserved.save();
      const flow=(await owner.client.get('/seller/inventory?stock='+stock.publicId).set('accept','application/json').expect(200)).body;
      assert.equal(flow.summary.onHand,40);assert.equal(flow.summary.reserved,5);assert.equal(flow.summary.available,35);
      assert.equal(flow.rows.length,1);assert.equal(flow.selectedStock.publicId,stock.publicId);
      const page=await owner.client.get('/seller/inventory?stock='+stock.publicId).expect(200);
      assert.match(page.text,/Record stock movement/u);assert.match(page.text,/Stock condition and bin/u);assert.match(page.text,/Recent stock movements/u);
      assert.doesNotMatch(page.text,/Foreign Warehouse Secret|Kenyan Warehouse Secret|99000|88000/u);
      const warehouseNow=await Warehouse.findById(warehouse._id);
      await post(owner,`/seller/warehouses/${warehouse.publicId}`,{name:'Stale warehouse',country:'UG',city:'Kampala',address:'Changed address',expectedVersion:0},409,true);
      await post(owner,`/seller/warehouses/${warehouse.publicId}`,{name:'Real Warehouse',country:'UG',city:'Entebbe',address:'Updated warehouse address',expectedVersion:warehouseNow.__v});
      assert.equal((await Warehouse.findById(warehouse._id)).city,'Entebbe');
    });

    await t.test('condition and lots protect unavailable stock, physical allocation and stale versions',async()=>{
      const condition=await stockBody(stock,{damaged:2,quarantined:3,binCode:'A-12',reason:'Counted condition check'});
      await post(owner,'/seller/inventory/condition',condition);
      await post(owner,'/seller/inventory/condition',condition,409,true);
      let current=await StockItem.findById(stock._id);
      assert.equal(current.available,30);assert.equal(current.binCode,'A-12');
      await post(owner,'/seller/inventory/lots',await stockBody(stock,{quantity:2,batchNumber:'',serialNumbers:'ONE-SERIAL',expiresAt:'',notes:''}),422,true);
      await post(owner,'/seller/inventory/lots',await stockBody(stock,{quantity:2,batchNumber:'Bad date',serialNumbers:'',expiresAt:'not-a-date',notes:''}),422,true);
      const lotBody=await stockBody(stock,{quantity:30,batchNumber:'BATCH-REAL',serialNumbers:'',expiresAt:'',notes:'Trace these received units'});
      await post(owner,'/seller/inventory/lots',lotBody);
      lot=await InventoryLot.findOne({storeId:store._id,batchNumber:'BATCH-REAL'});assert.ok(lot);
      assert.equal((await StockItem.findById(stock._id)).onHand,40,'lot creation does not receive physical units');
      await post(owner,'/seller/inventory/lots',lotBody,409,true);
      await post(owner,'/seller/inventory/lots',await stockBody(stock,{quantity:11,batchNumber:'Too much',serialNumbers:'',expiresAt:'',notes:''}),409,true);
      await post(owner,'/seller/inventory/adjust',await stockBody(stock,{variantPublicId:variant.publicId,warehousePublicId:warehouse.publicId,quantity:-15,reason:'Count below tracked lots',reorderPoint:8}),409,true);
      await post(owner,`/seller/inventory/lots/${lot.publicId}/status`,await stockBody(stock,{status:'quarantined',reason:'Hold batch for inspection',expectedLotVersion:lot.__v}));
      current=await StockItem.findById(stock._id);assert.equal(current.quarantined,33);assert.equal(current.available,0);
      await post(owner,'/seller/inventory/condition',await stockBody(stock,{damaged:2,quarantined:29,binCode:'A-12',reason:'Cannot release held lot'}),409,true);
      const held=await InventoryLot.findById(lot._id);
      await post(owner,`/seller/inventory/lots/${lot.publicId}/status`,await stockBody(stock,{status:'active',reason:'Batch inspection passed',expectedLotVersion:held.__v}));
      assert.equal((await StockItem.findById(stock._id)).quarantined,3);
      await post(owner,'/seller/inventory/condition',await stockBody(stock,{damaged:36,quarantined:3,binCode:'A-12',reason:'Invalid unavailable total'}),409,true);
      await post(owner,`/seller/inventory/lots/${lot.publicId}/status`,await stockBody(stock,{status:'expired',reason:'Stale lot version',expectedLotVersion:0}),409,true);
      const bad=await post(owner,'/seller/inventory/condition',await stockBody(stock,{damaged:2,quarantined:3,binCode:'Recover this bin',reason:'x'}),422);
      assert.match(bad.text,/value="Recover this bin"/u);assert.match(bad.text,/id="stock-editor"/u);
    });

    await t.test('simultaneous condition and lot submissions admit one current version',async()=>{
      const current=await StockItem.findById(stock._id);
      const outcomes=await Promise.allSettled([1,2].map(damaged=>services.changeSellerStockCondition(scoped,{stockPublicId:stock.publicId,expectedVersion:current.__v,damaged,quarantined:3,binCode:'Concurrent bin',reason:'Concurrent condition check'})));
      assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(outcomes.find(result=>result.status==='rejected').reason.code,'INVENTORY_VERSION_CONFLICT');
      const version=(await StockItem.findById(stock._id)).__v;
      const allocations=await Promise.allSettled(['CONCURRENT-A','CONCURRENT-B'].map(batchNumber=>services.recordSellerInventoryLot(scoped,{stockPublicId:stock.publicId,expectedVersion:version,quantity:1,batchNumber,serialNumbers:'',expiresAt:'',notes:''})));
      assert.equal(allocations.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(allocations.find(result=>result.status==='rejected').reason.code,'INVENTORY_VERSION_CONFLICT');
      assert.equal(await InventoryLot.countDocuments({stockItemId:stock._id,batchNumber:/^CONCURRENT/u}),1);
    });

    await t.test('audit failure rolls stock, movement and outbox changes back',async()=>{
      const before=await StockItem.findById(stock._id).lean(),movements=await InventoryMovement.countDocuments({stockItemId:stock._id}),outbox=await OutboxEvent.countDocuments();
      const original=AuditLog.create;
      AuditLog.create=async()=>{throw new Error('Inventory audit unavailable');};
      try {
        await assert.rejects(services.changeSellerStockCondition(scoped,{stockPublicId:stock.publicId,expectedVersion:before.__v,damaged:0,quarantined:3,binCode:'Audit rollback',reason:'Must retain audit evidence'}),/Inventory audit unavailable/u);
      } finally {AuditLog.create=original;}
      const after=await StockItem.findById(stock._id).lean();
      assert.equal(after.__v,before.__v);assert.equal(after.damaged,before.damaged);assert.equal(after.binCode,before.binCode);
      assert.equal(await InventoryMovement.countDocuments({stockItemId:stock._id}),movements);assert.equal(await OutboxEvent.countDocuments(),outbox);
    });

    await t.test('archive rejects stock and unfinished source or destination work, then closes a clear warehouse',async()=>{
      let warehouseNow=await Warehouse.findById(warehouse._id);
      await post(owner,`/seller/warehouses/${warehouse.publicId}/archive`,{expectedVersion:warehouseNow.__v},409,true);
      const empty=await Warehouse.create({publicId:nextId('whs'),storeId:store._id,ownerUserId:owner.user._id,name:'Empty location',country:'UG',city:'Jinja',address:'Empty location address'});
      const zero=await StockItem.create({publicId:nextId('stk'),storeId:store._id,warehouseId:empty._id,variantId:variant._id,onHand:0});
      const task=await WarehouseTask.create({publicId:nextId('wtk'),warehouseId:warehouse._id,destinationWarehouseId:empty._id,storeId:store._id,type:'transfer',status:'open',quantity:1});
      await post(owner,`/seller/warehouses/${empty.publicId}/archive`,{expectedVersion:empty.__v},409,true);
      task.status='cancelled';await task.save();
      await post(owner,`/seller/warehouses/${empty.publicId}/archive`,{expectedVersion:empty.__v});
      assert.equal((await Warehouse.findById(empty._id)).active,false);
      await post(owner,'/seller/inventory/adjust',{variantPublicId:variant.publicId,warehousePublicId:empty.publicId,quantity:1,reason:'Closed location receipt',reorderPoint:0,expectedVersion:'new'},422,true);
      assert.equal(await AuditLog.countDocuments({action:'inventory.warehouse_archived',targetPublicId:empty.publicId}),1);
      const {createWarehouseTask}=await import('../src/services/logistics.js');
      await assert.rejects(createWarehouseTask({publicId:nextId('wtk'),warehouseId:empty._id,storeId:store._id,type:'receive',quantity:1}),error=>error.code==='WAREHOUSE_MISSING');
      const {adjustStock}=await import('../src/services/inventory.js');
      await assert.rejects(adjustStock({stockItemId:zero._id,storeId:store._id,quantity:1,reason:'Existing API adjustment caller',actorUserId:owner.user._id,reorderPoint:0,expectedVersion:zero.__v}),error=>error.code==='INVENTORY_REFERENCE_INVALID');
      assert.equal((await StockItem.findById(zero._id)).onHand,0);
    });

    await t.test('fresh membership, inventory capability and staff MFA remain required',async()=>{
      const inventoryStaff=await actor('customer'),supportStaff=await actor('customer'),withoutMfa=await actor('customer',false);
      const membership=await StoreMember.create({publicId:nextId('stm'),storeId:store._id,userId:inventoryStaff.user._id,role:'catalogue',status:'active',invitedByUserId:owner.user._id,acceptedAt:new Date()});
      await StoreMember.create([{publicId:nextId('stm'),storeId:store._id,userId:supportStaff.user._id,role:'support',status:'active',invitedByUserId:owner.user._id,acceptedAt:new Date()},
        {publicId:nextId('stm'),storeId:store._id,userId:withoutMfa.user._id,role:'catalogue',status:'active',invitedByUserId:owner.user._id,acceptedAt:new Date()}]);
      const inviter=await StoreMember.findOne({storeId:store._id,userId:owner.user._id});
      const invitation=await StoreTeamInvitation.create({publicId:nextId('sti'),storeId:store._id,storePublicId:store.publicId,country:store.country,currency:store.currency,
        emailHash:hashValue(normalizeEmail(withoutMfa.user.email)),emailEncrypted:encryptSensitive(withoutMfa.user.email),emailMasked:'i***@example.com',role:'catalogue',status:'accepted',
        invitedByUserId:owner.user._id,invitedByTokenVersion:owner.user.security.tokenVersion,invitedByMembershipId:inviter._id,invitedByRole:'owner',invitedByPermissionVersion:inviter.permissionVersion||0,
        recipientUserId:withoutMfa.user._id,respondedAt:new Date(),expiresAt:new Date(Date.now()+86400000)});
      await StoreMember.updateOne({storeId:store._id,userId:withoutMfa.user._id},{$set:{invitationId:invitation._id}});
      await selectStore(inventoryStaff,store);
      await selectStore(supportStaff,store);
      await inventoryStaff.client.get('/seller/inventory').expect(200);
      await supportStaff.client.get('/seller/inventory').expect(403);
      await assert.rejects(services.loadSellerInventoryPage(serviceRequest(supportStaff,store)),error=>error.code==='STORE_PERMISSION_DENIED');
      await withoutMfa.client.get('/seller/inventory').set('accept','application/json').expect(403);
      await assert.rejects(services.loadSellerInventoryPage(serviceRequest(withoutMfa,store)),error=>error.code==='MFA_ENROLLMENT_REQUIRED');
      const inbox=(await withoutMfa.client.get('/account/store-invitations').set('accept','application/json').expect(200)).body;
      assert.equal(inbox.requiresMfa,true);assert.equal(inbox.invitations.length,1);assert.equal(inbox.invitations[0].publicId,invitation.publicId);assert.equal(inbox.invitations[0].status,'accepted');
      const invitations=await withoutMfa.client.get('/account/store-invitations').expect(200);
      assert.match(invitations.text,/href="\/account\/security\?next=%2Faccount%2Fstore-invitations">Set up authenticator/u);
      const revoked=await StoreMember.updateOne({_id:membership._id,status:'active'},{$set:{status:'revoked'},$inc:{__v:1}});
      assert.equal(revoked.modifiedCount,1);
      await inventoryStaff.client.get('/seller/inventory').expect(403);
      await assert.rejects(services.createSellerWarehouse(serviceRequest(inventoryStaff,store),{name:'Revoked access location',country:'UG',city:'Kampala',address:'Revoked member address'}),error=>error.code==='STORE_PERMISSION_DENIED');
      const staleSession=serviceRequest(owner,store);staleSession.session.tokenVersion+=1;
      await assert.rejects(services.loadSellerInventoryPage(staleSession),error=>error.code==='ACCOUNT_UNAVAILABLE');
      const ownPage=await foreignOwner.client.get('/seller/inventory').expect(200);
      await foreignOwner.client.post('/seller/inventory/condition').set('accept','application/json').type('form').send({_csrf:csrf(ownPage.text),...await stockBody(stock,{damaged:0,quarantined:0,binCode:'Foreign attempt',reason:'Unauthorized update'})}).expect(404);
    });

    await t.test('full summaries and cursor pagination exclude other stores and country locations',async()=>{
      const extras=await ProductVariant.insertMany(Array.from({length:55},(_,index)=>({publicId:nextId('var'),storeId:store._id,productId:variant.productId,sku:`INV-PAGE-${String(index).padStart(3,'0')}`,title:'Pagination variant',priceMinor:1000,currency:'UGX'})));
      await StockItem.insertMany(extras.map((entry,index)=>({publicId:nextId('stk'),storeId:store._id,warehouseId:warehouse._id,variantId:entry._id,onHand:index===0?0:1,reorderPoint:index===1?2:0})));
      const first=(await owner.client.get('/seller/inventory').set('accept','application/json').expect(200)).body;
      assert.equal(first.rows.length,50);assert.equal(first.page.hasMore,true);assert.equal(first.summary.items,56);assert.equal(first.summary.onHand,94);
      const second=(await owner.client.get('/seller/inventory?after='+encodeURIComponent(first.page.next)).set('accept','application/json').expect(200)).body;
      assert.equal(second.rows.length,6);assert.equal(second.page.hasMore,false);
      assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,56);
      const out=(await owner.client.get('/seller/inventory?status=out').set('accept','application/json').expect(200)).body;
      assert.equal(out.rows.length,1);assert.equal(out.rows[0].cells.at(-1),'Out of stock');
      const low=(await owner.client.get('/seller/inventory?status=low').set('accept','application/json').expect(200)).body;
      assert.equal(low.rows.length,1);assert.equal(low.rows[0].cells.at(-1),'Low stock');
      const search=(await owner.client.get('/seller/inventory?search=INV-REAL').set('accept','application/json').expect(200)).body;
      assert.equal(search.rows.length,1);assert.equal(search.rows[0].id,stock.publicId);
      assert.equal(search.summary.onHand,94,'summary spans the complete store, not the search page');
    });

    await t.test('warehouse closure races safely with receipts and newly created work',async()=>{
      const {createWarehouseTask}=await import('../src/services/logistics.js');
      for(const action of ['receipt','task']) {
        const location=await Warehouse.create({publicId:nextId('whs'),storeId:store._id,ownerUserId:owner.user._id,name:`Concurrent ${action} location`,country:'UG',city:'Jinja',address:'Concurrent warehouse address'});
        const competing=action==='receipt'
          ? services.recordSellerStockMovement(scoped,{variantPublicId:variant.publicId,warehousePublicId:location.publicId,expectedVersion:'new',quantity:1,reorderPoint:0,reason:'Concurrent warehouse receipt'})
          : createWarehouseTask({warehouseId:location._id,storeId:store._id,type:'receive',quantity:1});
        const outcomes=await Promise.allSettled([competing,services.archiveSellerWarehouse(scoped,location.publicId,{expectedVersion:location.__v})]);
        assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1,`${action} and archive cannot both commit`);
        const fresh=await Warehouse.findById(location._id),stockUnits=(await StockItem.find({warehouseId:location._id})).reduce((sum,row)=>sum+row.onHand,0),tasks=await WarehouseTask.countDocuments({warehouseId:location._id,status:{$in:['open','in_progress']}});
        if(fresh.active) assert.ok(stockUnits>0||tasks>0);
        else {assert.equal(stockUnits,0);assert.equal(tasks,0);}
      }
    });

    await t.test('retired variants retain physical inventory controls while receipts require an active variant',async()=>{
      const retired=await ProductVariant.create({publicId:nextId('var'),storeId:store._id,productId:variant.productId,sku:'INV-RETIRED',title:'Retired variant',priceMinor:1000,currency:'UGX',active:false});
      const held=await StockItem.create({publicId:nextId('stk'),storeId:store._id,warehouseId:warehouse._id,variantId:retired._id,onHand:3});
      const flow=await services.loadSellerInventoryPage({...scoped,originalUrl:'/seller/inventory?stock='+held.publicId});
      assert.equal(flow.selectedStock.onHand,3);assert.equal(flow.selectedStock.variant.active,false);assert.ok(!flow.variants.some(row=>row.publicId===retired.publicId));
      await assert.rejects(services.recordSellerStockMovement(scoped,{variantPublicId:retired.publicId,warehousePublicId:warehouse.publicId,expectedVersion:held.__v,quantity:1,reorderPoint:0,reason:'Inactive variant receipt'}),error=>error.code==='INVENTORY_REFERENCE_INVALID');
      await services.changeSellerStockCondition(scoped,{stockPublicId:held.publicId,expectedVersion:held.__v,damaged:0,quarantined:0,binCode:'Retired bin',reason:'Retired stock count'});
      await services.recordSellerStockMovement(scoped,{variantPublicId:retired.publicId,warehousePublicId:warehouse.publicId,expectedVersion:(await StockItem.findById(held._id)).__v,quantity:-3,reorderPoint:0,reason:'Clear counted retired units'});
      assert.equal((await StockItem.findById(held._id)).onHand,0);
    });
  } finally {
    for(const transport of transports) transport.destroy();
    assert.equal(mongoose.connection.name,database);
    await mongoose.connection.dropDatabase();await mongoose.disconnect();
  }
});
