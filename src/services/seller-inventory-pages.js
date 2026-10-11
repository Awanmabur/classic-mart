import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { User, Store, StoreMember, CountrySetting, Product, ProductVariant, StockItem, Warehouse, WarehouseTask, InventoryLot, InventoryMovement } from '../models/index.js';
import { warehouseSchema, stockAdjustmentSchema } from '../validation/catalogue.js';
import { adjustStock, setStockCondition, createInventoryLot, setInventoryLotStatus } from './inventory.js';
import { writeAudit } from './audit.js';
import { getCountries } from './country.js';
import { storeCapabilities } from './store.js';
import { cursorScope, cursorSort, pageResult, decodeCursor } from './pagination.js';

const PAGE_SIZE = 50;
const idSchema = z.string().trim().min(5).max(100);
const versionSchema = z.preprocess(value => String(value ?? ''), z.string().regex(/^\d+$/, 'Refresh inventory before submitting this change.').transform(Number).refine(Number.isSafeInteger));
const reasonSchema = z.string().trim().min(3, 'Explain this inventory change in at least 3 characters.').max(300);
const countSchema = z.coerce.number().int().min(0).max(2_000_000_000);
const available = row => Number(row.onHand) - Number(row.reserved) - Number(row.damaged) - Number(row.quarantined);
const inventoryState = row => available(row) <= 0 ? 'out' : available(row) <= row.reorderPoint ? 'low' : 'healthy';
const stateLabel = state => ({out:'Out of stock', low:'Low stock', healthy:'Healthy'})[state];
const escapeSearch = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const auditFor = (request, action, targetType, metadata = {}) => (document, session) => writeAudit(request, action, {
  targetType, targetPublicId: document.publicId, country: request.store.country, metadata, session,
});

