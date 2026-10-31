import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

function fixtureUri(value) {
  assert.equal(process.env.NODE_ENV, 'test', 'Browser accounts may only be created in NODE_ENV=test.');
  const uri = new URL(value || '');
  assert.equal(uri.protocol, 'mongodb:', 'Browser fixtures require a loopback MongoDB replica set.');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname), 'Browser fixtures require a loopback MongoDB host.');
  assert.match(uri.pathname, /^\/(?:classic_mart_ci|classicmart_(?:browser|accessibility_final)_test_[a-f0-9]{8,64})$/,
    'Use the isolated CI database or a newly named classicmart_browser_test_<random hex> database.');
  assert.ok(uri.searchParams.get('replicaSet'), 'Browser fixtures require an explicit replicaSet.');
  return uri.href;
}

async function credentialOutput(credentialFile, githubEnv) {
  assert.ok(!credentialFile || !githubEnv, 'Choose a private credential file or the GitHub environment file.');
  if (githubEnv) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GITHUB_ENV output is available only in GitHub Actions.');
    assert.equal(process.env.CI, 'true', 'GITHUB_ENV output requires the CI runner.');
    const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP || '');
    const target = await fs.realpath(githubEnv);
    assert.ok(target.startsWith(runnerTemp + path.sep), 'GITHUB_ENV must belong to the current runner temporary directory.');
    assert.match(path.basename(target), /^set_env_[A-Za-z0-9_-]+$/, 'Use the GitHub runner environment-command file.');
    assert.ok((await fs.stat(target)).isFile(), 'GITHUB_ENV must be a regular file.');
    return { async save(credentials) {
      const lines = Object.entries(credentials).map(([key, value]) => {
        assert.match(key, /^E2E_(?:SELLER|MODERATOR)_(?:EMAIL|PASSWORD|MFA_RECOVERY_CODES)$/);
        assert.ok(typeof value === 'string' && value && !/[\r\n]/.test(value), 'Browser credentials must be nonempty single-line values.');
        const secrets = key.endsWith('_MFA_RECOVERY_CODES') ? [value, ...value.split(',')] : [value];
        for (const secret of new Set(secrets)) {
          const masked = secret.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
          process.stdout.write(`::add-mask::${masked}\n`);
        }
        return `${key}=${value}\n`;
      });
      await fs.appendFile(target, lines.join(''), { flag: 'a' });
    }, async close() {}, summary: { githubEnvironment: true } };
  }

  const target = credentialFile || path.join(os.tmpdir(), `classicmart-browser-accounts-${crypto.randomBytes(8).toString('hex')}.json`);
  assert.ok(path.isAbsolute(target), 'Browser credential output must be an absolute temporary-file path.');
  assert.equal(await fs.realpath(path.dirname(target)), await fs.realpath(os.tmpdir()), 'Write browser credentials directly into the system temporary directory.');
  assert.match(path.basename(target), /^classicmart-browser-accounts-[a-f0-9]{8,64}\.json$/);
  const handle = await fs.open(target, 'wx', 0o600);
  let saved = false;
  return { async save(credentials) {
    await handle.writeFile(JSON.stringify(credentials) + '\n');
    saved = true;
  }, async close() {
    await handle.close();
    if (!saved) await fs.unlink(target);
  }, summary: { credentialFile: target } };
}

