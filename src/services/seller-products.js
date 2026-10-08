import mongoose from 'mongoose';
import { z } from 'zod';
import { Product, ProductVariant, ProductMedia, Store, StoreMember, Category, Brand, Warehouse, StockItem, InventoryLot, InventoryMovement, Notification, User } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { publicId, slugify } from '../core/ids.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { storeCapabilities } from './store.js';
import { assertOperationalCountry } from './authorization.js';
import { writeAudit } from './audit.js';
import { addOutboxEvent } from './outbox.js';
import { prepareProductImage } from './media.js';
import { deleteMediaObject } from './object-storage.js';
import { clearStorefrontCache, hasPublicProductApproval } from './storefront.js';
import { calculateQualityScore, inspectProductContent } from './catalogue.js';
import { assertStockState } from './inventory.js';
import { productSchema, variantSchema, mediaMetadataSchema, stockAdjustmentSchema, warehouseSchema } from '../validation/catalogue.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';

export const SELLER_PRODUCT_LIMITS = Object.freeze({ variants: 50, media: 10, minimumMedia: 3, quality: 45, warehouses: 200 });
const revision = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const editable = new Set(['draft', 'changes_requested', 'rejected']);
const stockStates = new Set(['draft', 'changes_requested', 'rejected', 'submitted', 'approved', 'published']);
const statuses = z.enum(['draft', 'submitted', 'changes_requested', 'approved', 'published', 'rejected', 'suspended', 'archived']);
// Seeded catalogue records use stable names; newly created records use UUIDs.
const id = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/, 'Choose a valid record.');
const key = value => String(value);
const can = (capabilities, name) => capabilities.has('*') || capabilities.has(name);

async function sellerAccess(request, session = null, { fulfilment = false } = {}) {
  const member = await StoreMember.findOne({ storeId: request.store._id, userId: request.user._id, status: 'active' }).session(session);
  const capabilities = storeCapabilities(member?.role);
  if (!can(capabilities, 'catalogue') || (fulfilment && !can(capabilities, 'fulfilment'))) throw new AppError('Your store role cannot perform this action.', 403, 'STORE_PERMISSION_DENIED');
  const user = await User.exists({ _id: request.user._id, status: 'active', 'security.tokenVersion': request.user.security?.tokenVersion ?? -1 }).session(session);
  if (!user) throw new AppError('Your account is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  const store = await Store.findById(request.store._id).session(session);
  if (!store || !['pending_verification', 'verified'].includes(store.status)) throw new AppError('This store is locked.', 409, 'STORE_LOCKED');
  return { store, capabilities };
}

function assertRevision(product, expected) {
  if (product.__v !== expected) throw new AppError('The product changed. Reload it before continuing.', 409, 'PRODUCT_VERSION_CONFLICT');
}

async function ownedProduct(request, session = null, { version = null, states = null, fulfilment = false, publicProductId = request.params?.publicId } = {}) {
  const access = await sellerAccess(request, session, { fulfilment });
  const product = await Product.findOne({ storeId: access.store._id, publicId: id.parse(publicProductId) }).session(session);
  if (!product) throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
  if (version !== null) assertRevision(product, version);
  if (states && !states.has(product.status)) throw new AppError('The product is locked. Return it to draft before changing its catalogue details.', 409, 'PRODUCT_LOCKED');
  return { ...access, product };
}

async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    clearStorefrontCache();
    return result;
  } catch (error) {
    if (error.code === 11000) throw new AppError('This store already uses that SKU, barcode or warehouse name. Choose a unique value.', 409, 'CATALOGUE_DUPLICATE');
    throw error;
  } finally { await session.endSession(); }
}

async function saveProduct(request, product, store, session, action, metadata = {}) {
  // Child-only changes can leave every product value unchanged. Mongoose skips
  // a clean save even after increment(); force a scalar write so optimistic
  // concurrency always compares and increments the aggregate revision.
  product.markModified('status');
  product.increment();
  await product.save({ session });
  await writeAudit(request, action, { session, targetType: 'product', targetPublicId: product.publicId, country: store.country, metadata });
  return product;
}

function categoryCountryScope(store) {
  return { active: true, $or: [{ countries: mongoose.trusted({ $size: 0 }) }, { countries: store.country }] };
}

async function references(input, store, session) {
  const category = await Category.findOne({ publicId: input.categoryPublicId, ...categoryCountryScope(store) }).session(session);
  if (!category) throw new AppError('Category is unavailable in your store country.', 422, 'CATEGORY_UNAVAILABLE');
  const brand = input.brandPublicId ? await Brand.findOne({ publicId: input.brandPublicId, status: 'approved' }).session(session) : null;
  if (input.brandPublicId && !brand) throw new AppError('Brand is unavailable.', 422, 'BRAND_UNAVAILABLE');
  return { category, brand };
}