async function inventoryAccess(request, session = null) {
  if (!request.user?._id || !request.store?._id) throw new AppError('Seller authentication is required.',401,'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id).select('status security.tokenVersion security.mfaEnabled emailVerifiedAt onboardingCompletedAt').session(session).lean();
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) throw new AppError('Your account or session is unavailable.',403,'ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw new AppError('Complete verification and onboarding before managing inventory.',403,'ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for store operations.',403,'MFA_ENROLLMENT_REQUIRED');
  const member = await StoreMember.findOne({storeId:request.store._id,userId:actor._id,status:'active'}).session(session).lean();
  const granted = storeCapabilities(member?.role);
  if (!member || (!granted.has('*') && !granted.has('inventory'))) throw new AppError('Your store staff role does not allow that action.',403,'STORE_PERMISSION_DENIED');
  const store = await Store.findById(request.store._id).session(session).lean();
  if (!store || !['pending_verification','verified'].includes(store.status)) throw new AppError('This store is unavailable.',409,'STORE_LOCKED');
  if (store.country !== request.store.country || store.currency !== request.store.currency) throw new AppError('Your store settings changed. Refresh inventory.',409,'SELLER_STORE_SCOPE_CHANGED');
  const country = await CountrySetting.findOne({code:store.country,active:true}).select('currency').session(session).lean();
  if (!country || country.currency !== store.currency) throw new AppError('The store country and currency need configuration.',409,'SELLER_COUNTRY_UNAVAILABLE');
  return {actor,member,store};
}

async function lockInventoryAccess(request, session) {
  const {actor,member,store} = await inventoryAccess(request,session);
  await User.updateOne({_id:actor._id,status:'active','security.tokenVersion':actor.security.tokenVersion},{$inc:{__v:1}},{session});
  await StoreMember.updateOne({_id:member._id,status:'active',role:member.role},{$inc:{__v:1}},{session});
  await Store.updateOne({_id:store._id,status:store.status,country:store.country,currency:store.currency},{$inc:{__v:1}},{session});
}

async function inventoryScope(request) {
  await inventoryAccess(request);
  const storeId = request.store._id;
  const [warehouses, products] = await Promise.all([
    Warehouse.find({storeId, country:request.store.country, active:true}).sort({name:1}).lean(),
    Product.find({storeId, countries:request.store.country}).select('_id title').lean(),
  ]);
  // Retired variants can still hold physical stock that must be counted,
  // traced, or cleared before a warehouse can close.
  const variants = await ProductVariant.find({storeId, productId:{$in:products.map(row=>row._id)}}).sort({sku:1}).lean();
  const productById = new Map(products.map(row=>[String(row._id),row]));
  return {warehouses, variants:variants.map(row=>({...row,productTitle:productById.get(String(row.productId))?.title || row.title})),
    stockScope:{storeId,warehouseId:{$in:warehouses.map(row=>row._id)},variantId:{$in:variants.map(row=>row._id)}}};
}

export function inventoryFilters(request) {
  const query = new URL(request.originalUrl, 'http://localhost').searchParams;
  for (const key of ['search','status','after','stock']) {
    if (query.getAll(key).length > 1 || [...query.keys()].some(name=>name.startsWith(key+'[')||name.startsWith(key+'.'))) {
      throw new AppError('Use one value for each inventory filter.',422,'INVENTORY_FILTER_INVALID');
    }
  }
  const search = (query.get('search') || '').trim();
  const status = query.get('status') || 'all';
  const after = query.get('after') || '';
  const stock = query.get('stock') || '';
  if (search.length > 120 || !['all','healthy','low','out'].includes(status) || (after && !decodeCursor(after)) || stock.length > 100) {
    throw new AppError('Select supported inventory filters.',422,'INVENTORY_FILTER_INVALID');
  }
  return {search,status,after,stock};
}

export async function loadSellerInventoryPage(request, {error='', section='', draft={}} = {}) {
  const filters = inventoryFilters(request);
  const {warehouses,variants,stockScope} = await inventoryScope(request);
  const warehouseById = new Map(warehouses.map(row=>[String(row._id),row]));
  const variantById = new Map(variants.map(row=>[String(row._id),row]));
  const filtered = {...stockScope};
  if (filters.search) {
    const rx = new RegExp(escapeSearch(filters.search),'i');
    filtered.variantId = {$in:variants.filter(row=>[row.sku,row.title,row.productTitle].some(value=>rx.test(value))).map(row=>row._id)};
  }
  const availableExpr = {$subtract:['$onHand',{$add:['$reserved','$damaged','$quarantined']}]};
  if (filters.status === 'out') filtered.$expr = {$lte:[availableExpr,0]};
  if (filters.status === 'low') filtered.$expr = {$and:[{$gt:[availableExpr,0]},{$lte:[availableExpr,'$reorderPoint']}]};
  if (filters.status === 'healthy') filtered.$expr = {$gt:[availableExpr,'$reorderPoint']};
  const [stockRows,total,summaryRows] = await Promise.all([
    StockItem.find(cursorScope(filtered,filters.after)).sort(cursorSort()).limit(PAGE_SIZE+1).lean(),
    StockItem.countDocuments(filtered),
    StockItem.aggregate([{$match:stockScope},{$project:{onHand:1,reserved:1,damaged:1,quarantined:1,available:availableExpr,reorderPoint:1}},{$group:{_id:null,
      items:{$sum:1},onHand:{$sum:'$onHand'},reserved:{$sum:'$reserved'},damaged:{$sum:'$damaged'},quarantined:{$sum:'$quarantined'},available:{$sum:'$available'},
      low:{$sum:{$cond:[{$and:[{$gt:['$available',0]},{$lte:['$available','$reorderPoint']}]},1,0]}},out:{$sum:{$cond:[{$lte:['$available',0]},1,0]}}}}]),
  ]);
  const page = pageResult(stockRows,{limit:PAGE_SIZE,total});
  const decorate = row => ({...row, available:available(row),state:inventoryState(row),warehouse:warehouseById.get(String(row.warehouseId)),variant:variantById.get(String(row.variantId))});
  const stock = page.items.map(decorate);
  let selectedStock = null;
  const selectedPublicId = filters.stock || (['movement','condition','lot','lot-status'].includes(section) ? draft.stockPublicId : '');
  if (selectedPublicId) {
    const selected = await StockItem.findOne({...stockScope,publicId:selectedPublicId}).lean();
    if (!selected) throw new AppError('Stock item not found.',404,'STOCK_NOT_FOUND');
    selectedStock = decorate(selected);
  }
  const [lots,movements] = selectedStock ? await Promise.all([
    InventoryLot.find({storeId:request.store._id,stockItemId:selectedStock._id}).sort(cursorSort()).limit(50).lean(),
    InventoryMovement.find({storeId:request.store._id,stockItemId:selectedStock._id}).sort(cursorSort()).limit(20).lean(),
  ]) : [[],[]];
  const summary = summaryRows[0] || {items:0,onHand:0,reserved:0,damaged:0,quarantined:0,available:0,low:0,out:0};
  const healthy = summary.items-summary.low-summary.out;
  return {kind:'inventory',store:{publicId:request.store.publicId,name:request.store.name,country:request.store.country},
    metrics:[{label:'Stock units',value:String(summary.onHand),detail:`Across ${summary.items} stock locations`},
      {label:'Low stock',value:String(summary.low),detail:'Below reorder point'}, {label:'Out of stock',value:String(summary.out),detail:'No available units'},
      {label:'Reserved',value:String(summary.reserved),detail:'Held for orders'}],
    columns:['Product','SKU','Available','Reserved','Status'],
    rows:stock.map(row=>({id:row.publicId,cells:[row.variant.productTitle,row.variant.sku,String(row.available),String(row.reserved),stateLabel(row.state)],href:'/seller/inventory?stock='+encodeURIComponent(row.publicId)+'#stock-editor'})),
    insights:[{text:`${summary.low} stock locations need replenishment.`,href:'/seller/inventory?status=low',label:'Review low stock'},
      {text:`${summary.damaged} damaged and ${summary.quarantined} quarantined units are excluded from availability.`,href:'#stock-controls',label:'Inspect stock condition'},
      {text:`${warehouses.length} active warehouses serve ${request.store.country}.`,href:'#warehouse-controls',label:'Manage warehouses'}],
    health:{value:summary.items?Math.round(healthy/summary.items*100):null,label:summary.items?'Stock locations above reorder point':'No stock locations yet',rows:[
      {label:'Available units',value:String(summary.available)},{label:'Damaged units',value:String(summary.damaged)},{label:'Quarantined units',value:String(summary.quarantined)}]},
    workflow:[{title:'Record stock movement',text:'Receive stock or record a counted adjustment with a reason.',href:'#stock-controls',label:'Record movement'},
      {title:'Trace inventory',text:'Open a stock item to manage condition, batch, serial, and expiry records.',href:'#inventory-records',label:'Open inventory'},
      {title:'Manage locations',text:'Keep warehouse details current and close empty locations safely.',href:'#warehouse-controls',label:'Manage warehouses'}],
    create:{label:'Record stock movement',href:'#stock-controls'},
    filters:{search:filters.search,status:filters.status,after:filters.after,statuses:[{value:'all',label:'All stock'},{value:'healthy',label:'Healthy'},{value:'low',label:'Low stock'},{value:'out',label:'Out of stock'}]},
    page:page.page,warehouses,variants:variants.filter(row=>row.active),stock,selectedStock,lots,movements,summary,error,section,draft};
}

async function ownedStock(request, publicIdValue) {
  const {stockScope} = await inventoryScope(request);
  const stock = await StockItem.findOne({...stockScope,publicId:idSchema.parse(publicIdValue)});
  if (!stock) throw new AppError('Stock item not found.',404,'STOCK_NOT_FOUND');
  return stock;
}

async function warehouseCountry(request, input) {
  if (input.country !== request.store.country || !(await getCountries()).some(row=>row.code===input.country)) {
    throw new AppError('Warehouse country must match the active store country.',422,'INVENTORY_COUNTRY_INVALID');
  }
}

async function warehouseTransaction(operation) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(()=>operation(session)); }
  finally { await session.endSession(); }
}

