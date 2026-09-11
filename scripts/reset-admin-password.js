import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { hashPassword, normalizeEmail } from '../src/core/crypto.js';
import { Device, User } from '../src/models/index.js';
import { assertStrongPassword } from '../src/services/auth.js';

const confirmed = process.argv.includes('--yes');
if (!confirmed) {
  throw new Error('Re-run with `npm run admin:reset-password -- --yes` after reviewing the target account.');
}

const email = normalizeEmail(process.env.ADMIN_RESET_EMAIL || env.admin.email || 'admin@classicmart.local');
const suppliedPassword = String(process.env.ADMIN_RESET_PASSWORD || '');
const generatedPassword = !suppliedPassword && !env.isProduction
  ? `Cm!${crypto.randomBytes(18).toString('base64url')}9aA`
  : '';
const password = suppliedPassword || generatedPassword;

if (env.isProduction && !suppliedPassword) {
  throw new Error('ADMIN_RESET_PASSWORD is required in production; production recovery never generates or stores a default password.');
}
assertStrongPassword(password);

async function resetAdminPassword() {
  await connectDatabase({ autoIndex: false });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const user = await User.findOne({ emailNormalized: email })
        .select('+passwordHash +emailNormalized')
        .session(session);
      if (!user) throw new Error(`Super Admin account not found for ${email}.`);
      if (user.role !== 'super_admin') throw new Error(`Refusing password recovery because ${email} is not a Super Admin.`);
      if (user.status === 'deleted' || user.status === 'pending_deletion') {
        throw new Error(`Refusing password recovery because ${email} is not an active recoverable account.`);
      }

      user.passwordHash = await hashPassword(password);
      user.security.passwordChangedAt = new Date();
      user.security.tokenVersion = Number(user.security.tokenVersion || 0) + 1;
      user.security.failedLoginCount = 0;
      user.security.lockedUntil = undefined;
      await user.save({ session });

      await Device.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'admin_password_recovery' } },
        { session },
      );
    });
  } finally {
    await session.endSession();
    await disconnectDatabase().catch(() => {});
  }

  console.log('Super Admin password updated without deleting marketplace data.');
  console.log(`Email: ${email}`);
  if (generatedPassword) console.log(`New local password: ${generatedPassword}`);
  else console.log('New password: value supplied through ADMIN_RESET_PASSWORD.');
  console.log('Existing authenticated device sessions were revoked.');
}

resetAdminPassword().catch(async (error) => {
  console.error(error.message || error);
  await disconnectDatabase().catch(() => {});
  process.exitCode = 1;
});