function attributesFor(category, body, { required = false } = {}) {
  const fields = category.attributes || [];
  const declared = new Map(fields.map(field => [field.key, field]));
  const values = body.attributes === undefined ? {} : z.record(z.string(), z.string().trim().max(500)).parse(body.attributes);
  const supplied = Object.assign(Object.create(null), values);
  for (const [name, value] of Object.entries(body)) if (name.startsWith('attribute.')) supplied[name.slice(10)] = z.string().trim().max(500).parse(value);
  for (const [name, value] of Object.entries(body)) {
    const bracket = /^attribute\[([^\]]+)\]$/.exec(name);
    if (bracket) supplied[bracket[1]] = z.string().trim().max(500).parse(value);
  }
  for (const name of Object.keys(supplied)) if (!declared.has(name) || /^(?:__proto__|prototype|constructor)$/.test(name) || /[.$]/.test(name)) throw new AppError('An attribute is not defined by this category.', 422, 'ATTRIBUTE_UNKNOWN');
  const result = new Map();
  for (const field of fields) {
    const value = supplied[field.key] || '';
    if (!value) {
      if (required && field.required) throw new AppError(`Add ${field.label} before submitting.`, 422, 'ATTRIBUTE_REQUIRED');
      continue;
    }
    if (field.type === 'number' && (!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(Number(value)))) throw new AppError(`${field.label} must be a number.`, 422, 'ATTRIBUTE_INVALID');
    if (field.type === 'boolean' && !['true', 'false'].includes(value)) throw new AppError(`${field.label} must be true or false.`, 422, 'ATTRIBUTE_INVALID');
    if (field.type === 'select' && !field.options.includes(value)) throw new AppError(`Choose a valid ${field.label}.`, 422, 'ATTRIBUTE_INVALID');
    inspectProductContent({ title: value, description: '', tags: [] });
    result.set(field.key, value);
  }
  return result;
}

function productInput(body, store) {
  const rawTags = z.string().trim().max(500).optional().default('').parse(body.tags);
  if (new Set(rawTags.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean)).size > 20) throw new AppError('A product can have at most 20 tags.', 422, 'TAG_LIMIT');
  const input = productSchema.parse({ ...body, countries: store.country });
  if (input.tags.some(tag => tag.length > 40)) throw new AppError('Each tag can have at most 40 characters.', 422, 'TAG_INVALID');
  inspectProductContent(input);
  return input;
}

function priceMinor(value, currency, { positive = false } = {}) {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) throw new AppError(`${currency} prices support ${digits} decimal places.`, 422, 'PRICE_INVALID');
  const minor = BigInt(whole) * (10n ** BigInt(digits)) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (minor > 2_000_000_000n || (positive && minor <= 0n)) throw new AppError('Enter a positive price within the supported currency limit.', 422, 'PRICE_INVALID');
  return Number(minor);
}

function variantInput(body, store, { first = false } = {}) {
  const input = variantSchema.parse({ ...body, title: body.variantTitle || (first ? 'Default' : body.title) });
  if (Boolean(input.optionName) !== Boolean(input.optionValue)) throw new AppError('Add both the option name and value, or leave both blank.', 422, 'VARIANT_OPTION_INVALID');
  if (input.optionName && (/^(?:__proto__|prototype|constructor)$/.test(input.optionName) || /[.$]/.test(input.optionName))) throw new AppError('Use a safe variant option name.', 422, 'VARIANT_OPTION_INVALID');
  inspectProductContent({ title: input.title, description: input.optionValue, tags: [] });
  const price = priceMinor(input.price, store.currency, { positive: true });
  const compare = input.compareAt ? priceMinor(input.compareAt, store.currency) : undefined;
  if (compare !== undefined && compare < price) throw new AppError('Compare-at price cannot be lower than the selling price.', 422, 'PRICE_INVALID');
  return { sku: input.sku, barcode: input.barcode, title: input.title,
    options: input.optionName ? new Map([[input.optionName, input.optionValue]]) : new Map(),
    priceMinor: price, compareAtMinor: compare, currency: store.currency,
    active: first ? true : input.active === 'yes', weightGrams: input.weightGrams };
}

async function assertVariantUnique(input, store, session, exclude = null) {
  const duplicate = await ProductVariant.exists({ storeId: store._id, ...(exclude ? { _id: { $ne: exclude } } : {}),
    $or: [{ sku: input.sku }, ...(input.barcode ? [{ barcode: input.barcode }] : [])] }).session(session);
  if (duplicate) throw new AppError('This store already uses that SKU or barcode.', 409, 'SKU_IN_USE');
}

async function quality(product, session) {
  const variantCount = await ProductVariant.countDocuments({ productId: product._id, storeId: product.storeId, active: true }).session(session);
  const mediaCount = await ProductMedia.countDocuments({ productId: product._id, storeId: product.storeId, status: { $in: ['ready', 'approved'] } }).session(session);
  product.qualityScore = calculateQualityScore({ ...product.toObject(), hasBrand: Boolean(product.brandId), variantCount, mediaCount });
}