export async function createSellerWarehouse(request, body) {
  const input = warehouseSchema.parse(body);
  await warehouseCountry(request,input);
  return warehouseTransaction(async session => {
    await lockInventoryAccess(request,session);
    const [warehouse] = await Warehouse.create([{publicId:publicId('whs'),storeId:request.store._id,ownerUserId:request.store.ownerUserId,...input}],{session});
    await auditFor(request,'inventory.warehouse_created','warehouse')(warehouse,session);
    return warehouse;
  });
}

export async function updateSellerWarehouse(request, warehousePublicId, body) {
  const input = warehouseSchema.parse(body), expectedVersion = versionSchema.parse(body.expectedVersion);
  await warehouseCountry(request,input);
  return warehouseTransaction(async session => {
    await lockInventoryAccess(request,session);
    const warehouse = await Warehouse.findOne({publicId:warehousePublicId,storeId:request.store._id,country:request.store.country,active:true}).session(session);
    if (!warehouse) throw new AppError('Warehouse not found.',404,'WAREHOUSE_NOT_FOUND');
    if (warehouse.__v !== expectedVersion) throw new AppError('Warehouse version changed. Refresh inventory and retry.',409,'WAREHOUSE_VERSION_CONFLICT');
    Object.assign(warehouse,input); await warehouse.save({session});
    await auditFor(request,'inventory.warehouse_updated','warehouse')(warehouse,session);
    return warehouse;
  });
}

