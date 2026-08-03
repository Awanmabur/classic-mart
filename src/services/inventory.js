import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import {
  InventoryLot,
  InventoryMovement,
  InventoryReservation,
  StockItem,
} from '../models/index.js';
import { addOutboxEvent } from './outbox.js';
import { clearStorefrontCache } from './storefront.js';

export function assertStockState(onHand, reserved, damaged = 0, quarantined = 0) {
  if (![onHand,reserved,damaged,quarantined].every(Number.isSafeInteger)) {
    throw new AppError('Stock quantities must be whole numbers.', 422, 'STOCK_INVALID');
  }
  if (onHand < 0 || reserved < 0 || damaged < 0 || quarantined < 0 || reserved + damaged + quarantined > onHand) {
    throw new AppError(
      'This change would make available stock negative.',
      409,
      'INSUFFICIENT_STOCK',
    );
  }
  return { onHand, reserved, damaged, quarantined, available: onHand - reserved - damaged - quarantined };
}

async function withTransaction(operation) {
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(() => operation(session));
    clearStorefrontCache();
    return result;
  } finally {
    await session.endSession();
  }
}

export async function adjustStock({
  stockItemId,
  storeId,
  quantity,
  reason,
  actorUserId,
  reorderPoint,
  expectedVersion = null,
}) {
  if (!Number.isSafeInteger(quantity) || quantity === 0) {
    throw new AppError(
      'Stock adjustment must be a non-zero whole number.',
      422,
      'STOCK_INVALID',
    );
  }
  return withTransaction(async (session) => {
    const item = await StockItem.findOne({ _id: stockItemId, storeId }).session(
      session,
    );
    if (!item) throw new AppError('Stock item not found.', 404, 'STOCK_NOT_FOUND');
    if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== Number(item.__v)) {
      throw new AppError('Inventory version changed. Refresh the stock item and retry.', 409, 'INVENTORY_VERSION_CONFLICT');
    }
    const before = {
      onHand: item.onHand,
      reserved: item.reserved,
    };
    assertStockState(item.onHand + quantity, item.reserved, item.damaged, item.quarantined);
    item.onHand += quantity;
    item.reorderPoint = reorderPoint;
    await item.save({ session });
    const movement = await InventoryMovement.create(
      [
        {
          publicId: publicId('mov'),
          storeId,
          stockItemId: item._id,
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          type: quantity > 0 ? 'receipt' : 'adjustment',
          quantity,
          onHandBefore: before.onHand,
          onHandAfter: item.onHand,
          reservedBefore: before.reserved,
          reservedAfter: item.reserved,
          reason,
          actorUserId,
        },
      ],
      { session },
    );
    await addOutboxEvent(
      {
        type: 'inventory.stock_adjusted',
        aggregateType: 'stock_item',
        aggregatePublicId: item.publicId,
        payload: {
          movementPublicId: movement[0].publicId,
          quantity,
          available: item.onHand - item.reserved - item.damaged - item.quarantined,
        },
      },
      session,
    );
    return item;
  });
}

export async function setStockCondition({stockItemId,storeId,damaged,quarantined,binCode,reason,actorUserId}) {
  if (![damaged,quarantined].every(Number.isSafeInteger) || damaged < 0 || quarantined < 0) throw new AppError('Damaged and quarantined quantities must be whole non-negative numbers.',422,'STOCK_INVALID');
  return withTransaction(async(session)=>{
    const item=await StockItem.findOne({_id:stockItemId,storeId}).session(session);if(!item)throw new AppError('Stock item not found.',404,'STOCK_NOT_FOUND');
    const lotUnavailable=(await InventoryLot.aggregate([{$match:{stockItemId:item._id,status:{$in:['quarantined','expired']}}},{$group:{_id:null,total:{$sum:'$quantity'}}}]).session(session))[0]?.total||0;
    if(quarantined<lotUnavailable)throw new AppError(`Quarantined stock cannot be below ${lotUnavailable} units held by quarantined/expired lots.`,409,'LOT_QUARANTINE_CONFLICT');
    assertStockState(item.onHand,item.reserved,damaged,quarantined);
    const before={damaged:item.damaged,quarantined:item.quarantined,binCode:item.binCode};item.damaged=damaged;item.quarantined=quarantined;if(binCode!==undefined)item.binCode=String(binCode).trim().slice(0,80);await item.save({session});
    await InventoryMovement.create([{publicId:publicId('mov'),storeId:item.storeId,stockItemId:item._id,variantId:item.variantId,warehouseId:item.warehouseId,type:'condition',quantity:0,onHandBefore:item.onHand,onHandAfter:item.onHand,reservedBefore:item.reserved,reservedAfter:item.reserved,damagedBefore:before.damaged,damagedAfter:item.damaged,quarantinedBefore:before.quarantined,quarantinedAfter:item.quarantined,binBefore:before.binCode,binAfter:item.binCode,reason,actorUserId}],{session});
    await addOutboxEvent({type:'inventory.condition_changed',aggregateType:'stock_item',aggregatePublicId:item.publicId,payload:{available:item.onHand-item.reserved-item.damaged-item.quarantined,damaged:item.damaged,quarantined:item.quarantined,binCode:item.binCode}},session);return item;
  });
}