export async function sellerProductOptions(request) {
  const { store, capabilities } = await sellerAccess(request);
  const [categories, brands, warehouses] = await Promise.all([
    Category.find(categoryCountryScope(store)).select('publicId name restricted attributes').sort({ name: 1, _id: 1 }).limit(200).lean(),
    Brand.find({ status: 'approved' }).select('publicId name').sort({ name: 1, _id: 1 }).limit(200).lean(),
    Warehouse.find({ storeId: store._id, country: store.country, active: true }).select('publicId name country city address active').sort({ name: 1, _id: 1 }).limit(SELLER_PRODUCT_LIMITS.warehouses).lean(),
  ]);
  return { store: store.toObject(), categories, brands, warehouses, currency: store.currency, country: store.country,
    capabilities: { catalogue: can(capabilities, 'catalogue'), fulfilment: can(capabilities, 'fulfilment') } };
}

export async function sellerProductList(request, { after = '', status = '', q = '' } = {}) {
  const { store } = await sellerAccess(request);
  const chosenStatus = status ? statuses.parse(status) : '';
  const search = z.string().trim().max(100).parse(q);
  const base = { storeId: store._id, ...(chosenStatus ? { status: chosenStatus } : {}),
    ...(search ? { title: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}) };
  const [rows, summaryRows] = await Promise.all([
    Product.find(cursorScope(base, after, { field: 'updatedAt' })).select('publicId title slug status qualityScore categoryId updatedAt __v').sort(cursorSort('updatedAt')).limit(51).lean(),
    Product.aggregate([{ $match: { storeId: store._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const result = pageResult(rows, { field: 'updatedAt', limit: 50 });
  const ids = result.items.map(row => row._id);
  const [variants, media, categories] = ids.length ? await Promise.all([
    ProductVariant.aggregate([{ $match: { storeId: store._id, productId: { $in: ids }, active: true } }, { $group: { _id: '$productId', variantCount: { $sum: 1 }, priceMinor: { $min: '$priceMinor' }, variantIds: { $push: '$_id' } } }]),
    ProductMedia.aggregate([{ $match: { storeId: store._id, productId: { $in: ids }, status: { $in: ['ready', 'approved'] } } }, { $group: { _id: '$productId', mediaCount: { $sum: 1 } } }]),
    Category.find({ _id: { $in: result.items.map(row => row.categoryId) } }).select('name').lean(),
  ]) : [[], [], []];
  const variantIds = variants.flatMap(row => row.variantIds);
  const stock = variantIds.length ? await StockItem.aggregate([
    { $match: { storeId: store._id, variantId: { $in: variantIds } } },
    { $lookup: { from: Warehouse.collection.name, localField: 'warehouseId', foreignField: '_id', as: 'warehouse' } },
    { $unwind: '$warehouse' }, { $match: { 'warehouse.active': true, 'warehouse.country': store.country, 'warehouse.storeId': store._id } },
    { $group: { _id: '$variantId', available: { $sum: { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] } } } },
  ]) : [];
  const stockByVariant = new Map(stock.map(row => [key(row._id), row.available]));
  const variantByProduct = new Map(variants.map(row => [key(row._id), row]));
  const mediaByProduct = new Map(media.map(row => [key(row._id), row.mediaCount]));
  const categoryById = new Map(categories.map(row => [key(row._id), row.name]));
  result.items = result.items.map(row => { const variant = variantByProduct.get(key(row._id)); return { ...row,
    categoryName: categoryById.get(key(row.categoryId)) || 'Unavailable category', currency: store.currency,
    priceMinor: variant?.priceMinor ?? null, variantCount: variant?.variantCount || 0, mediaCount: mediaByProduct.get(key(row._id)) || 0,
    availableStock: (variant?.variantIds || []).reduce((total, variantId) => total + (stockByVariant.get(key(variantId)) || 0), 0) }; });
  return { ...result, summary: Object.fromEntries(summaryRows.map(row => [row._id, row.count])) };
}

export async function sellerProductDetail(request, publicProductId = request.params.publicId) {
  const { product, store } = await ownedProduct(request, null, { publicProductId });
  const [variants, media, category, brand, options] = await Promise.all([
    ProductVariant.find({ productId: product._id, storeId: store._id }).sort({ createdAt: 1, _id: 1 }).limit(SELLER_PRODUCT_LIMITS.variants + 1).lean(),
    ProductMedia.find({ productId: product._id, storeId: store._id }).sort({ position: 1, createdAt: 1, _id: 1 }).limit(SELLER_PRODUCT_LIMITS.media + 1).lean(),
    Category.findById(product.categoryId).select('publicId name restricted active countries attributes').lean(),
    product.brandId ? Brand.findById(product.brandId).select('publicId name status').lean() : null,
    sellerProductOptions(request),
  ]);
  if (variants.length > SELLER_PRODUCT_LIMITS.variants || media.length > SELLER_PRODUCT_LIMITS.media) throw new AppError('This legacy product exceeds supported editor limits. Contact support to reconcile its variants or images.', 409, 'PRODUCT_LIMIT_CONFLICT');
  if (brand?.status === 'approved' && !options.brands.some(row => row.publicId === brand.publicId)) options.brands = [...options.brands, { _id: brand._id, publicId: brand.publicId, name: brand.name }];
  const stockRows = variants.length ? await StockItem.find(cursorScope({ storeId: store._id, variantId: { $in: variants.map(row => row._id) } }, request.query?.stockAfter || '', { field: 'updatedAt' })).sort(cursorSort('updatedAt')).limit(201).lean() : [];
  const stockResult = pageResult(stockRows, { field: 'updatedAt', limit: 200 });
  const stock = stockResult.items;
  const warehouses = await Warehouse.find({ storeId: store._id, _id: { $in: stock.map(row => row.warehouseId) } }).select('publicId name country active').limit(SELLER_PRODUCT_LIMITS.warehouses).lean();
  const warehouseById = new Map(warehouses.map(row => [key(row._id), row]));
  const variantById = new Map(variants.map(row => [key(row._id), row]));
  return { product: product.toObject(), variants, media, category, brand, options, stockPage: stockResult.page,
    stock: stock.map(row => ({ ...row, variantPublicId: variantById.get(key(row.variantId))?.publicId,
      warehousePublicId: warehouseById.get(key(row.warehouseId))?.publicId, warehouseName: warehouseById.get(key(row.warehouseId))?.name || 'Unavailable warehouse',
      warehouseActive: Boolean(warehouseById.get(key(row.warehouseId))?.active), available: row.onHand - row.reserved - row.damaged - row.quarantined })) };
}

export async function createSellerProduct(request) {
  return transaction(async session => {
    const { store } = await sellerAccess(request, session);
    const input = productInput(request.body, store);
    const firstVariant = variantInput(request.body, store, { first: true });
    const { category, brand } = await references(input, store, session);
    await assertVariantUnique(firstVariant, store, session);
    const productPublicId = publicId('prd');
    const [product] = await Product.create([{ publicId: productPublicId, storeId: store._id, ownerUserId: store.ownerUserId,
      categoryId: category._id, brandId: brand?._id, title: input.title, slug: `${slugify(input.title).slice(0, 82)}-${productPublicId.slice(-12)}`,
      description: input.description, videoUrl: input.videoUrl, tags: input.tags, countries: [store.country],
      attributes: attributesFor(category, request.body), status: 'draft',
      qualityScore: calculateQualityScore({ ...input, hasBrand: Boolean(brand), variantCount: 1, mediaCount: 0 }) }], { session });
    const [variant] = await ProductVariant.create([{ ...firstVariant, publicId: publicId('var'), storeId: store._id, productId: product._id }], { session });
    await writeAudit(request, 'catalogue.product_created', { session, targetType: 'product', targetPublicId: product.publicId, country: store.country, metadata: { variantPublicId: variant.publicId } });
    return product;
  });
}

export async function updateSellerProduct(request) {
  const version = revision.parse(request.body.version);
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: editable });
    const input = productInput(request.body, store);
    const { category, brand } = await references(input, store, session);
    Object.assign(product, { title: input.title, description: input.description, videoUrl: input.videoUrl, tags: input.tags,
      countries: [store.country], categoryId: category._id, brandId: brand?._id, attributes: attributesFor(category, request.body), status: 'draft' });
    await quality(product, session);
    return saveProduct(request, product, store, session, 'catalogue.product_updated');
  });
}

export async function addSellerProductVariant(request) {
  const version = revision.parse(request.body.version);
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: editable });
    const count = await ProductVariant.countDocuments({ productId: product._id, storeId: store._id }).session(session);
    if (count >= SELLER_PRODUCT_LIMITS.variants) throw new AppError('A product can have at most 50 variants.', 422, 'VARIANT_LIMIT');
    const input = variantInput(request.body, store);
    await assertVariantUnique(input, store, session);
    const [variant] = await ProductVariant.create([{ ...input, publicId: publicId('var'), productId: product._id, storeId: store._id }], { session });
    await quality(product, session); await saveProduct(request, product, store, session, 'catalogue.variant_created', { variantPublicId: variant.publicId });
    return product;
  });
}

