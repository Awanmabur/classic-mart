import crypto from 'node:crypto';
import sharp from 'sharp';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { normalizeEmail, normalizePhone, hashPassword } from '../src/core/crypto.js';
import { assertStrongPassword } from '../src/services/auth.js';
import { ensureModelIndexes, reconcileExpiryIndexes, ttlIndexEntriesForModels } from '../src/core/indexes.js';
import * as allModels from '../src/models/index.js';
import {
  Brand,
  Category,
  CountrySetting,
  InventoryMovement,
  PlatformGrant,
  Product,
  ProductMedia,
  ProductVariant,
  ShippingZone,
  PickupPoint,
  StockItem,
  Store,
  User,
  Warehouse,
} from '../src/models/index.js';
import { marketplaceCategories, supportedCountries } from '../src/config/marketplace-reference.js';
import { initialBrands, initialMediaSources, initialProducts } from '../src/config/initial-catalogue.js';
import { deleteMediaObject, ensureMediaStorageReady, putMediaObject } from '../src/services/object-storage.js';
import { toMinorUnits } from '../src/services/catalogue.js';

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const SOURCE_HOST = 'images.pexels.com';
const sourceMap = new Map(initialMediaSources.map(([name, url, attribution]) => [name, { url, attribution }]));

function databaseNameFromUri(uri) {
  try {
    const parsed = new URL(uri);
    return decodeURIComponent(String(parsed.pathname || '').replace(/^\//, '').split('/')[0] || '');
  } catch {
    return '';
  }
}

function assertSafeTarget() {
  const confirmation = String(process.env.INITIAL_CATALOGUE_CONFIRM || '').trim();
  if (confirmation !== 'SEED_REAL_CLASSIC_MART') {
    throw new Error('INITIAL_CATALOGUE_CONFIRM=SEED_REAL_CLASSIC_MART is required for the one-time real catalogue import.');
  }
  if (String(process.env.MONGO_MODE || '').trim().toLowerCase() !== 'external') {
    throw new Error('Initial catalogue import requires MONGO_MODE=external so it never starts or rewrites a local MongoDB.');
  }
  if (String(process.env.MEDIA_STORAGE_DRIVER || '').trim().toLowerCase() !== 'r2') {
    throw new Error('Initial catalogue import requires MEDIA_STORAGE_DRIVER=r2 so product media is stored in Cloudflare R2.');
  }
  const name = databaseNameFromUri(env.mongoUri);
  if (!name) {
    throw new Error('An explicit MongoDB database name is required in MONGO_URI before importing the initial catalogue.');
  }
  if (!env.admin.email || !env.admin.phone) {
    throw new Error('ADMIN_EMAIL and ADMIN_PHONE are required for initial catalogue setup.');
  }
}

async function ensureInitialAdmin() {
  const emailNormalized = normalizeEmail(env.admin.email);
  let admin = await User.findOne({ emailNormalized }).select('+operationalCountries +passwordHash');
  if (!admin) {
    if (!env.admin.password) throw new Error('ADMIN_PASSWORD is required when creating the first Super Admin.');
    assertStrongPassword(env.admin.password);
    const primaryCountry = supportedCountries.find((country) => country.code === 'UG') || supportedCountries[0];
    admin = await User.create({
      publicId: `usr_${crypto.randomUUID().replaceAll('-', '')}`,
      name: env.admin.name,
      email: env.admin.email,
      emailNormalized,
      phone: env.admin.phone,
      phoneNormalized: normalizePhone(env.admin.phone),
      passwordHash: await hashPassword(env.admin.password),
      role: 'super_admin',
      status: 'active',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(),
      country: primaryCountry.code,
      shoppingCountry: primaryCountry.code,
      currency: primaryCountry.currency,
      locale: primaryCountry.locale,
      timeZone: primaryCountry.timeZone,
      operationalCountries: ['*'],
      platformAccessManagedAt: new Date(),
      consents: { terms: true, privacy: true, marketing: false, recordedAt: new Date(), policyVersion: '2026-07' },
      roleProfile: { publicName: env.admin.name, businessName: 'Classic Mart', focus: 'Platform administration' },
    });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 365 * 86_400_000);
  await PlatformGrant.updateMany({ userId: admin._id, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired', statusReason: 'Expired before initial catalogue refresh.' } });
  const activeGrant = await PlatformGrant.findOne({ userId: admin._id, status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } });
  if (!activeGrant) {
    await PlatformGrant.create({
      publicId: `pgr_catalog_${admin.publicId}`,
      userId: admin._id,
      role: 'super_admin',
      operationalCountries: ['*'],
      warehouseScopes: [],
      capabilities: [],
      startsAt: now,
      expiresAt,
      status: 'active',
      reason: 'Initial Classic Mart catalogue administration.',
      approvalPublicId: 'initial-catalogue-super-admin',
      approvedByUserId: admin._id,
    });
  }
  admin.role = 'super_admin';
  admin.operationalCountries = ['*'];
  admin.platformAccessManagedAt = admin.platformAccessManagedAt || now;
  await admin.save();
  return admin;
}

async function fetchInitialImage(name) {
  const source = sourceMap.get(name);
  if (!source) throw new Error(`No approved initial catalogue image source configured for ${name}.`);
  const parsed = new URL(source.url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== SOURCE_HOST) throw new Error(`Unapproved initial catalogue image host for ${name}.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  timer.unref?.();
  try {
    const response = await fetch(source.url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'Classic-Mart-Initial-Catalogue/2.13.49' } });
    if (!response.ok) throw new Error(`Initial catalogue image ${name} returned HTTP ${response.status}.`);
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== SOURCE_HOST) throw new Error(`Initial catalogue image ${name} redirected to an unapproved host.`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/jpeg')) throw new Error(`Initial catalogue image ${name} returned unexpected content type ${contentType || 'unknown'}.`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > MAX_SOURCE_BYTES) throw new Error(`Initial catalogue image ${name} exceeds ${MAX_SOURCE_BYTES} bytes.`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 10_000 || body.length > MAX_SOURCE_BYTES) throw new Error(`Initial catalogue image ${name} has unexpected size ${body.length}.`);
    return { body, attribution: source.attribution };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadInitialImage(product, item, photoName, position) {
  const source = await fetchInitialImage(photoName);
  const main = await sharp(source.body)
    .rotate()
    .resize(1000, 1000, { fit: 'cover', position: 'attention' })
    .webp({ quality: 88, effort: 5 })
    .toBuffer();
  const thumb = await sharp(source.body)
    .rotate()
    .resize(420, 420, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82, effort: 5 })
    .toBuffer();
  const storageKey = `catalogue/${product.publicId}/image-${position + 1}.webp`;
  const thumbnailStorageKey = `catalogue/${product.publicId}/image-${position + 1}-thumb.webp`;
  await putMediaObject(storageKey, main, { contentType: 'image/webp', cacheControl: 'private, max-age=31536000, immutable' });
  await putMediaObject(thumbnailStorageKey, thumb, { contentType: 'image/webp', cacheControl: 'private, max-age=31536000, immutable' });
  const metadata = await sharp(main).metadata();
  return {
    storageKey,
    thumbnailStorageKey,
    originalName: photoName,
    sizeBytes: main.length,
    width: metadata.width || 1000,
    height: metadata.height || 1000,
    checksumSha256: crypto.createHash('sha256').update(main).digest('hex'),
    attribution: source.attribution,
  };
}

async function upsertFoundation(admin) {
  for (const country of supportedCountries) {
    await CountrySetting.updateOne(
      { code: country.code },
      { $set: { ...country, active: true }, $setOnInsert: { 'growth.promoterCommissionBps': 300 } },
      { upsert: true, runValidators: true },
    );
  }

  const categoryDocuments = new Map();
  for (const category of marketplaceCategories) {
    const document = await Category.findOneAndUpdate(
      { slug: category.key },
      { $set: { name: category.name, description: category.description, active: true, restricted: false, countries: [], attributes: category.attributes }, $setOnInsert: { publicId: `cat_${category.key.replaceAll('-', '_')}`, createdByUserId: admin._id } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    );
    categoryDocuments.set(category.key, document);
  }

  const brandDocuments = new Map();
  for (const name of initialBrands) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const document = await Brand.findOneAndUpdate(
      { slug },
      { $set: { name, status: 'approved', reviewedByUserId: admin._id }, $setOnInsert: { publicId: `brd_${slug}` } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    );
    brandDocuments.set(name, document);
  }

  await ShippingZone.updateOne(
    { publicId: 'shz_ug_main' },
    { $set: { publicId: 'shz_ug_main', country: 'UG', currency: 'UGX', name: 'Uganda delivery', cities: ['Kampala', 'Entebbe', 'Wakiso'], standardFeeMinor: 12000, expressFeeMinor: 25000, standardSlaHours: 120, expressSlaHours: 48, active: true } },
    { upsert: true, runValidators: true },
  );
  await PickupPoint.updateOne(
    { publicId: 'pup_kampala_main' },
    { $set: { publicId: 'pup_kampala_main', country: 'UG', name: 'Classic Mart Kampala Pickup', city: 'Kampala', address: 'Kampala, Uganda', openingHours: 'Mon-Sat 08:00-18:00', active: true } },
    { upsert: true, runValidators: true },
  );

  return { categoryDocuments, brandDocuments };
}

async function seedInitialCatalogue() {
  assertSafeTarget();
  await ensureMediaStorageReady();
  await connectDatabase({ autoIndex: false });
  const indexModels = [...new Set(Object.values(allModels).filter((model) => model?.createIndexes))];
  await reconcileExpiryIndexes(ttlIndexEntriesForModels(indexModels), logger);
  await ensureModelIndexes(indexModels, logger);

  const admin = await ensureInitialAdmin();
  const { categoryDocuments, brandDocuments } = await upsertFoundation(admin);

  const store = await Store.findOneAndUpdate(
    { publicId: 'str_classic_mart' },
    { $set: { ownerUserId: admin._id, name: 'Classic Mart', slug: 'classic-mart', description: 'Official Classic Mart marketplace catalogue.', country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
  const warehouse = await Warehouse.findOneAndUpdate(
    { publicId: 'whs_kampala_main' },
    { $set: { publicId: 'whs_kampala_main', storeId: store._id, ownerUserId: admin._id, name: 'Kampala Main Warehouse', country: 'UG', city: 'Kampala', address: 'Kampala, Uganda', active: true } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );

  let uploadedImages = 0;
  for (const item of initialProducts) {
    const product = await Product.findOneAndUpdate(
      { publicId: `prd_catalog_${item.key.replaceAll('-', '_')}` },
      {
        $set: {
          ownerUserId: admin._id,
          storeId: store._id,
          slug: item.key,
          categoryId: categoryDocuments.get(item.category)._id,
          brandId: brandDocuments.get(item.brand)._id,
          title: item.title,
          description: item.description,
          countries: supportedCountries.map((country) => country.code),
          tags: item.tags,
          attributes: item.attributes || {},
          status: 'published',
          qualityScore: 90,
          publishedAt: new Date(),
          'moderation.submittedAt': new Date(),
          'moderation.reviewedAt': new Date(),
          'moderation.reviewedByUserId': admin._id,
          'moderation.reason': 'Initial Classic Mart catalogue import.',
        },
        $setOnInsert: { publicId: `prd_catalog_${item.key.replaceAll('-', '_')}` },
      },
      { upsert: true, returnDocument: 'after', runValidators: true },
    );
    const variant = await ProductVariant.findOneAndUpdate(
      { publicId: `var_catalog_${item.key.replaceAll('-', '_')}` },
      {
        $set: { storeId: store._id, productId: product._id, title: 'Default', sku: item.sku, priceMinor: toMinorUnits(item.price, 'UGX'), compareAtMinor: toMinorUnits(String(Math.ceil(Number(item.price) * 1.15)), 'UGX'), currency: 'UGX', active: true, weightGrams: item.weightGrams || 0, barcode: item.barcode || '' },
        $setOnInsert: { publicId: `var_catalog_${item.key.replaceAll('-', '_')}` },
      },
      { upsert: true, returnDocument: 'after', runValidators: true },
    );

    const photos = (item.photos || []).slice(0, 3);
    for (let position = 0; position < photos.length; position += 1) {
      const image = await uploadInitialImage(product, item, photos[position], position);
      await ProductMedia.findOneAndUpdate(
        { publicId: `med_catalog_${item.key.replaceAll('-', '_')}_${position + 1}` },
        {
          $set: { productId: product._id, storeId: store._id, source: 'seed_asset', position, storageKey: image.storageKey, thumbnailStorageKey: image.thumbnailStorageKey, originalName: image.originalName, mimeType: 'image/webp', sizeBytes: image.sizeBytes, width: image.width, height: image.height, checksumSha256: image.checksumSha256, altText: `${item.title} — view ${position + 1}`, status: 'approved', reviewedByUserId: admin._id, reviewedAt: new Date() },
          $setOnInsert: { publicId: `med_catalog_${item.key.replaceAll('-', '_')}_${position + 1}` },
        },
        { upsert: true, returnDocument: 'after', runValidators: true },
      );
      uploadedImages += 1;
    }

    const stale = await ProductMedia.find({ productId: product._id, publicId: /^med_catalog_/, position: { $gte: photos.length } }).select('+storageKey +thumbnailStorageKey');
    for (const media of stale) {
      await Promise.all([deleteMediaObject(media.storageKey), media.thumbnailStorageKey ? deleteMediaObject(media.thumbnailStorageKey) : Promise.resolve()]);
      await media.deleteOne();
    }

    const stock = await StockItem.findOneAndUpdate(
      { publicId: `stk_catalog_${item.key.replaceAll('-', '_')}` },
      { $set: { publicId: `stk_catalog_${item.key.replaceAll('-', '_')}`, storeId: store._id, warehouseId: warehouse._id, variantId: variant._id, onHand: item.stock, reserved: 0, reorderPoint: 8 } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    );
    if (!(await InventoryMovement.exists({ stockItemId: stock._id, reference: 'initial_catalogue_import' }))) {
      await InventoryMovement.create({
        publicId: `mov_catalog_${item.key.replaceAll('-', '_')}`,
        storeId: store._id,
        stockItemId: stock._id,
        variantId: variant._id,
        warehouseId: warehouse._id,
        type: 'receipt',
        quantity: item.stock,
        onHandBefore: 0,
        onHandAfter: item.stock,
        reservedBefore: 0,
        reservedAfter: 0,
        reason: 'Initial catalogue inventory',
        reference: 'initial_catalogue_import',
        actorUserId: admin._id,
      });
    }
  }

  logger.info({ database: databaseNameFromUri(env.mongoUri), products: initialProducts.length, mediaUploaded: uploadedImages, bucket: env.r2.bucket }, 'Classic Mart initial catalogue import completed');
  console.log(`Initial catalogue ready — products=${initialProducts.length}, images=${uploadedImages}, storage=Cloudflare R2.`);
}

seedInitialCatalogue()
  .then(disconnectDatabase)
  .catch(async (error) => {
    logger.error({ err: error }, 'Initial catalogue import failed');
    await disconnectDatabase().catch(() => {});
    process.exitCode = 1;
  });
