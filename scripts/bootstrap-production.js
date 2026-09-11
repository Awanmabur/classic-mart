import crypto from 'node:crypto';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { hashPassword, normalizeEmail, normalizePhone } from '../src/core/crypto.js';
import { assertStrongPassword } from '../src/services/auth.js';
import { Category, CountrySetting, PlatformGrant, User } from '../src/models/index.js';
import * as allModels from '../src/models/index.js';
import { ensureModelIndexes, reconcileExpiryIndexes, ttlIndexEntriesForModels } from '../src/core/indexes.js';
import { marketplaceCategories, supportedCountries } from '../src/config/marketplace-reference.js';

if (process.env.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production for production bootstrap.');

async function ensureProductionSuperAdminGrant(user) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 365 * 86_400_000);
  await PlatformGrant.updateMany({ userId: user._id, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired', statusReason: 'Production bootstrap grant expired before renewal.' } });
  let grant = await PlatformGrant.findOne({ userId: user._id, status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } });
  if (!grant) grant = await PlatformGrant.create({ publicId: `pgr_bootstrap_${user.publicId}`, userId: user._id, role: 'super_admin', operationalCountries: ['*'], warehouseScopes: [], capabilities: [], startsAt: now, expiresAt, status: 'active', reason: 'Production bootstrap Super Admin access. Rotate or reapprove before expiry.', approvalPublicId: 'production-bootstrap-super-admin', approvedByUserId: user._id });
  user.platformAccessManagedAt = user.platformAccessManagedAt || now;
  user.role = 'super_admin';
  user.operationalCountries = ['*'];
  await user.save();
  return grant;
}

async function bootstrap() {
  if (!env.admin.email) throw new Error('ADMIN_EMAIL is required for production bootstrap.');
  await connectDatabase({ autoIndex: false });
  const indexModels = [...new Set(Object.values(allModels).filter((model) => model?.createIndexes))];
  await reconcileExpiryIndexes(ttlIndexEntriesForModels(indexModels), logger);
  await ensureModelIndexes(indexModels, logger);

  const allowed = new Map(supportedCountries.map((country) => [country.code, country]));
  for (const code of env.security.launchCountries) {
    const country = allowed.get(code);
    if (!country) throw new Error(`Unsupported LAUNCH_COUNTRIES entry: ${code}`);
    await CountrySetting.updateOne({ code }, { $set: { ...country, active: true }, $setOnInsert: { 'growth.promoterCommissionBps': 300 } }, { upsert: true, runValidators: true });
  }

  const emailNormalized = normalizeEmail(env.admin.email);
  let admin = await User.findOne({ emailNormalized }).select('+operationalCountries +passwordHash');
  let adminCreated = false;
  if (!admin) {
    if (!env.admin.phone || !env.admin.password) throw new Error('ADMIN_PHONE and ADMIN_PASSWORD are required when creating the first production Super Admin.');
    assertStrongPassword(env.admin.password);
    const phoneNormalized = normalizePhone(env.admin.phone);
    admin = await User.create({ publicId: `usr_${crypto.randomUUID().replaceAll('-', '')}`, name: env.admin.name, email: env.admin.email, emailNormalized, phone: env.admin.phone, phoneNormalized, passwordHash: await hashPassword(env.admin.password), role: 'super_admin', status: 'active', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(), country: env.security.launchCountries[0], shoppingCountry: env.security.launchCountries[0], currency: allowed.get(env.security.launchCountries[0]).currency, locale: allowed.get(env.security.launchCountries[0]).locale, timeZone: allowed.get(env.security.launchCountries[0]).timeZone, consents: { terms: true, privacy: true, marketing: false, recordedAt: new Date(), policyVersion: '2026-07' }, roleProfile: { publicName: env.admin.name, businessName: 'Classic Mart', focus: 'Platform administration' }, operationalCountries: ['*'], platformAccessManagedAt: new Date() });
    adminCreated = true;
  }
  await ensureProductionSuperAdminGrant(admin);

  for (const category of marketplaceCategories) {
    await Category.updateOne({ slug: category.key }, { $set: { name: category.name, description: category.description, active: true, restricted: false, countries: [], attributes: category.attributes }, $setOnInsert: { publicId: `cat_${category.key.replaceAll('-', '_')}`, createdByUserId: admin._id } }, { upsert: true, runValidators: true });
  }

  logger.info({ adminEmail: env.admin.email, launchCountries: env.security.launchCountries, categories: marketplaceCategories.length }, 'Classic Mart production bootstrap completed');
  console.log(adminCreated ? 'Production bootstrap complete. Remove ADMIN_PASSWORD from runtime environment after verifying Super Admin login.' : 'Production bootstrap refreshed existing Super Admin access, indexes, countries and categories.');
}

bootstrap().then(disconnectDatabase).catch(async (error) => { logger.fatal({ err: error }, 'Production bootstrap failed'); await disconnectDatabase().catch(() => {}); process.exit(1); });