export async function updateSellerProductVariant(request) {
  const version = revision.parse(request.body.version);
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: editable });
    const variant = await ProductVariant.findOne({ publicId: id.parse(request.params.variantId || request.params.variantPublicId), productId: product._id, storeId: store._id }).session(session);
    if (!variant) throw new AppError('Variant not found.', 404, 'VARIANT_NOT_FOUND');
    const input = variantInput(request.body, store);
    await assertVariantUnique(input, store, session, variant._id);
    if (input.priceMinor < variant.minimumPriceMinor) throw new AppError('The selling price cannot be below this variant’s minimum price.', 422, 'PRICE_INVALID');
    // This form edits the first option; preserve other dimensions on legacy variants.
    if (request.body.optionName === undefined && request.body.optionValue === undefined) input.options = new Map(variant.options);
    else {
      const remainingOptions = new Map([...variant.options.entries()].slice(1));
      const first = [...input.options.entries()][0];
      if (first && remainingOptions.has(first[0])) throw new AppError('The variant already has another option with that name.', 422, 'VARIANT_OPTION_INVALID');
      input.options = new Map([...(first ? [first] : []), ...remainingOptions]);
    }
    if (!input.active && variant.active) {
      if (await StockItem.exists({ storeId: store._id, variantId: variant._id, reserved: { $gt: 0 } }).session(session)) throw new AppError('Fulfil or release reserved stock before deactivating this variant.', 409, 'VARIANT_RESERVED');
    }
    Object.assign(variant, input); await variant.save({ session });
    await quality(product, session); await saveProduct(request, product, store, session, 'catalogue.variant_updated', { variantPublicId: variant.publicId });
    return product;
  });
}

