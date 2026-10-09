import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV='test';
process.env.MAIL_MODE='log';
process.env.SMS_MODE='log';
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const suffix=crypto.randomBytes(8).toString('hex');

test('warehouse primitives preserve atomic sessions, committed stock custody and independent inventory reconciliation',{skip:!uri},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/verification|test/i);
  await mongoose.connect(uri,{dbName:`classicmart_warehouse_integrity_test_${suffix}`});
  const {User,Store,Warehouse,StockItem,InventoryReservation,InventoryMovement,InventoryDiscrepancy,Order,SellerOrder,Shipment,Parcel,SellerShipment,WarehouseTask,WarehouseWave,ReturnRequest,CountrySetting}=await import('../src/models/index.js');
  const logistics=await import('../src/services/logistics.js');
  const {reserveStock,releaseReservation}=await import('../src/services/inventory.js');
  const {hashPassword}=await import('../src/core/crypto.js');
  const passwordHash=await hashPassword(`Warehouse-${suffix}A1!`);
  let sequence=0;
  const id=prefix=>`${prefix}_wi_${suffix}_${sequence++}`;
  const objectId=()=>new mongoose.Types.ObjectId();
  const abort=async operation=>{
    const session=await mongoose.startSession();
    try{await assert.rejects(session.withTransaction(async()=>{await operation(session);assert.equal(session.inTransaction(),true);throw new Error('Mandatory warehouse audit rejected');}),/Mandatory warehouse audit rejected/);assert.equal(session.hasEnded,false);}
    finally{await session.endSession();}
  };
  try{
    await Promise.all([User.init(),Store.init(),Warehouse.init(),StockItem.init(),InventoryReservation.init(),InventoryDiscrepancy.init(),Order.init(),SellerOrder.init(),Shipment.init(),Parcel.init(),SellerShipment.init(),WarehouseTask.init(),WarehouseWave.init(),ReturnRequest.init()]);
    async function actor(role){const publicId=id('usr'),email=publicId+'@example.com',phone='+2567'+crypto.randomInt(10000000,99999999);return User.create({publicId,name:'Warehouse Integrity Account',email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,country:'UG',currency:'UGX',emailVerifiedAt:new Date(),onboardingCompletedAt:new Date(),consents:{terms:true,privacy:true,recordedAt:new Date()}});}
    const owner=await actor('seller'),operator=await actor('warehouse'),reviewer=await actor('country_admin'),buyer=await actor('customer');
    await CountrySetting.create({code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256',active:true});
    const store=await Store.create({publicId:id('str'),ownerUserId:owner._id,name:'Warehouse Integrity Store',slug:id('store'),country:'UG',currency:'UGX',status:'verified'});
    const makeWarehouse=(country='UG',active=true)=>Warehouse.create({publicId:id('wh'),storeId:store._id,ownerUserId:owner._id,name:'Integrity Warehouse '+id('name'),country,city:'Kampala',address:'Warehouse test address',active});
    const first=await makeWarehouse(),second=await makeWarehouse(),unused=await makeWarehouse(),foreign=await makeWarehouse('KE'),inactive=await makeWarehouse('UG',false);
    const stock=(warehouse=first,onHand=20)=>StockItem.create({publicId:id('stk'),storeId:store._id,warehouseId:warehouse._id,variantId:objectId(),onHand,reserved:0,damaged:0,quarantined:0});
    async function fixture(groups=[{warehouse:first,quantity:2}]){
      const items=[],stocks=[];
      for(const group of groups){
        const itemStock=await stock(group.warehouse);stocks.push(itemStock);
        const reservation=await InventoryReservation.create({publicId:id('res'),idempotencyKey:id('reservation'),storeId:store._id,stockItemId:itemStock._id,variantId:itemStock.variantId,quantity:group.quantity,status:'committed',committedAt:new Date(),expiresAt:new Date(Date.now()+60000),actorUserId:buyer._id});
        items.push({linePublicId:id('line'),productId:objectId(),variantId:itemStock.variantId,storeId:store._id,reservationPublicId:reservation.publicId,productPublicId:id('prd'),variantPublicId:id('var'),storePublicId:store.publicId,title:'Warehouse Parcel Item',variantTitle:'Standard',sku:id('sku'),quantity:group.quantity,unitPriceMinor:1000,lineTotalMinor:1000*group.quantity,currency:'UGX'});
      }
      const subtotal=items.reduce((sum,item)=>sum+item.lineTotalMinor,0);
      const order=await Order.create({publicId:id('ord'),idempotencyKey:id('checkout'),checkoutId:id('checkout'),cartPublicId:id('cart'),sessionKey:id('session'),userId:buyer._id,country:'UG',status:'confirmed',paymentState:'pending',paymentMethod:'cod',deliveryMethod:'standard',contact:{fullName:buyer.name,email:buyer.email,phone:buyer.phone,address:'Test address',city:'Kampala',country:'Uganda'},totals:{subtotalMinor:subtotal,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:subtotal,currency:'UGX'},items,reservationExpiresAt:new Date(Date.now()+60000)});
      const sellerOrder=await SellerOrder.create({publicId:id('so'),orderId:order._id,orderPublicId:order.publicId,storeId:store._id,storePublicId:store.publicId,country:'UG',status:'confirmed',subtotalMinor:subtotal,currency:'UGX',items:items.map(item=>({...item,orderLineId:item.linePublicId}))});
      const shipment=await logistics.ensureShipmentForOrder(order,owner._id),parcel=await Parcel.findOne({shipmentId:shipment._id});
      return {order,sellerOrder,shipment,parcel,stocks};
    }
    const task=(f,type,warehouse=first,fields={},session=null)=>logistics.createWarehouseTask({warehouseId:warehouse._id,storeId:store._id,orderId:f.order._id,shipmentId:f.shipment._id,parcelId:f.parcel._id,type,assignedUserId:operator._id,quantity:0,...fields},session);
    const execute=task=>logistics.executeWarehouseTask({task,actorUserId:operator._id});

    await t.test('all optional sessions retain caller ownership and roll back claims, counts, reviews and waves',async()=>{
      const f=await fixture(),open=await task(f,'pick',first,{assignedUserId:null,quantity:2});
      await abort(async session=>{const claimed=await logistics.claimWarehouseTask({taskPublicId:open.publicId,actorUserId:operator._id,session});assert.equal(claimed.__v,open.__v+1);});
      assert.equal((await WarehouseTask.findById(open._id)).status,'open');
      const claimed=await logistics.claimWarehouseTask({taskPublicId:open.publicId,actorUserId:operator._id});
      await abort(session=>logistics.releaseWarehouseTask({taskPublicId:open.publicId,actorUserId:operator._id,session}));
      assert.equal((await WarehouseTask.findById(open._id)).status,'in_progress');
      const released=await logistics.releaseWarehouseTask({taskPublicId:open.publicId,actorUserId:operator._id});
      assert.equal(released.__v,claimed.__v+1);
      const item=await stock();
      await abort(session=>logistics.completeCycleCount({stockItem:item,countedOnHand:22,actorUserId:operator._id,sourceKey:id('count'),session}));
      assert.equal(await InventoryDiscrepancy.countDocuments({stockItemId:item._id}),0);
      assert.equal((await StockItem.findById(item._id)).__v,item.__v);
      const discrepancy=await logistics.completeCycleCount({stockItem:item,countedOnHand:22,actorUserId:operator._id});
      await abort(session=>logistics.reviewInventoryDiscrepancy({discrepancyPublicId:discrepancy.publicId,decision:'approve',actorUserId:reviewer._id,session}));
      assert.equal((await StockItem.findById(item._id)).onHand,20);
      assert.equal((await InventoryDiscrepancy.findById(discrepancy._id)).status,'pending_review');
      assert.equal(await InventoryMovement.countDocuments({reference:discrepancy.publicId}),0);
      const next=await fixture();await task(next,'pick',first,{assignedUserId:null,quantity:2});
      await abort(session=>logistics.createPickWave({warehouseId:first._id,actorUserId:operator._id,batchSize:2,session}));
      assert.equal(await WarehouseWave.countDocuments(),0);
      const wave=await logistics.createPickWave({warehouseId:first._id,actorUserId:operator._id,batchSize:2});
      assert.equal(wave.totalQuantity,4);
      await abort(session=>logistics.releasePickWave({wavePublicId:wave.publicId,actorUserId:operator._id,session}));
      assert.equal((await WarehouseWave.findById(wave._id)).status,'in_progress');
      for(const taskId of wave.taskIds)await assert.rejects(logistics.releaseWarehouseTask({taskPublicId:(await WarehouseTask.findById(taskId)).publicId,actorUserId:operator._id}),{code:'WAREHOUSE_TASK_RELEASE_CONFLICT'});
      await logistics.releasePickWave({wavePublicId:wave.publicId,actorUserId:operator._id});
      assert.equal((await WarehouseWave.findById(wave._id)).status,'released');
      await WarehouseTask.updateMany({_id:{$in:wave.taskIds}},{$set:{status:'cancelled'}});
    });

    await t.test('inventory counts reject stale snapshots, ABA reservation changes, self review and repeated approval',async()=>{
      const item=await stock(),count=await logistics.completeCycleCount({stockItem:item,countedOnHand:22,actorUserId:operator._id});
      assert.equal(count.stockVersionSnapshot,(await StockItem.findById(item._id)).__v);
      await assert.rejects(logistics.reviewInventoryDiscrepancy({discrepancyPublicId:count.publicId,decision:'approve',actorUserId:operator._id}),{code:'INVENTORY_REVIEW_FOUR_EYES'});
      const reservation=await reserveStock({stockItemId:item._id,storeId:store._id,quantity:3,idempotencyKey:id('aba-reservation'),actorUserId:buyer._id,expiresAt:new Date(Date.now()+60000)});
      await releaseReservation({reservationPublicId:reservation.publicId,actorUserId:buyer._id});
      const after=await StockItem.findById(item._id);assert.equal(after.onHand,20);assert.equal(after.reserved,0);assert.ok(after.__v>count.stockVersionSnapshot);
      await assert.rejects(logistics.reviewInventoryDiscrepancy({discrepancyPublicId:count.publicId,decision:'approve',actorUserId:reviewer._id}),{code:'INVENTORY_DISCREPANCY_STALE'});
      await assert.rejects(logistics.completeCycleCount({stockItem:item,countedOnHand:21,actorUserId:operator._id}),{code:'STOCK_VERSION_CONFLICT'});
      await logistics.reviewInventoryDiscrepancy({discrepancyPublicId:count.publicId,decision:'reject',actorUserId:reviewer._id,reviewNote:'Inventory moved; recount required'});
      const fresh=await logistics.completeCycleCount({stockItem:after,countedOnHand:21,actorUserId:operator._id});
      const outcomes=await Promise.allSettled(Array.from({length:4},()=>logistics.reviewInventoryDiscrepancy({discrepancyPublicId:fresh.publicId,decision:'approve',actorUserId:reviewer._id})));
      assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
      assert.equal((await StockItem.findById(item._id)).onHand,21);
      assert.equal(await InventoryMovement.countDocuments({reference:fresh.publicId,type:'adjustment'}),1);
      const historicalItem=await stock(),historical=await logistics.completeCycleCount({stockItem:historicalItem,countedOnHand:21,actorUserId:operator._id});
      await InventoryDiscrepancy.collection.updateOne({_id:historical._id},{$unset:{stockVersionSnapshot:1}});
      await assert.rejects(logistics.reviewInventoryDiscrepancy({discrepancyPublicId:historical.publicId,decision:'approve',actorUserId:reviewer._id}),{code:'INVENTORY_DISCREPANCY_STALE'});
      await logistics.reviewInventoryDiscrepancy({discrepancyPublicId:historical.publicId,decision:'reject',actorUserId:reviewer._id,reviewNote:'Historical count requires a versioned recount'});
      const oldObservation=await stock(),queueFixture=await fixture();
      const queued=await task(queueFixture,'cycle_count',first,{stockItemId:oldObservation._id,variantId:oldObservation.variantId,quantity:18});
      await execute(await task(queueFixture,'receive',first,{stockItemId:oldObservation._id,variantId:oldObservation.variantId,quantity:5}));
      const moved=await StockItem.findById(oldObservation._id);
      await assert.rejects(execute(queued),{code:'COUNT_RECOUNT_REQUIRED'});
      assert.equal(await InventoryDiscrepancy.countDocuments({stockItemId:oldObservation._id}),0);
      assert.equal((await StockItem.findById(oldObservation._id)).onHand,25);
      assert.equal((await StockItem.findById(oldObservation._id)).__v,moved.__v);
      assert.equal((await WarehouseTask.findById(queued._id)).status,'in_progress');
      const immediate=await logistics.completeCycleCount({stockItem:moved,countedOnHand:25,actorUserId:operator._id});
      assert.equal(immediate.status,'no_variance');
    });

    await t.test('parcel picking follows exact committed warehouse quantities and dispatch remains at its consolidation warehouse',async()=>{
      const f=await fixture([{warehouse:first,quantity:2},{warehouse:second,quantity:3}]);
      await assert.rejects(execute(await task(f,'pick',unused,{quantity:5})),{code:'PICK_WAREHOUSE_INVALID'});
      await assert.rejects(execute(await task(f,'pick',first,{quantity:5})),{code:'PICK_QUANTITY_INVALID'});
      const picked=await execute(await task(f,'pick',first,{quantity:2}));assert.equal(picked.result.pickedQuantity,2);
      assert.equal((await Parcel.findById(f.parcel._id)).status,'picking');
      await assert.rejects(execute(await task(f,'pack',first)),{code:'PARCEL_STATE'});
      await execute(await task(f,'pick',second,{quantity:3}));
      assert.equal((await Parcel.findById(f.parcel._id)).pickedQuantity,5);
      await execute(await task(f,'pack',second));
      await assert.rejects(execute(await task(f,'dispatch',first)),{code:'PACK_WAREHOUSE_UNAVAILABLE'});
      await execute(await task(f,'dispatch',second));
      assert.equal((await Parcel.findById(f.parcel._id)).status,'handed_over');
      assert.equal((await SellerShipment.findOne({parcelId:f.parcel._id})).status,'handed_over');
      for(const item of f.stocks)assert.equal((await StockItem.findById(item._id)).onHand,20,'physical picking must not deduct already committed inventory twice');
      await WarehouseTask.updateMany({parcelId:f.parcel._id,status:'in_progress'},{$set:{status:'cancelled'}});
    });

    await t.test('warehouse progress retries against concurrent cancellation and cannot cross an active refund freeze',async()=>{
      const f=await fixture(),pick=await task(f,'pick',first,{quantity:2});
      const original=Order.findById;let cancelled=false;
      t.mock.method(Order,'findById',function(...args){const query=original.apply(this,args),exec=query.exec;query.exec=async function(...params){const value=await exec.apply(this,params);if(!cancelled&&String(args[0])===String(f.order._id)&&this.getOptions().session){cancelled=true;await Order.updateOne({_id:f.order._id},{$set:{cancellationState:'cancelled',fulfillmentState:'cancelled',status:'cancelled'},$inc:{__v:1}});}return value;};return query;});
      try{await assert.rejects(execute(pick),{code:'ORDER_NOT_READY'});}finally{t.mock.restoreAll();}
      assert.equal(cancelled,true);assert.equal((await Parcel.findById(f.parcel._id)).pickedQuantity,0);assert.equal((await WarehouseTask.findById(pick._id)).status,'in_progress');
      const other=await fixture();await Order.updateOne({_id:other.order._id},{$set:{refundState:'pending'}});
      await assert.rejects(execute(await task(other,'pick',first,{quantity:2})),{code:'ORDER_NOT_READY'});
      const paused=await fixture(),pausedTask=await task(paused,'pick',first,{quantity:2});
      await Store.updateOne({_id:store._id},{$set:{status:'suspended'},$inc:{__v:1}});
      await assert.rejects(execute(pausedTask),{code:'WAREHOUSE_PARCEL_SCOPE'});
      await Store.updateOne({_id:store._id},{$set:{status:'verified'},$inc:{__v:1}});
      const findStore=Store.findOne;let suspended=false;
      t.mock.method(Store,'findOne',function(...args){const query=findStore.apply(this,args),exec=query.exec;query.exec=async function(...params){const value=await exec.apply(this,params);if(!suspended&&String(args[0]?._id)===String(store._id)&&this.getOptions().session){suspended=true;await Store.updateOne({_id:store._id},{$set:{status:'suspended'},$inc:{__v:1}});}return value;};return query;});
      try{await assert.rejects(execute(pausedTask),{code:'WAREHOUSE_PARCEL_SCOPE'});}finally{t.mock.restoreAll();await Store.updateOne({_id:store._id},{$set:{status:'verified'},$inc:{__v:1}});}
      assert.equal(suspended,true);assert.equal((await Parcel.findById(paused.parcel._id)).pickedQuantity,0);assert.equal((await WarehouseTask.findById(pausedTask._id)).status,'in_progress');
      await WarehouseTask.updateMany({parcelId:{$in:[f.parcel._id,other.parcel._id,paused.parcel._id]}},{$set:{status:'cancelled'}});
    });

    await t.test('receiving and transfers enforce exact scope, active same-country destinations, limits and single execution',async()=>{
      const item=await stock(),f=await fixture();
      const make=(type,fields={})=>task(f,type,first,{stockItemId:item._id,variantId:item.variantId,...fields});
      await assert.rejects(execute(await make('receive',{quantity:2,variantId:objectId()})),{code:'STOCK_WAREHOUSE_MISMATCH'});
      for(const destination of [first,foreign,inactive])await assert.rejects(execute(await make('transfer',{quantity:2,destinationWarehouseId:destination._id})),{code:'TRANSFER_SCOPE'});
      const elsewhere=await stock(second);
      await assert.rejects(execute(await make('transfer',{quantity:2,stockItemId:elsewhere._id,variantId:elsewhere.variantId,destinationWarehouseId:second._id})),{code:'STOCK_WAREHOUSE_MISMATCH'});
      const receipt=await make('receive',{quantity:4}),outcomes=await Promise.allSettled(Array.from({length:4},()=>execute(receipt)));
      assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
      assert.equal((await StockItem.findById(item._id)).onHand,24);assert.equal(await InventoryMovement.countDocuments({stockItemId:item._id,type:'receipt'}),1);
      await execute(await make('transfer',{quantity:5,destinationWarehouseId:second._id}));
      assert.equal((await StockItem.findById(item._id)).onHand,19);
      assert.equal((await StockItem.findOne({warehouseId:second._id,variantId:item.variantId})).onHand,5);
      const capped=await stock(first,2_000_000_000);await assert.rejects(execute(await make('receive',{stockItemId:capped._id,variantId:capped.variantId,quantity:1})),{code:'STOCK_QUANTITY_LIMIT'});
    });

    await t.test('received return inspection requires its delivered line and exact task and records disposition exactly once',async()=>{
      async function returned(){const f=await fixture();await Order.updateOne({_id:f.order._id},{$set:{status:'paid',paymentState:'paid',fulfillmentState:'delivered','items.0.deliveredQuantity':2,'items.0.returnedQuantity':2}});
        const line=f.order.items[0];const doc=await ReturnRequest.create({publicId:id('ret'),orderId:f.order._id,orderPublicId:f.order.publicId,userId:buyer._id,country:'UG',status:'received',reason:'other',details:'Received return integration fixture',resolution:'refund',eligibleUntil:new Date(Date.now()+60000),policyVersion:'2026-01',items:[{orderLineId:line.linePublicId,productId:line.productId,variantId:line.variantId,storeId:store._id,storePublicId:store.publicId,productPublicId:line.productPublicId,variantPublicId:line.variantPublicId,sku:line.sku,title:line.title,quantity:2,unitPriceMinor:1000,requestedRefundMinor:2000,warehouseInspectionStatus:'pending'}]});
        const inspection=await task(f,'return_inspection',first,{returnRequestId:doc._id,returnOrderLineId:line.linePublicId,stockItemId:f.stocks[0]._id,variantId:line.variantId,quantity:2});await ReturnRequest.updateOne({_id:doc._id},{$set:{'items.0.warehouseTaskPublicId':inspection.publicId}});return {...f,doc,inspection};}
      const f=await returned();
      await abort(session=>logistics.executeWarehouseTask({task:f.inspection,actorUserId:operator._id,disposition:'damaged',session}));
      assert.equal((await StockItem.findById(f.stocks[0]._id)).onHand,20);assert.equal((await ReturnRequest.findById(f.doc._id)).items[0].warehouseInspectionStatus,'pending');
      await logistics.executeWarehouseTask({task:f.inspection,actorUserId:operator._id,disposition:'damaged'});
      const item=await StockItem.findById(f.stocks[0]._id);assert.equal(item.onHand,22);assert.equal(item.damaged,2);
      assert.equal((await ReturnRequest.findById(f.doc._id)).items[0].inspectedQuantity,2);
      assert.equal(await InventoryMovement.countDocuments({reference:f.doc.publicId,type:'return'}),1);
      await assert.rejects(logistics.executeWarehouseTask({task:f.inspection,actorUserId:operator._id,disposition:'damaged'}),{code:'WAREHOUSE_TASK_NOT_OWNED'});
      const bad=await returned();await WarehouseTask.updateOne({_id:bad.inspection._id},{$set:{quantity:3}});
      await assert.rejects(logistics.executeWarehouseTask({task:bad.inspection,actorUserId:operator._id,disposition:'good'}),{code:'RETURN_INSPECTION_SCOPE'});
      await WarehouseTask.updateOne({_id:bad.inspection._id},{$set:{quantity:2,warehouseId:foreign._id}});
      await assert.rejects(logistics.executeWarehouseTask({task:bad.inspection,actorUserId:operator._id,disposition:'good'}),{code:'RETURN_INSPECTION_STATE'});
      assert.equal((await StockItem.findById(bad.stocks[0]._id)).onHand,20);
    });

    await t.test('pick waves complete with their final task and release cannot steal a claimed task',async()=>{
      const a=await fixture(),b=await fixture();await task(a,'pick',first,{assignedUserId:null});await task(b,'pick',first,{assignedUserId:null});
      const wave=await logistics.createPickWave({warehouseId:first._id,actorUserId:operator._id,batchSize:2});
      assert.equal(wave.totalQuantity,4);
      await assert.rejects(logistics.releasePickWave({wavePublicId:wave.publicId,actorUserId:reviewer._id}),{code:'PICK_WAVE_RELEASE_CONFLICT'});
      await execute(await WarehouseTask.findById(wave.taskIds[0]));assert.equal((await WarehouseWave.findById(wave._id)).status,'in_progress');
      await execute(await WarehouseTask.findById(wave.taskIds[1]));assert.equal((await WarehouseWave.findById(wave._id)).status,'completed');
      assert.equal((await WarehouseWave.findById(wave._id)).history.filter(event=>event.action==='completed').length,1);
    });
  }finally{
    t.mock.restoreAll();
    try { if(mongoose.connection.readyState===1)await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});