export async function archiveSellerWarehouse(request, warehousePublicId, body) {
  const expectedVersion = versionSchema.parse(body.expectedVersion);
  return warehouseTransaction(async session => {
    await lockInventoryAccess(request,session);
    const warehouse = await Warehouse.findOne({publicId:warehousePublicId,storeId:request.store._id,country:request.store.country,active:true}).session(session);
    if (!warehouse) throw new AppError('Warehouse not found.',404,'WAREHOUSE_NOT_FOUND');
    if (warehouse.__v !== expectedVersion) throw new AppError('Warehouse version changed. Refresh inventory and retry.',409,'WAREHOUSE_VERSION_CONFLICT');
    const stock = await StockItem.exists({storeId:request.store._id,warehouseId:warehouse._id,$or:[{onHand:{$gt:0}},{reserved:{$gt:0}},{damaged:{$gt:0}},{quarantined:{$gt:0}}]}).session(session);
    const lots = await InventoryLot.exists({storeId:request.store._id,warehouseId:warehouse._id,status:{$ne:'depleted'}}).session(session);
    const tasks = await WarehouseTask.exists({storeId:request.store._id,status:{$in:['open','in_progress']},$or:[{warehouseId:warehouse._id},{destinationWarehouseId:warehouse._id}]}).session(session);
    if (stock || lots || tasks) throw new AppError('Move remaining stock, reconcile lots, and finish warehouse work before archiving this location.',409,'WAREHOUSE_NOT_EMPTY');
    warehouse.active = false; await warehouse.save({session});
    await auditFor(request,'inventory.warehouse_archived','warehouse')(warehouse,session);
    return warehouse;
  });
}

export async function recordSellerStockMovement(request, body) {
  const input = stockAdjustmentSchema.parse(body);
  const expectedVersion = body.expectedVersion === 'new' ? 'new' : versionSchema.parse(body.expectedVersion);
  const {warehouses,variants} = await inventoryScope(request);
  const warehouse = warehouses.find(row=>row.publicId===input.warehousePublicId), variant = variants.find(row=>row.publicId===input.variantPublicId);
  if (!warehouse || !variant || (!variant.active && input.quantity > 0)) throw new AppError('Warehouse or product variant is unavailable for this movement in this store country.',422,'INVENTORY_REFERENCE_INVALID');
  return adjustStock({...input,warehouseId:warehouse._id,variantId:variant._id,storeId:request.store._id,actorUserId:request.user._id,expectedVersion,
    warehouseCountry:request.store.country,authorize:async session=>{
      await lockInventoryAccess(request,session);
      // Catalogue changes must share the receipt transaction's write boundary
      // so a concurrently retired variant or changed country cannot receive.
      const variantQuery={_id:variant._id,storeId:request.store._id};
      if(input.quantity>0)variantQuery.active=true;
      const currentVariant=await ProductVariant.findOneAndUpdate(variantQuery,{$inc:{__v:1}},{session,returnDocument:'after'});
      if(!currentVariant)throw new AppError('Product variant changed. Refresh inventory before recording this movement.',422,'INVENTORY_REFERENCE_INVALID');
      const product=await Product.findOneAndUpdate({_id:currentVariant.productId,storeId:request.store._id,countries:request.store.country},{$inc:{__v:1}},{session,returnDocument:'after'});
      if(!product)throw new AppError('Product country changed. Refresh inventory before recording this movement.',422,'INVENTORY_REFERENCE_INVALID');
    },audit:auditFor(request,'inventory.stock_adjusted','stock_item',{quantity:input.quantity,reason:input.reason})});
}