export async function createSellerProductWarehouse(request) {
  const version = revision.parse(request.body.version);
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: stockStates, fulfilment: true });
    const input = warehouseSchema.parse({ ...request.body, country: store.country });
    const count = await Warehouse.countDocuments({ storeId: store._id }).session(session);
    if (count >= SELLER_PRODUCT_LIMITS.warehouses) throw new AppError('This store has reached the supported warehouse limit.', 422, 'WAREHOUSE_LIMIT');
    const [warehouse] = await Warehouse.create([{ ...input, publicId: publicId('whs'), storeId: store._id, ownerUserId: store.ownerUserId, active: true }], { session });
    // The store revision serializes warehouse creation across different products.
    store.markModified('status'); store.increment(); await store.save({ session });
    await saveProduct(request, product, store, session, 'inventory.warehouse_created', { warehousePublicId: warehouse.publicId });
    return product;
  });
}

export async function adjustSellerProductStock(request) {
  const version = revision.parse(request.body.version), input = stockAdjustmentSchema.parse(request.body);
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: stockStates, fulfilment: true });
    const variant = await ProductVariant.findOne({ publicId: input.variantPublicId, productId: product._id, storeId: store._id, active: true }).session(session);
    const warehouse = await Warehouse.findOne({ publicId: input.warehousePublicId, storeId: store._id, country: store.country, active: true }).session(session);
    if (!variant) throw new AppError('An active variant belonging to this product is required.', 404, 'VARIANT_NOT_FOUND');
    if (!warehouse) throw new AppError('An active warehouse in your store country is required.', 404, 'WAREHOUSE_NOT_FOUND');
    let item = await StockItem.findOne({ storeId: store._id, variantId: variant._id, warehouseId: warehouse._id }).session(session);
    if (!item) [item] = await StockItem.create([{ publicId: publicId('stk'), storeId: store._id, variantId: variant._id, warehouseId: warehouse._id }], { session });
    const onHand = item.onHand + input.quantity;
    assertStockState(onHand, item.reserved, item.damaged, item.quarantined);
    if (onHand > 2_000_000_000) throw new AppError('Stock exceeds the supported inventory limit.', 422, 'STOCK_INVALID');
    const assigned = (await InventoryLot.aggregate([{ $match: { storeId: store._id, stockItemId: item._id, status: { $ne: 'depleted' } } }, { $group: { _id: null, quantity: { $sum: '$quantity' } } }]).session(session))[0]?.quantity || 0;
    if (assigned > onHand) throw new AppError('Reconcile tracked inventory lots before reducing their physical stock.', 409, 'LOT_QUANTITY_EXCEEDS_STOCK');
    const before = item.onHand; item.onHand = onHand;
    if (request.body.reorderPoint !== undefined && String(request.body.reorderPoint).trim() !== '') item.reorderPoint = input.reorderPoint;
    await item.save({ session });
    const [movement] = await InventoryMovement.create([{ publicId: publicId('mov'), storeId: store._id, stockItemId: item._id,
      variantId: variant._id, warehouseId: warehouse._id, type: input.quantity > 0 ? 'receipt' : 'adjustment', quantity: input.quantity,
      onHandBefore: before, onHandAfter: onHand, reservedBefore: item.reserved, reservedAfter: item.reserved,
      damagedBefore: item.damaged, damagedAfter: item.damaged, quarantinedBefore: item.quarantined, quarantinedAfter: item.quarantined,
      reason: input.reason, actorUserId: request.user._id }], { session });
    await saveProduct(request, product, store, session, 'inventory.stock_adjusted', { movementPublicId: movement.publicId, quantity: input.quantity });
    return product;
  });
}

function mediaPublicId(request) { return request.params.mediaId || request.params.mediaPublicId; }