/** Synthetic role fixtures only; the actual browser login creates each Device. */
export async function seedBrowserAccounts({ uri = process.env.MONGO_URI, credentialFile,
  githubEnv = credentialFile ? undefined : process.env.GITHUB_ENV } = {}) {
  const databaseUri = fixtureUri(uri);
  assert.equal(mongoose.connection.readyState, 0, 'Run the browser-account seeder with its own database connection.');
  const output = await credentialOutput(credentialFile, githubEnv);
  try {
    const { env } = await import('../src/config/env.js');
    assert.equal(env.auth.simpleLogin, false, 'Browser account verification requires SIMPLE_LOGIN=false.');
    assert.equal(env.security.privilegedMfaRequired, true, 'Browser account verification requires privileged MFA.');
    await mongoose.connect(databaseUri);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName && hello.isWritablePrimary, 'Wait for the test replica-set primary before seeding browser accounts.');
    const models = await import('../src/models/index.js');
    const { User, PlatformGrant, CountrySetting, Category, Product, ProductVariant } = models;
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    assert.ok(await CountrySetting.exists({ code: 'UG', currency: 'UGX', active: true }), 'Run scripts/seed.js first to create the published test catalogue and active market.');
    const now = new Date();
    const reviewer = await User.findOne({ role: 'super_admin', status: 'active', platformAccessManagedAt: { $type: 'date' } });
    assert.ok(reviewer && await PlatformGrant.exists({ userId: reviewer._id, role: 'super_admin', status: 'active',
      startsAt: { $lte: now }, expiresAt: { $gt: now } }), 'The test seed must supply a current independent Super Admin grant.');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { getOrCreateStore } = await import('../src/services/store.js');
    const suffix = crypto.randomBytes(8).toString('hex'), credentials = {};
    let seller;
    for (const role of ['seller', 'moderator']) {
      const email = `browser-${role}-${suffix}@example.com`;
      const password = 'Browser-' + crypto.randomBytes(24).toString('base64url') + '!9a';
      const phone = '+2567' + crypto.randomInt(10_000_000, 100_000_000);
      const user = await User.create({ publicId: `usr_browser_${role}_${suffix}`, name: `Browser ${role}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash: await hashPassword(password), role: role === 'moderator' ? 'customer' : role,
        country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() },
        ...(role === 'moderator' ? { platformAccessManagedAt: new Date(), operationalCountries: ['UG'] } : {}) });
      if (role === 'moderator') await PlatformGrant.create({ publicId: `pgr_browser_${suffix}`, userId: user._id, role,
        operationalCountries: ['UG'], startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000), status: 'active',
        approvalPublicId: `apr_browser_${suffix}`, approvedByUserId: reviewer._id, reason: 'Independent isolated browser fixture grant.' });
      const enrollment = await beginMfaEnrollment(user._id, password);
      const enabled = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
      assert.equal(enabled.user.security.mfaEnabled, true);
      assert.ok(enabled.codes.length >= 4, 'Desktop/mobile retries need distinct unused recovery codes.');
      const prefix = 'E2E_' + role.toUpperCase();
      credentials[prefix + '_EMAIL'] = email;
      credentials[prefix + '_PASSWORD'] = password;
      credentials[prefix + '_MFA_RECOVERY_CODES'] = enabled.codes.join(',');
      if (role === 'seller') seller = enabled.user;
    }
    const { store } = await getOrCreateStore(seller);
    const category = await Category.create({ publicId: `cat_browser_${suffix}`, name: 'Browser owned products',
      slug: `browser-owned-${suffix}`, active: true, countries: ['UG'] });
    const product = await Product.create({ publicId: `prd_browser_${suffix}`, storeId: store._id, ownerUserId: seller._id,
      categoryId: category._id, title: 'Browser owned Seller product', slug: `browser-owned-${suffix}`,
      description: 'Owned product for actual Seller phone cards.', countries: ['UG'], status: 'draft' });
    await ProductVariant.create({ publicId: `var_browser_${suffix}`, productId: product._id, storeId: store._id,
      sku: 'BROWSER-' + suffix, title: 'Default', priceMinor: 25000, currency: 'UGX' });
    await output.save(credentials);
    return { seeded: ['seller', 'moderator'], ...output.summary };
  } finally {
    await mongoose.disconnect();
    await output.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/seed-browser-accounts.js [temporary credential JSON path]');
  try { console.log(JSON.stringify(await seedBrowserAccounts({ credentialFile: process.argv[2] }))); }
  catch (error) {
    console.error(error?.code === 'ERR_ASSERTION' ? error.message : 'Browser fixture setup failed. Check the isolated test database and credential output settings.');
    process.exitCode = 1;
  }
}
