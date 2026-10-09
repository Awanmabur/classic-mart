import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { encodeCursor } from '../src/services/pagination.js';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';

test('warehouse parcel options batch a complete cursor page without warehouse query multiplication', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: `classicmart_warehouse_options_test_${suffix}` });
  const { InventoryDiscrepancy, InventoryReservation, Order, Shipment, StockItem, Store, User, Warehouse, WarehouseTask } = await import('../src/models/index.js');
  const { warehouseParcelOptions } = await import('../src/services/warehouse-parcel-options.js');
  const oid = () => new mongoose.Types.ObjectId();
  let sequence = 0;
  const publicId = prefix => `${prefix}_options_${suffix}_${sequence++}`;
  const store = { _id: oid(), publicId: publicId('sto'), country: 'UG', status: 'verified' };
  const warehouses = Array.from({ length: 20 }, (_, index) => ({ _id: oid(), publicId: publicId('wh'), storeId: store._id,
    country: 'UG', active: true, name: `Source warehouse ${index}`, __v: index }));
  const unrelated = Array.from({ length: 180 }, (_, index) => ({ _id: oid(), publicId: publicId('wh'), storeId: store._id,
    country: 'UG', active: true, name: `Unrelated assigned warehouse ${index}` }));
  const stocks = warehouses.map((warehouse, index) => ({ _id: oid(), publicId: publicId('stk'), storeId: store._id,
    warehouseId: warehouse._id, variantId: oid(), binCode: `SOURCE-BIN-${index}` }));
  const parcels = [], orders = [], shipments = [], reservations = [];
  for (let index = 0; index < 25; index++) {
    const orderId = oid(), shipmentId = oid(), orderPublicId = publicId('ord');
    const lines = stocks.map((stock, lineIndex) => {
      const reservationPublicId = publicId('res');
      reservations.push({ _id: oid(), publicId: reservationPublicId, idempotencyKey: reservationPublicId, storeId: store._id, stockItemId: stock._id,
        variantId: stock.variantId, quantity: 1, status: 'committed' });
      return { storeId: store._id, storePublicId: store.publicId, reservationPublicId, variantId: stock.variantId,
        productPublicId: `prd_${lineIndex}`, variantPublicId: `var_${lineIndex}`, sku: `SKU-${lineIndex}`,
        title: `Item from source ${lineIndex}`, quantity: 1 };
    });
    orders.push({ _id: orderId, publicId: orderPublicId, sessionKey: orderPublicId, idempotencyKey: orderPublicId, country: 'UG', status: 'paid', paymentMethod: 'wallet',
      paymentState: 'paid', fulfillmentState: 'processing', cancellationState: 'none', refundState: 'none', items: lines });
    shipments.push({ _id: shipmentId, publicId: publicId('shp'), orderId, orderPublicId, country: 'UG', kind: 'outbound', status: 'ready' });
    parcels.push({ _id: oid(), publicId: publicId('pcl'), shipmentId, orderPublicId, storePublicId: store.publicId,
      status: 'created', pickedQuantity: 0, items: lines.map(({ productPublicId, variantPublicId, sku, title, quantity }) =>
        ({ productPublicId, variantPublicId, sku, title, quantity })) });
  }
  try {
    // These isolated fixtures represent existing authoritative records; using
    // collection inserts keeps this performance test independent of signup.
    await Promise.all([Store.collection.insertOne(store), Warehouse.collection.insertMany([...warehouses, ...unrelated]),
      StockItem.collection.insertMany(stocks), Order.collection.insertMany(orders), Shipment.collection.insertMany(shipments),
      InventoryReservation.collection.insertMany(reservations)]);
    const reads = [], execute = mongoose.Query.prototype.exec;
    t.mock.method(mongoose.Query.prototype, 'exec', async function (...args) {
      reads.push(this.model.modelName);
      return execute.apply(this, args);
    });
    const expectedReads = ['InventoryReservation', 'Order', 'Shipment', 'StockItem', 'Store', 'Warehouse', 'WarehouseTask'];
    const optionsFor = async (inputParcels, inputWarehouses = [...warehouses, ...unrelated]) => {
      reads.length = 0;
      const options = await warehouseParcelOptions({ parcels: inputParcels, warehouses: inputWarehouses });
      assert.deepEqual([...reads].sort(), expectedReads, 'a full page and a one-parcel page each read the seven collections once');
      return options;
    };

    await t.test('25 parcels and 20 real source groups use seven reads and omit unrelated warehouse assignments', async () => {
      const options = await optionsFor(parcels);
      assert.equal(options.size, 25);
      assert.equal([...options.values()].reduce((sum, option) => sum + option.warehouseGroups.length, 0), 500);
      for (const option of options.values()) {
        assert.deepEqual(option.actions, { pick: true, pack: false, dispatch: false });
        for (const group of option.warehouseGroups) {
          assert.equal(group.quantity, 1); assert.equal(group.remaining, 1);
          assert.equal(group.parcelItems.length, 1);
          assert.match(group.parcelItems[0].binCode, /^SOURCE-BIN-/);
          assert.equal(unrelated.some(warehouse => warehouse.publicId === group.warehousePublicId), false);
        }
      }
      const one = await optionsFor([parcels[0]], [warehouses[0]]);
      assert.equal(one.get(parcels[0].publicId).warehouseGroups.length, 1);
      assert.equal(one.get(parcels[0].publicId).warehouseGroups[0].parcelItems[0].binCode, 'SOURCE-BIN-0');
    });

    await t.test('queued tasks suppress duplicate creation and validated pick history controls packing and dispatch', async () => {
      const parcel = parcels[0], order = orders[0], shipment = shipments[0];
      const taskScope = { parcelId: parcel._id, orderId: order._id, shipmentId: shipment._id, storeId: store._id };
      const queued = { _id: oid(), publicId: publicId('wtk'), ...taskScope, warehouseId: warehouses[0]._id,
        type: 'pick', status: 'open' };
      await WarehouseTask.collection.insertOne(queued);
      let option = (await optionsFor([parcel], [warehouses[0]])).get(parcel.publicId);
      assert.equal(option.actions.pick, false);
      assert.equal(option.warehouseGroups[0].existingTaskPublicIds.pick, queued.publicId);
      await WarehouseTask.collection.deleteOne({ _id: queued._id });
      await WarehouseTask.collection.insertMany(warehouses.map(warehouse => ({ _id: oid(), publicId: publicId('wtk'),
        ...taskScope, warehouseId: warehouse._id, type: 'pick', status: 'completed', result: { pickedQuantity: 1 } })));
      parcel.status = 'picked'; parcel.pickedQuantity = 20;
      option = (await optionsFor([parcel], [warehouses[0]])).get(parcel.publicId);
      assert.equal(option.actions.pack, true);
      const packed = { _id: oid(), publicId: publicId('wtk'), ...taskScope, warehouseId: warehouses[0]._id,
        type: 'pack', status: 'completed', completedAt: new Date() };
      await WarehouseTask.collection.insertOne(packed); parcel.status = 'packed';
      option = (await optionsFor([parcel], [warehouses[0]])).get(parcel.publicId);
      assert.equal(option.actions.dispatch, true); assert.equal(option.packWarehousePublicId, warehouses[0].publicId);
      assert.equal((await optionsFor([parcel], [warehouses[1]])).get(parcel.publicId).actions.dispatch, false);
      await WarehouseTask.collection.updateOne({ _id: packed._id }, { $set: { orderId: oid() } });
      assert.equal((await optionsFor([parcel], [warehouses[0]])).size, 0, 'mismatched task lineage never offers a dispatch control');
    });

    await t.test('payment, cancellation and committed-reservation eligibility remain authoritative', async () => {
      const parcel = parcels[1], order = orders[1];
      await Order.collection.updateOne({ _id: order._id }, { $set: { status: 'pending_payment', paymentState: 'pending' } });
      assert.equal((await optionsFor([parcel])).size, 0);
      await Order.collection.updateOne({ _id: order._id }, { $set: { status: 'paid', paymentState: 'paid', cancellationState: 'requested' } });
      assert.equal((await optionsFor([parcel])).size, 0);
      await Order.collection.updateOne({ _id: order._id }, { $set: { cancellationState: 'none' } });
      const reservation = reservations.find(row => row.publicId === order.items[0].reservationPublicId);
      await InventoryReservation.collection.updateOne({ _id: reservation._id }, { $set: { status: 'released' } });
      assert.equal((await optionsFor([parcel])).size, 0);
    });

    await t.test('summary counts cover more than 180 task records and undated tasks are never overdue', async () => {
      const operator = { _id: oid(), publicId: publicId('usr'), name: 'Scoped warehouse counter', role: 'warehouse',
        emailNormalized: `stock-counter-${suffix}@example.test`, phoneNormalized: '+256700000101',
        status: 'active', country: 'UG', security: { tokenVersion: 0, mfaEnabled: true } };
      await User.collection.insertOne(operator);
      const now = Date.now();
      const history = Array.from({ length: 185 }, (_, index) => ({ _id: oid(), publicId: publicId('wtk'),
        warehouseId: warehouses[0]._id, storeId: store._id, type: 'receive',
        status: index < 40 || index >= 160 ? 'open' : index < 80 ? 'in_progress' : index < 120 ? 'completed' : 'cancelled',
        ...(index < 40 ? { dueAt: new Date(now - 3600_000) } : index < 80 ? { dueAt: new Date(now + 3600_000), assignedUserId: operator._id } : {}),
        ...(index >= 80 && index < 120 ? { completedAt: new Date(now - 3600_000) } : {}), createdAt: new Date(now - index * 1000) }));
      await WarehouseTask.collection.insertMany(history);
      const { loadWarehousePage } = await import('../src/services/warehouse-dashboard.js');
      const flow = await loadWarehousePage({ user: operator, query: { warehousePublicId: warehouses[0].publicId } }, 'reports');
      assert.equal(flow.summary.totalOpen, 105);
      assert.equal(flow.summary.mineOpen, 40);
      assert.equal(flow.summary.overdueOpen, 40);
      assert.equal(flow.summary.completed30d, 41);
      assert.equal(flow.reports.taskCounts.receive, 185);
      assert.equal(flow.reports.taskCounts.pick, 1);
      assert.equal(flow.reports.taskCounts.pack, 1);
    });

    await t.test('pending count reviews remain reachable across pages despite newer closed history and other-country work', async () => {
      const supervisor = { _id: oid(), publicId: publicId('usr'), name: 'Uganda count reviewer', role: 'country_admin',
        emailNormalized: `count-reviewer-${suffix}@example.test`, phoneNormalized: '+256700000102',
        status: 'active', country: 'UG', security: { tokenVersion: 0, mfaEnabled: true } };
      const counter = { _id: oid(), publicId: publicId('usr'), name: 'Independent stock counter', role: 'warehouse',
        emailNormalized: `independent-counter-${suffix}@example.test`, phoneNormalized: '+256700000103',
        status: 'active', country: 'UG', security: { tokenVersion: 0, mfaEnabled: true } };
      const foreignWarehouse = { _id: oid(), publicId: publicId('wh'), storeId: oid(), country: 'KE', active: true,
        name: 'Private Kenya count warehouse' };
      await Promise.all([User.collection.insertMany([supervisor, counter]), Warehouse.collection.insertOne(foreignWarehouse)]);
      const now = Date.now();
      const count = (status, warehouse, index, newer = false) => {
        const id = publicId('dsc');
        return { _id: oid(), publicId: id, sourceKey: id, stockItemId: stocks[0]._id, variantId: stocks[0].variantId,
          warehouseId: warehouse._id, storeId: warehouse.storeId, country: warehouse.country,
          expectedOnHand: 10, countedOnHand: 9, variance: -1, reservedSnapshot: 0, damagedSnapshot: 0,
          quarantinedSnapshot: 0, stockVersionSnapshot: 0, reason: 'Independent physical count', status,
          countedByUserId: counter._id, countedAt: new Date(now - index * 1000),
          createdAt: new Date(now - (newer ? index * 1000 : 86400_000 + index * 1000)), __v: 0 };
      };
      const pending = Array.from({ length: 35 }, (_, index) => count('pending_review', warehouses[0], index));
      const closed = Array.from({ length: 60 }, (_, index) => count(index % 2 ? 'approved' : 'rejected', warehouses[0], index, true));
      const foreign = Array.from({ length: 32 }, (_, index) => count('pending_review', foreignWarehouse, index, true));
      await InventoryDiscrepancy.collection.insertMany([...pending, ...closed, ...foreign]);
      const { loadWarehousePage } = await import('../src/services/warehouse-dashboard.js');
      const requestFor = query => ({ user: supervisor, query });
      const first = await loadWarehousePage(requestFor({}), 'inventory');
      assert.equal(first.discrepancies.length, 25);
      assert.equal(first.discrepancies.every(row => row.status === 'pending_review' && row.canReview), true);
      assert.equal(first.summary.pendingDiscrepancies, 35);
      assert.equal(first.reviewPage.total, 35); assert.equal(first.reviewPage.count, 25);
      assert.equal(first.reviewPage.hasMore, true); assert.ok(first.reviewPage.next);
      assert.equal(first.reviewPage.mode, 'pending');
      assert.deepEqual(first.discrepancies.map(row => row.publicId), pending.toReversed().slice(0, 25).map(row => row.publicId),
        'the oldest observations are offered first');
      const inventoryAfter = encodeCursor({ _id: stocks[0]._id, updatedAt: new Date() }, { field: 'updatedAt' });
      const second = await loadWarehousePage(requestFor({ after: inventoryAfter, reviewAfter: first.reviewPage.next }), 'inventory');
      const remaining = second.discrepancies.filter(row => row.status === 'pending_review');
      assert.equal(remaining.length, 10);
      assert.equal(second.reviewPage.total, 35); assert.equal(second.reviewPage.hasMore, false);
      assert.equal(second.filters.after, inventoryAfter, 'inventory and count-review cursors remain independent');
      assert.equal(remaining.some(row => first.discrepancies.some(other => row.publicId === other.publicId)), false);
      assert.deepEqual([...first.discrepancies, ...remaining].map(row => row.publicId).sort(), pending.map(row => row.publicId).sort());
      const visibleIds = [...first.discrepancies, ...second.discrepancies].map(row => row.publicId);
      assert.equal(foreign.some(row => visibleIds.includes(row.publicId)), false);
      assert.equal([...first.warehouses, ...second.warehouses].some(row => row.publicId === foreignWarehouse.publicId), false);
      await assert.rejects(loadWarehousePage(requestFor({ warehousePublicId: foreignWarehouse.publicId }), 'inventory'),
        { code: 'WAREHOUSE_NOT_FOUND' });
      await assert.rejects(loadWarehousePage(requestFor({ reviewAfter: 'invalid-review-cursor' }), 'inventory'),
        { code: 'WAREHOUSE_FILTER_INVALID' });
      await InventoryDiscrepancy.collection.updateMany({ publicId: { $in: pending.map(row => row.publicId) } },
        { $set: { status: 'rejected' } });
      const history = await loadWarehousePage(requestFor({}), 'inventory');
      assert.equal(history.reviewPage.mode, 'history'); assert.equal(history.reviewPage.total, 95);
      assert.equal(history.reviewPage.hasMore, true); assert.ok(history.reviewPage.next);
      assert.deepEqual(history.discrepancies.map(row => row.publicId), closed.slice(0, 25).map(row => row.publicId),
        'once pending work is cleared, newest reviewed history becomes available');
      const olderHistory = await loadWarehousePage(requestFor({ reviewAfter: history.reviewPage.next }), 'inventory');
      assert.equal(olderHistory.discrepancies.length, 25);
      assert.equal(olderHistory.discrepancies.some(row => history.discrepancies.some(other => row.publicId === other.publicId)), false);
    });

    await t.test('empty and excessive candidate pages never start collection reads', async () => {
      reads.length = 0;
      assert.equal((await warehouseParcelOptions({ parcels: [], warehouses })).size, 0);
      await assert.rejects(warehouseParcelOptions({ parcels: [...parcels, parcels[0], parcels[0]], warehouses }),
        { code: 'WAREHOUSE_OPTIONS_PAGE_INVALID' });
      assert.equal(reads.length, 0);
    });
  } finally {
    t.mock.restoreAll();
    try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});