async function currentMedia(product, store, mediaId, session) {
  const media = await ProductMedia.findOne({ publicId: id.parse(mediaId), productId: product._id, storeId: store._id }).select('+storageKey +thumbnailStorageKey').session(session);
  if (!media) throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
  return media;
}

async function compactMedia(product, session) {
  const rows = await ProductMedia.find({ productId: product._id, storeId: product.storeId }).sort({ position: 1, createdAt: 1, _id: 1 }).limit(SELLER_PRODUCT_LIMITS.media).session(session);
  for (const [position, media] of rows.entries()) if (media.position !== position) { media.position = position; await media.save({ session }); }
}

async function deleteUnreferencedMedia(keys) {
  for (const storageKey of new Set(keys.filter(Boolean))) {
    const exists = await ProductMedia.exists({ $or: [{ storageKey }, { thumbnailStorageKey: storageKey }] }).catch(() => true);
    if (!exists) await deleteMediaObject(storageKey).catch(() => {});
  }
}

export async function uploadSellerProductImage(request) {
  const version = revision.parse(request.body.version), input = mediaMetadataSchema.parse(request.body);
  const initial = await ownedProduct(request, null, { version, states: editable });
  inspectProductContent({ title: input.altText, description: '', tags: [] });
  const count = await ProductMedia.countDocuments({ productId: initial.product._id, storeId: initial.store._id });
  if (!mediaPublicId(request) && count >= SELLER_PRODUCT_LIMITS.media) throw new AppError('A product can have at most 10 images.', 422, 'MEDIA_LIMIT');
  if (mediaPublicId(request)) await currentMedia(initial.product, initial.store, mediaPublicId(request), null);
  const prepared = await prepareProductImage(request.file, initial.product.publicId);
  const newId = publicId('med');
  let retiredKeys = [];
  try {
    const result = await transaction(async session => {
      const { product, store } = await ownedProduct(request, session, { version, states: editable });
      const countNow = await ProductMedia.countDocuments({ productId: product._id, storeId: store._id }).session(session);
      let position = request.body.position === undefined ? countNow : input.position;
      retiredKeys = [];
      if (mediaPublicId(request)) {
        const previous = await currentMedia(product, store, mediaPublicId(request), session);
        if (request.body.position === undefined) position = previous.position;
        retiredKeys = [previous.storageKey, previous.thumbnailStorageKey];
        await ProductMedia.deleteOne({ _id: previous._id, productId: product._id, storeId: store._id }, { session });
      } else if (countNow >= SELLER_PRODUCT_LIMITS.media) throw new AppError('A product can have at most 10 images.', 422, 'MEDIA_LIMIT');
      const [created] = await ProductMedia.create([{ ...prepared, publicId: newId, productId: product._id, storeId: store._id, altText: input.altText, position: Math.min(position, 9), status: 'ready' }], { session });
      const others = await ProductMedia.find({ productId: product._id, storeId: store._id, _id: { $ne: created._id } }).sort({ position: 1, createdAt: 1, _id: 1 }).limit(SELLER_PRODUCT_LIMITS.media).session(session);
      others.splice(Math.min(position, others.length), 0, created);
      for (const [index, image] of others.entries()) { image.position = index; await image.save({ session }); }
      await quality(product, session);
      return saveProduct(request, product, store, session, 'catalogue.media_uploaded', { mediaPublicId: newId, replaced: Boolean(mediaPublicId(request)) });
    });
    await deleteUnreferencedMedia(retiredKeys);
    return result;
  } catch (error) {
    // Retain objects if the database cannot confirm whether the transaction committed.
    const persisted = await ProductMedia.exists({ publicId: newId }).catch(() => true);
    if (!persisted) await deleteUnreferencedMedia([prepared.storageKey, prepared.thumbnailStorageKey]);
    throw error;
  }
}

export async function updateSellerProductImage(request) {
  const version = revision.parse(request.body.version), input = mediaMetadataSchema.parse(request.body);
  inspectProductContent({ title: input.altText, description: '', tags: [] });
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: editable });
    const media = await currentMedia(product, store, mediaPublicId(request), session);
    const rows = await ProductMedia.find({ productId: product._id, storeId: store._id }).sort({ position: 1, createdAt: 1, _id: 1 }).limit(SELLER_PRODUCT_LIMITS.media).session(session);
    const others = rows.filter(row => !row._id.equals(media._id));
    others.splice(Math.min(input.position, others.length), 0, media);
    media.altText = input.altText; media.status = 'ready'; media.reviewedAt = undefined; media.reviewedByUserId = undefined; media.moderationReason = '';
    for (const [position, item] of others.entries()) { item.position = position; await item.save({ session }); }
    return saveProduct(request, product, store, session, 'catalogue.media_updated', { mediaPublicId: media.publicId });
  });
}