export async function createInventoryLot({storeId,warehouseId,stockItemId,variantId,batchNumber='',serialNumbers=[],quantity,expiresAt=null,notes='',actorUserId}){
  if(!Number.isSafeInteger(quantity)||quantity<=0)throw new AppError('Lot quantity must be a positive whole number.',422,'LOT_INVALID');
  const cleanSerials=serialNumbers.map(v=>String(v).trim()).filter(Boolean);if(cleanSerials.length&&cleanSerials.length!==quantity)throw new AppError('Serialized lots require exactly one serial number per unit.',422,'LOT_SERIAL_COUNT');
  if(new Set(cleanSerials).size!==cleanSerials.length)throw new AppError('Serial numbers must be unique.',422,'LOT_SERIAL_DUPLICATE');
  if(!batchNumber&&!cleanSerials.length&&!expiresAt)throw new AppError('Add a batch number, serial numbers or expiry date.',422,'LOT_TRACE_REQUIRED');
  const session=await mongoose.startSession();let lot;try{await session.withTransaction(async()=>{
    const stock=await StockItem.findOne({_id:stockItemId,storeId,warehouseId,variantId}).session(session);if(!stock)throw new AppError('Stock item not found.',404,'STOCK_NOT_FOUND');
    const assigned=(await InventoryLot.aggregate([{$match:{stockItemId:stock._id,status:{$ne:'depleted'}}},{$group:{_id:null,total:{$sum:'$quantity'}}}]).session(session))[0]?.total||0;if(assigned+quantity>stock.onHand)throw new AppError('Lot quantities cannot exceed physical on-hand stock.',409,'LOT_QUANTITY_EXCEEDS_STOCK');
    if(expiresAt&&new Date(expiresAt)<=new Date())throw new AppError('New inventory lots must have a future expiry date.',422,'LOT_EXPIRY_INVALID');
    const docs=await InventoryLot.create([{publicId:publicId('lot'),storeId,warehouseId,stockItemId:stock._id,variantId,batchNumber:String(batchNumber).trim().slice(0,120),serialNumbers:cleanSerials,quantity,expiresAt:expiresAt?new Date(expiresAt):null,notes:String(notes).trim().slice(0,500)}],{session});lot=docs[0];
    await addOutboxEvent({type:'inventory.lot_created',aggregateType:'inventory_lot',aggregatePublicId:lot.publicId,payload:{stockItemPublicId:stock.publicId,quantity,expiresAt:lot.expiresAt}},session);
  });}finally{await session.endSession();}return lot;
}
export async function setInventoryLotStatus({lotPublicId,storeId,status,actorUserId,reason=''}){
  if(!['active','quarantined','expired','depleted'].includes(status))throw new AppError('Lot status is invalid.',422,'LOT_STATUS_INVALID');
  const session=await mongoose.startSession();let lot;try{await session.withTransaction(async()=>{
    lot=await InventoryLot.findOne({publicId:lotPublicId,storeId}).session(session);if(!lot)throw new AppError('Inventory lot not found.',404,'LOT_NOT_FOUND');if(lot.status===status)return;
    const stock=await StockItem.findById(lot.stockItemId).session(session);if(!stock)throw new AppError('Stock item not found.',404,'STOCK_NOT_FOUND');const wasUnavailable=['quarantined','expired'].includes(lot.status),willUnavailable=['quarantined','expired'].includes(status);let nextQuarantined=stock.quarantined;if(!wasUnavailable&&willUnavailable)nextQuarantined+=lot.quantity;if(wasUnavailable&&!willUnavailable)nextQuarantined-=lot.quantity;if(nextQuarantined<0)throw new AppError('Lot quarantine state is inconsistent.',409,'LOT_QUARANTINE_CONFLICT');assertStockState(stock.onHand,stock.reserved,stock.damaged,nextQuarantined);
    const before=stock.quarantined;stock.quarantined=nextQuarantined;await stock.save({session});lot.status=status;await lot.save({session});
    if(before!==nextQuarantined)await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'condition',quantity:0,onHandBefore:stock.onHand,onHandAfter:stock.onHand,reservedBefore:stock.reserved,reservedAfter:stock.reserved,damagedBefore:stock.damaged,damagedAfter:stock.damaged,quarantinedBefore:before,quarantinedAfter:nextQuarantined,reason:reason||`Lot ${lot.publicId} changed to ${status}`,reference:lot.publicId,actorUserId}],{session});
    await addOutboxEvent({type:'inventory.lot_status_changed',aggregateType:'inventory_lot',aggregatePublicId:lot.publicId,payload:{status,stockItemPublicId:stock.publicId}},session);
  });}finally{await session.endSession();}return lot;
}

