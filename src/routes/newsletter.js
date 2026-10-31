import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { z } from 'zod';
import { publicId } from '../core/ids.js';
import { encryptSensitive } from '../core/sensitive.js';
import { NewsletterSubscription, User } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { fenceOptionalProcessing, optionalProcessingUser } from '../services/optional-processing.js';
import { currentCustomerAccess } from '../services/customer-access.js';

const router = Router();
const subscribeLimit = rateLimit({ scope: 'newsletter:1', windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
const schema = z.object({ email: z.string().trim().email().max(254) });

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function emailHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

router.post('/api/v1/newsletter/subscribe', subscribeLimit, async (request, response, next) => {
  try {
    const input = schema.parse(request.body);
    const email = normalizeEmail(input.email);
    const hash = emailHash(email);
    const now = new Date();
    const session = await mongoose.startSession();
    try { await session.withTransaction(async () => {
      // Find the current identity even for anonymous subscriptions: submitting a
      // restricted account's email must not bypass its processing restriction.
      const existing = await User.findOne({ emailNormalized: email }).session(session);
      const sameAccount = request.user && normalizeEmail(request.user.email) === email;
      const allowed = !existing || await optionalProcessingUser(existing._id, { session });
      if (!allowed) {
        if (sameAccount) throw new AppError('Marketing is restricted by your privacy settings.', 403, 'PRIVACY_PROCESSING_RESTRICTED');
        return; // The generic reply does not expose whether an account exists.
      }
      const accountUser = sameAccount ? await currentCustomerAccess(request, { session, write: true }) : null;
      if (sameAccount && (!accountUser || accountUser.security.tokenVersion !== request.user.security?.tokenVersion)) throw new AppError('Your account or session changed. Sign in again.', 403, 'ACCOUNT_UNAVAILABLE');
      if (existing && !sameAccount) await fenceOptionalProcessing(existing._id, { session });
      if (accountUser) {
        accountUser.consents.marketing = true;
        accountUser.consents.recordedAt = now;
        await accountUser.save({ session });
      }
      await NewsletterSubscription.findOneAndUpdate(
      { emailHash: hash },
      {
        $set: {
          emailEncrypted: encryptSensitive(email),
          userId: accountUser?._id,
          country: request.country.code,
          status: 'active',
          source: accountUser ? 'account' : 'storefront',
          consentRecordedAt: now,
          lastSubscribedAt: now,
          lastUnsubscribedAt: null,
        },
        $setOnInsert: { publicId: publicId('nws') },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true, session },
    );
    }); } finally { await session.endSession(); }

    response.status(201).set('Cache-Control', 'no-store').json({ subscribed: true, message: 'You are subscribed to Classic Mart updates.' });
  } catch (error) { next(error); }
});

export default router;