export async function removeSellerProductImage(request) {
  const version = revision.parse(request.body.version);
  let retiredKeys = [];
  const result = await transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: editable });
    const media = await currentMedia(product, store, mediaPublicId(request), session);
    retiredKeys = [media.storageKey, media.thumbnailStorageKey];
    await ProductMedia.deleteOne({ _id: media._id, productId: product._id, storeId: store._id }, { session });
    await compactMedia(product, session); await quality(product, session);
    return saveProduct(request, product, store, session, 'catalogue.media_removed', { mediaPublicId: media.publicId });
  });
  await deleteUnreferencedMedia(retiredKeys);
  return result;
}

export async function reorderSellerProductImages(request) {
  const version = revision.parse(request.body.version), ordered = z.array(id).min(1).max(SELLER_PRODUCT_LIMITS.media).parse(request.body.mediaPublicIds);
  if (new Set(ordered).size !== ordered.length) throw new AppError('Each image must appear exactly once.', 422, 'MEDIA_ORDER_INVALID');
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version, states: editable });
    const media = await ProductMedia.find({ productId: product._id, storeId: store._id }).limit(SELLER_PRODUCT_LIMITS.media + 1).session(session);
    if (media.length !== ordered.length || media.some(row => !ordered.includes(row.publicId))) throw new AppError('The image order must contain every current product image.', 422, 'MEDIA_ORDER_INVALID');
    const byId = new Map(media.map(row => [row.publicId, row]));
    for (const [position, mediaId] of ordered.entries()) { const row = byId.get(mediaId); row.position = position; await row.save({ session }); }
    return saveProduct(request, product, store, session, 'catalogue.media_reordered');
  });
}

async function notifyOwner(store, product, session) {
  const title = `Product ${product.status}`;
  await Notification.create([{ publicId: publicId('ntf'), userId: store.ownerUserId, country: store.country, type: 'catalogue.product',
    title, body: `${product.title} is ${product.status}. Open your product to view details and next steps.`, href: `/seller/products/${product.publicId}`, importance: 'normal' }], { session });
  const owner = await User.findById(store.ownerUserId).select('email emailVerifiedAt').session(session);
  if (owner?.emailVerifiedAt) await addOutboxEvent({ type: 'catalogue.product_notification', aggregateType: 'product', aggregatePublicId: product.publicId,
    payload: { email: owner.email, subject: title, body: `Your product is ${product.status}. Sign in to Classic Mart to view its status and next steps.` } }, session);
}

export async function assertSellerProductComplete(product, store, session, { mediaStatus = ['ready'], requireStock = true } = {}) {
  if (store.status !== 'verified') throw new AppError('Complete seller verification before submitting or publishing products.', 409, 'STORE_NOT_VERIFIED');
  const category = await Category.findOne({ _id: product.categoryId, ...categoryCountryScope(store) }).session(session);
  if (!category) throw new AppError('Category is unavailable in your store country.', 422, 'CATEGORY_UNAVAILABLE');
  if (product.brandId && !await Brand.exists({ _id: product.brandId, status: 'approved' }).session(session)) throw new AppError('The selected brand is unavailable.', 422, 'BRAND_UNAVAILABLE');
  if (product.countries.length !== 1 || product.countries[0] !== store.country) throw new AppError('This product must use its store country.', 422, 'PRODUCT_COUNTRY_INVALID');
  attributesFor(category, { attributes: Object.fromEntries(product.attributes || []) }, { required: true });
  inspectProductContent(product.toObject());
  const variants = await ProductVariant.find({ productId: product._id, storeId: store._id, active: true }).limit(SELLER_PRODUCT_LIMITS.variants + 1).session(session);
  if (!variants.length || variants.length > SELLER_PRODUCT_LIMITS.variants || variants.some(row => row.currency !== store.currency || !Number.isSafeInteger(row.priceMinor) || row.priceMinor <= 0 || row.priceMinor > 2_000_000_000 || (row.compareAtMinor !== undefined && (!Number.isSafeInteger(row.compareAtMinor) || row.compareAtMinor < row.priceMinor)))) throw new AppError('Add valid active variants priced in your store currency.', 422, 'VARIANT_REQUIRED');
  const media = await ProductMedia.find({ productId: product._id, storeId: store._id }).limit(SELLER_PRODUCT_LIMITS.media + 1).session(session);
  if (media.length < SELLER_PRODUCT_LIMITS.minimumMedia || media.length > SELLER_PRODUCT_LIMITS.media || media.some(row => !mediaStatus.includes(row.status) || row.altText.length < 3)) throw new AppError(`Add ${SELLER_PRODUCT_LIMITS.minimumMedia}–${SELLER_PRODUCT_LIMITS.media} ${mediaStatus.length === 1 && mediaStatus[0] === 'approved' ? 'approved' : 'valid'} product images with descriptions.`, 422, 'MEDIA_REQUIRED');
  const available = await StockItem.aggregate([
    { $match: { storeId: store._id, variantId: { $in: variants.map(row => row._id) } } },
    { $lookup: { from: Warehouse.collection.name, localField: 'warehouseId', foreignField: '_id', as: 'warehouse' } },
    { $unwind: '$warehouse' }, { $match: { 'warehouse.storeId': store._id, 'warehouse.country': store.country, 'warehouse.active': true } },
    { $group: { _id: null, available: { $sum: { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] } } } },
  ]).session(session);
  if (requireStock && !(available[0]?.available > 0)) throw new AppError('Add available stock to an active warehouse in your store country.', 422, 'STOCK_REQUIRED');
  product.qualityScore = calculateQualityScore({ ...product.toObject(), variantCount: variants.length, mediaCount: media.length, hasBrand: Boolean(product.brandId) });
  if (product.qualityScore < SELLER_PRODUCT_LIMITS.quality) throw new AppError('Improve the product details until quality reaches at least 45%.', 422, 'QUALITY_TOO_LOW');
  return category;
}