export async function reserveStock({
  stockItemId,
  storeId,
  quantity,
  idempotencyKey,
  actorUserId,
  expiresAt,
}) {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > 100_000
  ) {
    throw new AppError(
      'Reservation quantity must be a positive whole number.',
      422,
      'RESERVATION_INVALID',
    );
  }
  if (
    !idempotencyKey ||
    String(idempotencyKey).length > 120 ||
    !expiresAt ||
    new Date(expiresAt).getTime() <= Date.now()
  ) {
    throw new AppError(
      'Reservation idempotency key or expiry is invalid.',
      422,
      'RESERVATION_INVALID',
    );
  }
  const existing = await InventoryReservation.findOne({
    idempotencyKey,
    storeId,
  });
  if (existing) return existing;
  return withTransaction(async (session) => {
    const item = await StockItem.findOneAndUpdate(
      {
        _id: stockItemId,
        storeId,
        $expr: {
          $gte: [{ $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }, quantity],
        },
      },
      { $inc: { reserved: quantity } },
      { returnDocument: 'after', session, runValidators: true },
    );
    if (!item) {
      throw new AppError(
        'There is not enough available stock.',
        409,
        'INSUFFICIENT_STOCK',
      );
    }
    const [reservation] = await InventoryReservation.create(
      [
        {
          publicId: publicId('rsv'),
          idempotencyKey,
          storeId,
          stockItemId: item._id,
          variantId: item.variantId,
          quantity,
          expiresAt,
          actorUserId,
        },
      ],
      { session },
    );
    await InventoryMovement.create(
      [
        {
          publicId: publicId('mov'),
          storeId,
          stockItemId: item._id,
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          type: 'reservation',
          quantity,
          onHandBefore: item.onHand,
          onHandAfter: item.onHand,
          reservedBefore: item.reserved - quantity,
          reservedAfter: item.reserved,
          reason: 'Stock reservation',
          reference: reservation.publicId,
          actorUserId,
        },
      ],
      { session },
    );
    return reservation;
  });
}

export async function releaseReservation({
  reservationPublicId,
  actorUserId,
  reason = 'Reservation released',
}) {
  return withTransaction(async (session) => {
    const reservation = await InventoryReservation.findOne({
      publicId: reservationPublicId,
      status: 'active',
    }).session(session);
    if (!reservation) {
      throw new AppError(
        'Active reservation not found.',
        404,
        'RESERVATION_NOT_FOUND',
      );
    }
    const item = await StockItem.findOneAndUpdate(
      { _id: reservation.stockItemId, reserved: { $gte: reservation.quantity } },
      { $inc: { reserved: -reservation.quantity } },
      { returnDocument: 'after', session, runValidators: true },
    );
    if (!item) {
      throw new AppError(
        'Reservation stock state is inconsistent.',
        409,
        'STOCK_CONFLICT',
      );
    }
    reservation.status = 'released';
    reservation.releasedAt = new Date();
    await reservation.save({ session });
    await InventoryMovement.create(
      [
        {
          publicId: publicId('mov'),
          storeId: reservation.storeId,
          stockItemId: item._id,
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          type: 'release',
          quantity: -reservation.quantity,
          onHandBefore: item.onHand,
          onHandAfter: item.onHand,
          reservedBefore: item.reserved + reservation.quantity,
          reservedAfter: item.reserved,
          reason,
          reference: reservation.publicId,
          actorUserId,
        },
      ],
      { session },
    );
    return reservation;
  });
}