export async function changeSellerStockCondition(request, body) {
  const input = z.object({stockPublicId:idSchema,damaged:countSchema,quarantined:countSchema,binCode:z.string().trim().max(80),reason:reasonSchema,expectedVersion:versionSchema}).parse(body);
  const stock = await ownedStock(request,input.stockPublicId);
  return setStockCondition({...input,stockItemId:stock._id,storeId:request.store._id,actorUserId:request.user._id,
    authorize:session=>lockInventoryAccess(request,session),audit:auditFor(request,'inventory.condition_changed','stock_item',{damaged:input.damaged,quarantined:input.quarantined,reason:input.reason})});
}

export async function recordSellerInventoryLot(request, body) {
  const input = z.object({stockPublicId:idSchema,quantity:countSchema.refine(value=>value>0,'Lot quantity must be positive.'),batchNumber:z.string().trim().max(120),
    serialNumbers:z.string().max(40_000).default(''),expiresAt:z.string().max(40).default(''),notes:z.string().trim().max(500).default(''),expectedVersion:versionSchema}).parse(body);
  const stock = await ownedStock(request,input.stockPublicId);
  const serialNumbers = input.serialNumbers.split(/\r?\n|,/u).map(value=>value.trim()).filter(Boolean);
  if (serialNumbers.length>500 || serialNumbers.some(value=>value.length>120)) throw new AppError('Use at most 500 serial numbers, each up to 120 characters.',422,'LOT_SERIAL_INVALID');
  if (input.expiresAt && (!/^\d{4}-\d{2}-\d{2}$/u.test(input.expiresAt) || !Number.isFinite(new Date(input.expiresAt).getTime()) || new Date(input.expiresAt).toISOString().slice(0,10)!==input.expiresAt)) throw new AppError('Enter a valid expiry date.',422,'LOT_EXPIRY_INVALID');
  return createInventoryLot({...input,serialNumbers,expiresAt:input.expiresAt||null,warehouseId:stock.warehouseId,variantId:stock.variantId,
    stockItemId:stock._id,storeId:request.store._id,actorUserId:request.user._id,authorize:session=>lockInventoryAccess(request,session),audit:auditFor(request,'inventory.lot_created','inventory_lot')});
}

export async function changeSellerInventoryLotStatus(request, lotPublicId, body) {
  const input = z.object({status:z.enum(['active','quarantined','expired','depleted']),reason:reasonSchema,expectedVersion:versionSchema,expectedLotVersion:versionSchema}).parse(body);
  const lot = await InventoryLot.findOne({publicId:lotPublicId,storeId:request.store._id});
  if (!lot) throw new AppError('Inventory lot not found.',404,'LOT_NOT_FOUND');
  await ownedStock(request,(await StockItem.findById(lot.stockItemId).select('publicId').lean())?.publicId || 'missing');
  return setInventoryLotStatus({...input,lotPublicId,storeId:request.store._id,actorUserId:request.user._id,
    authorize:session=>lockInventoryAccess(request,session),audit:auditFor(request,'inventory.lot_status_changed','inventory_lot',{status:input.status,reason:input.reason})});
}