export async function transitionSellerProduct(request, action) {
  const version = revision.parse(request.body.version);
  if (!['submit', 'publish', 'archive', 'draft'].includes(action)) throw new AppError('Product action is invalid.', 422, 'PRODUCT_ACTION_INVALID');
  return transaction(async session => {
    const { product, store } = await ownedProduct(request, session, { version });
    if (action === 'submit') {
      if (!editable.has(product.status)) throw new AppError('The product cannot be submitted in its current state.', 409, 'PRODUCT_LOCKED');
      const category = await assertSellerProductComplete(product, store, session);
      product.status = 'submitted'; product.moderation = { submittedAt: new Date(), riskLevel: category.restricted ? 'high' : 'standard',
        secondReviewRequired: Boolean(category.restricted), reviewHistory: product.moderation?.reviewHistory?.slice(-200) || [] };
    } else if (action === 'publish') {
      if (product.status !== 'approved') throw new AppError('Only an independently approved product can be published.', 409, 'PRODUCT_NOT_APPROVED');
      const category = await assertSellerProductComplete(product, store, session, { mediaStatus: ['approved'] });
      if (!hasPublicProductApproval(product, category, store)) throw new AppError('This product requires approval from two independent reviewers.', 409, 'SECOND_REVIEW_REQUIRED');
      product.status = 'published'; product.publishedAt = new Date(); product.archivedAt = undefined;
    } else if (action === 'archive') {
      if (!stockStates.has(product.status)) throw new AppError('The product cannot be archived in its current state.', 409, 'PRODUCT_LOCKED');
      product.status = 'archived'; product.archivedAt = new Date();
      product.moderation.assignedUserId = null; product.moderation.assignedAt = undefined;
    } else {
      if (!['submitted', 'approved', 'published', 'archived'].includes(product.status)) throw new AppError('The product cannot be returned to draft in its current state.', 409, 'PRODUCT_LOCKED');
      product.status = 'draft'; product.publishedAt = undefined; product.archivedAt = undefined;
      product.moderation = { reviewHistory: product.moderation?.reviewHistory?.slice(-200) || [] };
      await ProductMedia.updateMany({ productId: product._id, storeId: store._id }, { $set: { status: 'ready', moderationReason: '' }, $unset: { reviewedAt: 1, reviewedByUserId: 1 } }, { session });
      await quality(product, session);
    }
    await saveProduct(request, product, store, session, `catalogue.product_${product.status}`);
    await notifyOwner(store, product, session);
    return product;
  });
}

export async function readableSellerProductImage(user, imageId) {
  const media = await ProductMedia.findOne({ publicId: id.parse(imageId) }).select('+storageKey +thumbnailStorageKey');
  if (!media) throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
  const product = await Product.findOne({ _id: media.productId, storeId: media.storeId });
  const store = product ? await Store.findById(product.storeId).select('country status ownerUserId currency') : null;
  if (!product || !store) throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
  const category = await Category.findOne({ _id: product.categoryId, ...categoryCountryScope(store) }).select('restricted');
  const brand = product.brandId ? await Brand.exists({ _id: product.brandId, status: 'approved' }) : true;
  const isPublic = media.status === 'approved' && product.status === 'published' && store.status === 'verified' && Boolean(category) && Boolean(brand) && hasPublicProductApproval(product, category, store) && product.countries.includes(store.country);
  if (!isPublic) {
    if (!user || !await User.exists({ _id: user._id, status: 'active', 'security.tokenVersion': user.security?.tokenVersion ?? -1 })) throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
    if (env.security.privilegedMfaRequired && !user.security?.mfaEnabled) throw new AppError('Authenticator enrollment is required to preview unpublished product images.', 403, 'MFA_ENROLLMENT_REQUIRED');
    if (hasPermission(user, 'catalogue:moderate')) assertOperationalCountry(user, store.country, 'Image not found.');
    else {
      if (!['pending_verification', 'verified'].includes(store.status)) throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
      const member = await StoreMember.findOne({ storeId: store._id, userId: user._id, status: 'active' }).select('role');
      if (!can(storeCapabilities(member?.role), 'catalogue')) throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
    }
  }
  return { media, product, isPublic };
}
